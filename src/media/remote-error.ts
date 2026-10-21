/** Read bounded error envelopes without retaining an upstream response or credentials. */
export async function mediaHTTPError(response: Response, secret: string, requestId?: string): Promise<Error> {
    let value: unknown;
    const reader = response.body?.getReader();
    try {
        const parts: Uint8Array[] = []; let size = 0;
        while (reader) {
            const { value: part, done } = await reader.read();
            if (done) break;
            size += part.length;
            if (size > 16_384) break;
            parts.push(part);
        }
        if (size <= 16_384) {
            const bytes = new Uint8Array(size); let offset = 0;
            for (const part of parts) { bytes.set(part, offset); offset += part.length; }
            value = JSON.parse(new TextDecoder().decode(bytes));
        }
    } catch { /* Non-JSON failures retain the HTTP classification. */ }
    finally { try { await reader?.cancel(); } finally { reader?.releaseLock(); } }
    const row = value as { error?: { code?: unknown; message?: unknown }; header?: { code?: unknown; message?: unknown }; code?: unknown; message?: unknown } | undefined;
    const code = row?.error?.code ?? row?.header?.code ?? row?.code;
    const message = row?.error?.message ?? row?.header?.message ?? row?.message;
    const detail = typeof message === 'string' ? (secret ? message.split(secret).join('[redacted]') : message).replace(/[\x00-\x1f]/g, ' ').slice(0, 512) : '';
    return Object.assign(new Error(`Media request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`),
        { code: 'MEDIA_HTTP', statusCode: response.status, requestId,
            ...(code !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(String(code)) ? { remoteCode: String(code) } : {}) });
}
