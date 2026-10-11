import { describe, expect, it, vi } from 'vitest';
import { LLMDriver } from '../src/core/driver';
import { LLMErrorCode } from '../src/errors';
import { AnthropicProvider } from '../src/providers/anthropic';
const messages = [{ role: 'user' as const, content: 'Return JSON.' }];
const usage = { input_tokens: 34, cache_read_input_tokens: 1536, cache_creation_input_tokens: 10, output_tokens: 4096 };
function client(metadata?: Record<string, unknown>) {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
        id: 'probe', model: 'probe', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage })));
    const provider = new AnthropicProvider({ provider: 'anthropic', apiKey: 'test', model: 'probe', metadata, fetch });
    return { provider, fetch, body: () => JSON.parse(fetch.mock.calls[0][1]!.body as string) };
}
function streamClient(events: unknown[]) {
    return new LLMDriver({ provider: 'anthropic', apiKey: 'test', model: 'probe',
        fetch: async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')) });
}
async function collect(driver: LLMDriver) {
    const chunks = [];
    for await (const chunk of await driver.chat.create({ messages, stream: true })) chunks.push(chunk);
    return chunks;
}
describe('Anthropic protocol regressions', () => {
    it('sends explicit disabled thinking without conflicting effort', async () => {
        const c = client();
        await c.provider.create({ messages, thinking: false, reasoningEffort: 'high' });
        expect(c.body().thinking).toEqual({ type: 'disabled' });
        expect(c.body().output_config).toBeUndefined();
    });
    it('keeps unspecified thinking unspecified', async () => {
        const c = client(); await c.provider.create({ messages });
        expect(c.body().thinking).toBeUndefined();
    });
    it('honors model defaults and explicit caller overrides', async () => {
        const c = client({ thinkingMode: 'disabled' }); await c.provider.create({ messages });
        expect(c.body().thinking).toEqual({ type: 'disabled' });
        const override = client({ thinkingMode: 'disabled' });
        await override.provider.create({ messages, thinking: true });
        expect(override.body().thinking.type).toBe('enabled');
    });
    it('reserves output capacity when enabling thinking with defaults', async () => {
        const c = client(); await c.provider.create({ messages, thinking: true });
        expect(c.body()).toMatchObject({ max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 } });
    });
    it.each([0, 100, 4096, 10000])('rejects invalid thinking budget %s before sending', async budget => {
        const c = client();
        await expect(c.provider.create({ messages, thinking: true, thinkingBudget: budget }))
            .rejects.toMatchObject({ code: LLMErrorCode.INVALID_REQUEST, retryable: false });
        expect(c.fetch).not.toHaveBeenCalled();
    });
    it('maps a schema while preserving thinking effort', async () => {
        const c = client(); const schema = { type: 'object', properties: {}, additionalProperties: false };
        await c.provider.create({ messages, thinking: true, reasoningEffort: 'low',
            responseFormat: { type: 'json_schema', json_schema: { name: 'probe', schema } } });
        expect(c.body().output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema } });
    });
    it('rejects unsupported JSON object mode rather than dropping it', async () => {
        const c = client(); expect(c.provider.capabilities.jsonMode).toBe(false);
        await expect(c.provider.create({ messages, responseFormat: { type: 'json_object' } })).rejects.toThrow('does not support JSON object mode');
        expect(c.fetch).not.toHaveBeenCalled();
    });
    it('counts cache reads and writes as input tokens', async () => {
        const c = client(); const response = await c.provider.create({ messages });
        expect(response.usage).toMatchObject({ prompt_tokens: 1580, completion_tokens: 4096,
            total_tokens: 5676, cached_tokens: 1536, details: { cache_creation_input_tokens: 10 } });
    });
    it.each([['max_tokens', 'length'], ['tool_use', 'tool_calls'], ['end_turn', 'stop']])
        ('preserves %s at completion and merges cumulative usage', async (stop, reason) => {
            const chunks = await collect(streamClient([
                { type: 'message_start', message: { id: 'probe', model: 'probe', usage: { ...usage, output_tokens: 0 } } },
                { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1024 } },
                { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 4096 } }, { type: 'message_stop' },
            ]));
            expect(chunks.at(-1)?.choices[0].finish_reason).toBe(reason);
            expect(chunks.at(-1)?.usage).toMatchObject({ prompt_tokens: 1580, completion_tokens: 4096, total_tokens: 5676 });
        });
    it('propagates a server error delivered after successful headers', async () => {
        await expect(collect(streamClient([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])))
            .rejects.toMatchObject({ statusCode: 529, retryable: true });
    });
    it('skips malformed frames without suppressing subsequent errors', async () => {
        const driver = new LLMDriver({ provider: 'anthropic', apiKey: 'test', model: 'probe',
            fetch: async () => new Response('data: invalid\n\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}\n\n') });
        await expect(collect(driver)).rejects.toMatchObject({ code: LLMErrorCode.INVALID_REQUEST, retryable: false });
    });
});
