import { validateMediaRequest } from '../types/media-capabilities';
import type { ImageGenerationRequest, SpeechSynthesisRequest, MediaGenerationRequest, MediaGenerationResult, TokenUsage } from '../types';
import { RequestCancellation } from '../core/request-cancellation';
import { postMedia, type MediaHTTPConfig } from './http';
import { doubaoSpeech } from './doubao-speech';
import type { LLMLogSink } from '../types/provider';
import { downloadImage } from './image-download';
import { assertImageFormat } from './image-format';
import { requestUUID } from '../utils/uuid';
export interface LLMMediaClientConfig extends MediaHTTPConfig { timeoutMs?: number; logger?: LLMLogSink; adapterFactory?: import('./registry').MediaAdapterFactory }

export class LLMMediaClient {
    private readonly config: LLMMediaClientConfig;
    constructor(config: LLMMediaClientConfig) { this.config = { ...config, provider: structuredClone(config.provider) }; }
    async generate(request: MediaGenerationRequest): Promise<MediaGenerationResult> {
        const started = performance.now(), metadata = {requestId: requestUUID(), operation: request.operation, adapter: this.config.provider.media?.[request.operation]?.adapter};
        this.config.logger?.info('media.request.started', metadata);
        try {return await this.run(request, started, metadata);}
        catch (error) {
            const failure = error as {code?: unknown; remoteCode?: unknown; requestId?: unknown; statusCode?: unknown; stage?: unknown};
            this.config.logger?.error('media.request.failed', {...metadata, stage: failure?.stage === 'validation' ? 'validation' : failure?.code === 'MEDIA_HTTP' ? 'transport' : 'response', code: typeof failure?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ? failure.code : 'MEDIA_FAILED',
                ...(typeof failure?.remoteCode === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(failure.remoteCode) ? {remoteCode: failure.remoteCode} : {}),
                ...(typeof failure?.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(failure.requestId) ? {serverRequestId: failure.requestId} : {}),
                ...(typeof failure?.statusCode === 'number' ? {statusCode: failure.statusCode} : {}), durationMs: Math.round(performance.now() - started)});
            throw error;
        }
    }
    private async run(request: MediaGenerationRequest, started: number, metadata: {requestId: string}): Promise<MediaGenerationResult> {
        validateMediaRequest(this.config.provider, request);
        if (!this.config.apiKey?.trim() && this.config.provider.credentialMode !== 'host') throw new Error('Media operation requires API credentials');
        const timeout = this.config.timeoutMs ?? 120_000;
        if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Invalid media timeout');
        const cancellation = new RequestCancellation(this.config.provider.id, timeout, request.signal);
        try {
            const endpoint = this.config.provider.media![request.operation]!;
            const adapter = this.config.adapterFactory?.(endpoint.adapter);
            if (adapter && !adapter.operations.includes(request.operation)) throw new Error('Media adapter does not support this operation');
            if (!adapter && !['openai-images', 'volcengine-images', 'openai-speech', 'doubao-speech'].includes(endpoint.adapter)) throw new Error('Media adapter is not registered');
            const result = adapter ? await adapter.generate({ config: this.config, endpoint, request, signal: cancellation.controller.signal, requestId: metadata.requestId }) : request.operation === 'image.generate'
                ? await this.image(request, cancellation.controller.signal) : await this.speech(request, cancellation.controller.signal, metadata.requestId);
            cancellation.controller.signal.throwIfAborted();
            if (result.model !== request.model || result.assets.length !== (request.operation === 'image.generate' ? request.count ?? 1 : 1)
                || result.assets.some(asset => !(asset.data instanceof Uint8Array) || !asset.data.length || asset.data.length > 64 * 1024 * 1024))
                throw Object.assign(new Error('Invalid media adapter result'), { code: 'MEDIA_RESULT' });
            this.config.logger?.info('media.request.completed', {...metadata, count: result.assets.length, bytes: result.assets.reduce((sum, asset) => sum + asset.data.length, 0), durationMs: Math.round(performance.now() - started)});
            return result;
        } catch (error) { throw cancellation.error(error); } finally { cancellation.dispose(); }
    }
    private async image(request: ImageGenerationRequest, signal: AbortSignal): Promise<MediaGenerationResult> {
        const endpoint = this.config.provider.media!['image.generate']!;
        if (endpoint.outputFormatParameter === false && request.format !== 'png') throw new Error('Legacy image endpoint requires PNG');
        const native = endpoint.adapter === 'volcengine-images';
        if (native && (request.count ?? 1) !== 1) throw new Error('This image endpoint supports one output per request');
        const body = { model: request.model, prompt: request.prompt, size: request.size,
            ...(native ? { sequential_image_generation: 'disabled', stream: false } : { n: request.count ?? 1, quality: request.quality }),
            ...(endpoint.outputFormatParameter === false ? {} : { output_format: request.format }),
            ...((endpoint.responseFormat || native) ? { response_format: endpoint.responseFormat ?? 'b64_json' } : {}) };
        const response = await postMedia(this.config, endpoint, native ? '/api/v3/images/generations' : '/v1/images/generations', body, signal);
        const value = JSON.parse(new TextDecoder().decode(response.bytes));
        if (endpoint.responseFormat === 'url' && Array.isArray(value?.data)) {
            for (const item of value.data) if (typeof item?.url === 'string' && !item.b64_json) {
                const bytes = await downloadImage(item.url, endpoint.assetHosts ?? [], this.config, signal);
                assertImageFormat(bytes, request.format);
                let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); item.b64_json = btoa(binary);
            }
        }
        return decodeImages(value, request, native);
    }
    private async speech(request: SpeechSynthesisRequest, signal: AbortSignal, requestId: string): Promise<MediaGenerationResult> {
        const endpoint = this.config.provider.media!['speech.synthesize']!;
        if (endpoint.adapter === 'doubao-speech') return doubaoSpeech(this.config, endpoint, request, signal, requestId);
        if (request.input.length > 4096 || (request.instructions?.length ?? 0) > 4096) throw new Error('Speech endpoint input limit exceeded');
        if (request.speed !== undefined && (request.speed < 0.25 || request.speed > 4)) throw new Error('Speech endpoint speed limit exceeded');
        const body = { model: request.model, input: request.input, voice: request.voice,
            response_format: request.format, speed: request.speed, instructions: request.instructions };
        const response = await postMedia(this.config, this.config.provider.media!['speech.synthesize']!, '/v1/audio/speech', body, signal);
        const mimeType = speechMime[request.format];
        if (response.mimeType && response.mimeType !== 'application/octet-stream' && response.mimeType !== mimeType
            && !(request.format === 'wav' && response.mimeType === 'audio/x-wav')) throw new Error('Unexpected speech response content type');
        return { model: request.model!, assets: [{ mimeType, data: response.bytes }] };
    }
}
const speechMime = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm' };
function decodeImages(value: unknown, request: ImageGenerationRequest, native = false): MediaGenerationResult {
    const result = value as { data?: Array<{ b64_json?: unknown; output_format?: unknown; error?: unknown }>; usage?: Record<string, unknown>; output_format?: string } | null;
    if (!result || !Array.isArray(result.data) || result.data.length !== (request.count ?? 1)) throw new Error('Invalid image response count');
    if (result.output_format && result.output_format !== request.format) throw new Error('Unexpected image response format');
    const assets = result.data.map(item => {
        if (item.error) throw new Error('Image service rejected an output');
        if (item.output_format && item.output_format !== request.format) throw new Error('Unexpected image response format');
        if (typeof item?.b64_json !== 'string' || !item.b64_json || item.b64_json.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json))
            throw new Error('Expected an inline base64 image result');
        const data = Uint8Array.from(atob(item.b64_json), char => char.charCodeAt(0));
        if (native) assertImageFormat(data, request.format);
        return { mimeType: `image/${request.format}`, data };
    });
    const usage = imageUsage(result.usage, native);
    return { model: request.model!, assets, ...(usage ? { usage } : {}) };
}
function imageUsage(value: Record<string, unknown> | undefined, native: boolean): TokenUsage | undefined {
    if (!value) return;
    const valid = (item: unknown): item is number => Number.isSafeInteger(item) && Number(item) >= 0;
    if (native && value.input_tokens === undefined && valid(value.total_tokens) && valid(value.output_tokens))
        value = { ...value, input_tokens: Number(value.total_tokens) - Number(value.output_tokens) };
    if (native && value.total_tokens === undefined && value.output_tokens === undefined) return;
    if (![value.input_tokens, value.output_tokens, value.total_tokens].every(valid)) throw new Error('Invalid image usage');
    return { prompt_tokens: value.input_tokens as number, completion_tokens: value.output_tokens as number, total_tokens: value.total_tokens as number };
}
