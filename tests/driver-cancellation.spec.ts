import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LLMDriver } from '../src/core/driver';

const params = { messages: [{ role: 'user' as const, content: 'hello' }] };
const driver = () => new LLMDriver({ provider: 'openai', apiKey: 'test', timeout: 50, maxRetries: 3, retryDelay: 1 });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function stalledFetch(firstChunk = false) {
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
        const signal = options.signal!;
        if (signal.aborted) throw new DOMException('Fetch is aborted', 'AbortError');
        if (!firstChunk) return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Fetch is aborted', 'AbortError')), { once: true });
        });
        return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
            signal.addEventListener('abort', () => controller.error(new DOMException('Fetch is aborted', 'AbortError')), { once: true });
        } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
}

it.each([false, true])('reports first-response timeout independently of transport AbortError (stream=%s)', async stream => {
    const fetch = stalledFetch(); const client = driver();
    const result = stream
        ? (await client.chat.create({ ...params, stream: true })).next()
        : client.chat.create(params);
    const failure = expect(result).rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('50 ms') });
    await vi.advanceTimersByTimeAsync(55); await failure;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
});

it('resets the stream inactivity deadline and preserves timeout after a chunk', async () => {
    stalledFetch(true);
    const stream = await driver().chat.create({ ...params, stream: true });
    await vi.advanceTimersByTimeAsync(40);
    expect((await stream.next()).value?.choices[0].delta.content).toBe('first');
    const next = stream.next(); const failure = expect(next).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(40);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(11); await failure;
    expect(vi.getTimerCount()).toBe(0);
});

it('keeps user cancellation distinct from timeout and removes its listener', async () => {
    stalledFetch(); const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const stream = await driver().chat.create({ ...params, stream: true, signal: parent.signal });
    const next = stream.next(); const failure = expect(next).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
    await vi.advanceTimersByTimeAsync(0);
    parent.abort('user stop'); await failure;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
});

it('does not dispatch an already cancelled request', async () => {
    const fetch = stalledFetch(); const parent = new AbortController(); parent.abort();
    await expect(driver().chat.create({ ...params, signal: parent.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('cleans the deadline and parent listener when a consumer ends the stream', async () => {
    stalledFetch(true); const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const stream = await driver().chat.create({ ...params, stream: true, signal: parent.signal });
    await stream.next(); await stream.return(undefined as never);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
});
