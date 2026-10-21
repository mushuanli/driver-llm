import type { LLMProvider, MediaEndpoint } from '../types';
import { mediaHTTPError } from './remote-error';
export const MEDIA_RESPONSE_LIMIT = 64 * 1024 * 1024;
export interface MediaHTTPConfig { provider: LLMProvider; apiKey: string; headers?: Record<string, string>; fetch?: typeof globalThis.fetch }
/** Exactly one POST. Replaying a paid generation requires an explicit caller decision. */
export async function postMedia(config: MediaHTTPConfig, endpoint: MediaEndpoint, defaultPath: string,
    body: unknown, signal: AbortSignal, auth?: Record<string, string>): Promise<{ bytes: Uint8Array; mimeType: string; requestId?: string }> {
    signal.throwIfAborted();
    const path = endpoint.path ?? defaultPath;
    if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path)) throw new Error('Media endpoint must be an absolute API path');
    const base = config.provider.baseURL.replace(/\/+$/, ''), version = path.match(/^\/v\d+(?=\/)/)?.[0];
    const url = base.endsWith(path) ? base : base + (version && base.endsWith(version) ? path.slice(version.length) : path);
    const response = await (config.fetch ?? globalThis.fetch)(url, { method: 'POST', signal, redirect: 'error',
        headers: { ...config.headers, 'Content-Type': 'application/json', ...(auth ?? {Authorization: `Bearer ${config.apiKey}`}) }, body: JSON.stringify(body) });
    const logId = response.headers.get('x-tt-logid'), requestId = logId && /^[A-Za-z0-9_-]{1,128}$/.test(logId) ? logId : undefined;
    if (!response.ok) throw await mediaHTTPError(response, config.apiKey, requestId);
    return { bytes: await readBounded(response, signal), mimeType: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '', requestId };
}
async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    if (!response.body) throw new Error('Media response body is missing');
    const reader = response.body.getReader(), parts: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MEDIA_RESPONSE_LIMIT) throw new Error('Media response exceeds the size limit');
            parts.push(value);
        }
    } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    signal.throwIfAborted();
    if (!length) throw new Error('Media response is empty');
    const bytes = new Uint8Array(length); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
}
