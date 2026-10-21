import type { MediaHTTPConfig } from './http';
import { MEDIA_RESPONSE_LIMIT } from './http';

/** URL media is opt-in, bounded and fetched without inference credentials. */
export async function downloadImage(url: string, hosts: string[], config: MediaHTTPConfig, signal: AbortSignal): Promise<Uint8Array> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.port && target.port !== '443'
        || !hosts.includes(target.hostname)) throw new Error('Image download host is not allowed');
    const response = await (config.fetch ?? globalThis.fetch)(target, { signal, redirect: 'error', credentials: 'omit' });
    if (!response.ok || !response.body) throw new Error(`Image download failed with HTTP ${response.status}`);
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let length = 0;
    try {
        while (true) {
            signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
            length += value.length; if (length > MEDIA_RESPONSE_LIMIT) throw new Error('Image download exceeds the size limit');
            parts.push(value);
        }
    } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    if (!length) throw new Error('Image download is empty');
    const result = new Uint8Array(length); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
}
