import { describe, expect, it, vi } from 'vitest';
import { LLMDriver } from '../src/index';
import type { ChatCompletionParams } from '../src/contracts';
import { readTextSource } from '../src/utils/attachment';

const completion = (content: string) => new Response(JSON.stringify({
    id: 'test', model: 'model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
}), { headers: { 'content-type': 'application/json' } });

describe('public client capabilities', () => {
    it('accepts JSON message and tool DTOs without context runtime objects', async () => {
        const transport = vi.fn<typeof fetch>().mockResolvedValue(completion('done'));
        const client = new LLMDriver({ provider: 'openai', apiKey: 'key', model: 'model', fetch: transport });
        const request: ChatCompletionParams = {
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'Read the file' }] },
                { role: 'assistant', content: '', tool_calls: [
                    { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
                ] },
                { role: 'tool', tool_call_id: 'call-1', content: 'file contents' },
            ],
            tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
        };
        try {
            const response = await client.chat.create(JSON.parse(JSON.stringify(request)) as ChatCompletionParams);
            expect(response.choices[0].message.content).toBe('done');
            const body = JSON.parse(String(transport.mock.calls[0][1]?.body));
            expect(body.messages).toEqual(request.messages);
            expect(body.tools).toEqual(request.tools);
        } finally { await client.dispose(); }
    });

    it('isolates transport and logging across clients', async () => {
        const firstFetch = vi.fn<typeof fetch>().mockResolvedValue(completion('first'));
        const secondFetch = vi.fn<typeof fetch>().mockResolvedValue(completion('second'));
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const first = new LLMDriver({ provider: 'custom', protocol: 'openai-chat', apiKey: 'one',
            model: 'model', apiBaseUrl: 'https://one.example/v1', fetch: firstFetch, logger });
        const second = new LLMDriver({ provider: 'custom', protocol: 'openai-chat', apiKey: 'two',
            model: 'model', apiBaseUrl: 'https://two.example/v1', fetch: secondFetch });
        try {
            const request = { messages: [{ role: 'user' as const, content: 'hello' }] };
            expect((await first.chat.create(request)).choices[0].message.content).toBe('first');
            expect((await second.chat.create(request)).choices[0].message.content).toBe('second');
            expect(firstFetch.mock.calls[0][0]).toBe('https://one.example/v1/chat/completions');
            expect(secondFetch.mock.calls[0][0]).toBe('https://two.example/v1/chat/completions');
            expect(logger.info).toHaveBeenCalledTimes(1);
        } finally { await Promise.all([first.dispose(), second.dispose()]); }
    });

    it('lets a policy stop retries on retryable transport failures', async () => {
        const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }));
        const policy = vi.fn().mockReturnValue(false);
        const client = new LLMDriver({ provider: 'openai', apiKey: 'key', model: 'model',
            fetch: transport, retryPolicy: { shouldRetry: policy }, maxRetries: 3 });
        try {
            await expect(client.chat.create({ messages: [] })).rejects.toThrow();
            expect(transport).toHaveBeenCalledTimes(1);
            expect(policy).toHaveBeenCalledTimes(1);
        } finally { await client.dispose(); }
    });

    it('cancels retry backoff without sending another request', async () => {
        const abort = new AbortController();
        const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }));
        const client = new LLMDriver({ provider: 'openai', apiKey: 'key', model: 'model', fetch: transport,
            retryPolicy: { delayMs: () => { queueMicrotask(() => abort.abort()); return 60_000; } } });
        try {
            await expect(client.chat.create({ messages: [], signal: abort.signal })).rejects.toThrow();
            expect(transport).toHaveBeenCalledTimes(1);
        } finally { await client.dispose(); }
    });

    it('decodes UTF-8 text attachments without Node Buffer', async () => {
        const bytes = new TextEncoder().encode('你好，world');
        const encoded = btoa(String.fromCharCode(...bytes));
        expect(await readTextSource(`data:text/plain;base64,${encoded}`)).toBe('你好，world');
    });
});
