import type { MediaGenerationResult, MediaEndpoint, SpeechSynthesisRequest } from '../types';
import { requestUUID } from '../utils/uuid';
import { postMedia, type MediaHTTPConfig } from './http';

/** Native speech protocol stays inside the standalone communication driver. */
export async function doubaoSpeech(config: MediaHTTPConfig, endpoint: MediaEndpoint, request: SpeechSynthesisRequest, signal: AbortSignal, requestId = requestUUID()): Promise<MediaGenerationResult> {
    if (!['mp3', 'opus', 'pcm'].includes(request.format)) throw speechError('MEDIA_FORMAT', 'Doubao streaming speech supports MP3, Opus and PCM');
    if (request.speed !== undefined && (request.speed < 0.5 || request.speed > 2)) throw speechError('MEDIA_SPEED', 'Doubao speech speed must be between 0.5 and 2');
    if (endpoint.sampleRate !== undefined && ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(endpoint.sampleRate)) throw speechError('MEDIA_CONFIG', 'Unsupported speech sample rate');
    const response = await postMedia(config, endpoint, '/api/v3/tts/unidirectional', {req_params: {
        text: request.input, speaker: request.voice,
        audio_params: {format: request.format === 'opus' ? 'ogg_opus' : request.format, sample_rate: request.format === 'opus' ? 48000 : endpoint.sampleRate ?? 24000,
            ...(request.speed === undefined ? {} : {speech_rate: Math.round((request.speed - 1) * 100)})},
        ...(request.instructions === undefined ? {} : {context_texts: [request.instructions]}),
    }}, signal, {'X-Api-Key': config.apiKey, 'X-Api-Resource-Id': request.model!, 'X-Api-Request-Id': requestId});
    try {
        const data = decodeSpeech(response.bytes, signal);
        return {model: request.model!, assets: [{mimeType: {mp3: 'audio/mpeg', opus: 'audio/ogg', pcm: 'audio/pcm'}[request.format as 'mp3' | 'opus' | 'pcm'], data}]};
    } catch (error) { throw Object.assign(error instanceof Error ? error : speechError('MEDIA_RESPONSE', 'Invalid speech response'), {requestId: response.requestId}); }
}

function decodeSpeech(bytes: Uint8Array, signal: AbortSignal): Uint8Array {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes), parts: Uint8Array[] = [];
    let frames: unknown[];
    try {frames = [JSON.parse(text)];} catch {frames = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('event:') && !line.startsWith(':'))
        .map(line => line.replace(/^data:\s*/, '')).filter(line => line !== '[DONE]').map(line => {
            if (line.length > 8 * 1024 * 1024) throw speechError('MEDIA_FRAME_TOO_LARGE', 'Speech response frame exceeds the size limit');
            try {return JSON.parse(line);} catch {throw speechError('MEDIA_RESPONSE', 'Invalid speech response JSON');}
        });}
    for (const frame of frames) {signal.throwIfAborted(); const audio = decodeFrame(frame); if (audio) parts.push(audio);}
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    if (!length) throw speechError('MEDIA_EMPTY_AUDIO', 'Speech service returned no audio');
    const result = new Uint8Array(length); let offset = 0;
    for (const part of parts) {result.set(part, offset); offset += part.length;}
    return result;
}

function decodeFrame(value: unknown): Uint8Array | undefined {
    const frame = value as {code?: unknown; header?: {code?: unknown}; data?: unknown} | null;
    const code = frame?.code ?? frame?.header?.code;
    if (!Number.isSafeInteger(code)) throw speechError('MEDIA_RESPONSE', 'Speech response status is missing');
    if (code !== 0 && code !== 20000000) throw Object.assign(speechError('MEDIA_REMOTE_ERROR', `Speech service rejected the request (code ${code})`), {remoteCode: String(code)});
    if (frame?.data === undefined || frame.data === '') return;
    if (typeof frame?.data !== 'string' || frame.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) throw speechError('MEDIA_RESPONSE', 'Invalid speech audio base64');
    return Uint8Array.from(atob(frame.data), char => char.charCodeAt(0));
}
function speechError(code: string, message: string): Error {return Object.assign(new Error(message), {code});}
