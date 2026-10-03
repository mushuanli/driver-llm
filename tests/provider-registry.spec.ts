import { expect, it, vi } from 'vitest';
import { BaseProvider, LLMDriver, OpenAIProvider, ResponsesProvider, createProvider, createProviderRegistry } from '../src';
import type { ChatCompletionParams, ChatCompletionResponse, ChatCompletionChunk } from '../src/contracts';

class FirstProvider extends BaseProvider {
    readonly name: string = 'first';
    readonly capabilities = {};
    async create(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
        return { id: this.name, object: 'chat.completion', created: 0, model: params.model ?? '',
            choices: [{ index: 0, message: { role: 'assistant', content: this.name }, finish_reason: 'stop' }] };
    }
    async *stream(): AsyncGenerator<ChatCompletionChunk> { throw new Error('Unused'); }
}
class SecondProvider extends FirstProvider { readonly name = 'second'; }

it('isolates host registrations and captures factories for later model changes', async () => {
    const first = createProviderRegistry({ custom: FirstProvider });
    const second = createProviderRegistry({ custom: SecondProvider });
    const a = new LLMDriver({ provider: 'custom', apiKey: 'test', providerFactory: first.snapshot() });
    const b = new LLMDriver({ provider: 'custom', apiKey: 'test', providerFactory: second.snapshot() });
    first.register('custom', SecondProvider);
    try {
        const request = { model: 'new-model', messages: [{ role: 'user' as const, content: 'hello' }] };
        expect((await a.chat.create(request) as ChatCompletionResponse).id).toBe('first');
        expect((await b.chat.create(request) as ChatCompletionResponse).id).toBe('second');
        expect(second.get('custom')).toBe(SecondProvider);
        expect(first.snapshot()({ provider: 'custom', apiKey: 'test' }).name).toBe('second');
        expect(createProvider({ provider: 'custom', apiKey: 'test' })).toBeInstanceOf(OpenAIProvider);
    } finally { await Promise.all([a.dispose(), b.dispose()]); }
});

it('keeps explicit wire protocols authoritative with host extensions', () => {
    const registry = createProviderRegistry({ custom: FirstProvider });
    expect(registry.snapshot()({ provider: 'custom', apiKey: 'test', protocol: 'openai-responses' })).toBeInstanceOf(ResponsesProvider);
    expect(() => registry.register(' ', FirstProvider)).toThrow('non-empty');
});

it('keeps wire failure diagnostics inside the selected client sink', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fetch: typeof globalThis.fetch = async () => new Response('{"error":{"message":"invalid"}}', { status: 400 });
    const a = new LLMDriver({ provider: 'openai', apiKey: 'test', fetch, logger });
    const b = new LLMDriver({ provider: 'openai', apiKey: 'test', fetch });
    try {
        await expect(a.chat.create({ messages: [] })).rejects.toThrow();
        const calls = logger.error.mock.calls.length;
        expect(logger.error).toHaveBeenCalledWith('[LLM] HTTP error (non-stream)', expect.objectContaining({ status: 400 }));
        await expect(b.chat.create({ messages: [] })).rejects.toThrow();
        expect(logger.error).toHaveBeenCalledTimes(calls);
        expect(consoleError).not.toHaveBeenCalled();
    } finally { await Promise.all([a.dispose(), b.dispose()]); consoleError.mockRestore(); }
});
