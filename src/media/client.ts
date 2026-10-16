import { validateMediaRequest } from '../types/media-capabilities';
import type { ImageGenerationRequest, SpeechSynthesisRequest, MediaGenerationRequest, MediaGenerationResult, TokenUsage } from '../types';
import { RequestCancellation } from '../core/request-cancellation';
import { postMedia, type MediaHTTPConfig } from './http';
export interface LLMMediaClientConfig extends MediaHTTPConfig { timeoutMs?: number }

export class LLMMediaClient {
    private readonly config: LLMMediaClientConfig;
    constructor(config: LLMMediaClientConfig) { this.config = { ...config, provider: structuredClone(config.provider) }; }
    async generate(request: MediaGenerationRequest): Promise<MediaGenerationResult> {
        validateMediaRequest(this.config.provider, request);
        if (!this.config.apiKey?.trim()) throw new Error('Media operation requires API credentials');
        const timeout = this.config.timeoutMs ?? 120_000;
        if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Invalid media timeout');
        const cancellation = new RequestCancellation(this.config.provider.id, timeout, request.signal);
        try {
            const result = request.operation === 'image.generate'
                ? await this.image(request, cancellation.controller.signal) : await this.speech(request, cancellation.controller.signal);
            cancellation.controller.signal.throwIfAborted(); return result;
        } catch (error) { throw cancellation.error(error); } finally { cancellation.dispose(); }
    }
    private async image(request: ImageGenerationRequest, signal: AbortSignal): Promise<MediaGenerationResult> {
        const endpoint = this.config.provider.media!['image.generate']!;
        if (endpoint.outputFormatParameter === false && request.format !== 'png') throw new Error('Legacy image endpoint requires PNG');
        const body = { model: request.model, prompt: request.prompt, n: request.count ?? 1, size: request.size, quality: request.quality,
            ...(endpoint.outputFormatParameter === false ? {} : { output_format: request.format }),
            ...(endpoint.responseFormat ? { response_format: endpoint.responseFormat } : {}) };
        const response = await postMedia(this.config, endpoint, '/v1/images/generations', body, signal);
        return decodeImages(JSON.parse(new TextDecoder().decode(response.bytes)), request);
    }
    private async speech(request: SpeechSynthesisRequest, signal: AbortSignal): Promise<MediaGenerationResult> {
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
function decodeImages(value: unknown, request: ImageGenerationRequest): MediaGenerationResult {
    const result = value as { data?: Array<{ b64_json?: unknown }>; usage?: Record<string, unknown>; output_format?: string } | null;
    if (!result || !Array.isArray(result.data) || result.data.length !== (request.count ?? 1)) throw new Error('Invalid image response count');
    if (result.output_format && result.output_format !== request.format) throw new Error('Unexpected image response format');
    const assets = result.data.map(item => {
        if (typeof item?.b64_json !== 'string' || !item.b64_json || item.b64_json.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json))
            throw new Error('Expected an inline base64 image result');
        return { mimeType: `image/${request.format}`, data: Uint8Array.from(atob(item.b64_json), char => char.charCodeAt(0)) };
    });
    const usage = imageUsage(result.usage);
    return { model: request.model!, assets, ...(usage ? { usage } : {}) };
}
function imageUsage(value?: Record<string, unknown>): TokenUsage | undefined {
    if (!value) return;
    const valid = (item: unknown): item is number => Number.isSafeInteger(item) && Number(item) >= 0;
    if (![value.input_tokens, value.output_tokens, value.total_tokens].every(valid)) throw new Error('Invalid image usage');
    return { prompt_tokens: value.input_tokens as number, completion_tokens: value.output_tokens as number, total_tokens: value.total_tokens as number };
}
