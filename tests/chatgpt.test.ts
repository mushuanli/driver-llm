import { describe, expect, it, vi } from 'vitest';
import { ChatGPTError, ChatGPTProvider, LLMDriver, createChatGPTAuthSession,
    createProvider, createProviderRegistry, listChatGPTModels, listProviderModels, testLLMConnection } from '../src';
import type { ChatGPTAccessToken, ChatGPTAuthSession, ChatCompletionParams } from '../src/contracts';

const scopes = ['resource.invoke', 'chatgpt.tokens.use.direct'];
const token = (accessToken = 'secret'): ChatGPTAccessToken => ({ accessToken, scopes });
const session = (): ChatGPTAuthSession => createChatGPTAuthSession({ read: async () => token() });
const request: ChatCompletionParams = { messages: [{ role: 'user', content: 'Hello' }] };
const completed = (output: unknown[] = [{ type: 'message', content: [{ type: 'output_text', text: 'Hello!' }] }]) => ({
    type: 'response.completed', response: { id: 'r1', model: 'selected', status: 'completed', output,
        usage: { input_tokens: 5, output_tokens: 2 } },
});
function sse(events: unknown[], named = true): Response {
    return new Response(events.map(event => `${named ? `event: ${(event as any).type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } });
}
function client(fetch: typeof globalThis.fetch, auth = session()) {
    return new LLMDriver({ provider: 'chatgpt', protocol: 'openai-responses', model: 'selected',
        chatgpt: { session: auth }, fetch, maxRetries: 3, retryDelay: 1 });
}

describe('ChatGPT plan provider', () => {
    it('uses OAuth without an API key through the public driver and registry', async () => {
        const fetch = vi.fn(async () => sse([completed()]));
        const driver = client(fetch);
        const result = await driver.chat.create(request);
        expect(result.choices[0].message.content).toBe('Hello!');
        expect(result.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.openai.com/v1/responses');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
        expect(init.redirect).toBe('error');
        expect(createProvider({ provider: 'chatgpt', apiKey: '', protocol: 'openai-responses', chatgpt: { session: session() } }))
            .toBeInstanceOf(ChatGPTProvider);
        expect(createProviderRegistry().names()).toContain('chatgpt');
        await driver.dispose();
    });

    it('normalizes system instructions and enforces the route request shape', async () => {
        const fetch = vi.fn(async () => sse([completed()]));
        const driver = client(fetch);
        await driver.chat.create({ ...request, temperature: 0.2, topP: 0.7, maxTokens: 50, stop: ['STOP'],
            user: 'private', metadata: { private: true }, messages: [
                { role: 'system', content: [{ type: 'text', text: 'Instructions' }] }, ...request.messages,
            ] });
        const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
        expect(body).toEqual({ model: 'selected', input: [{ type: 'message', role: 'user',
            content: [{ type: 'input_text', text: 'Hello' }] }], instructions: 'Instructions', store: false, stream: true });
        await driver.dispose();
    });

    it('supports host-named provider definitions without an API key or a protocol bypass', async () => {
        const definition = { id: 'account-provider', name: 'Account', implementation: 'chatgpt' as const,
            baseURL: 'https://api.openai.com/v1', defaultProtocol: 'openai-responses' as const, models: [] };
        const config = { provider: definition.id, model: 'selected', chatgpt: { session: session() },
            customProviderDefaults: { [definition.id]: definition }, fetch: async () => sse([completed()]) };
        const driver = new LLMDriver(config);
        expect(driver.providerName).toBe('chatgpt');
        expect((await driver.chat.create(request)).choices[0].message.content).toBe('Hello!');
        expect(() => new LLMDriver({ ...config, protocol: 'openai-chat' })).toThrow('responses_protocol_required');
        vi.stubGlobal('fetch', config.fetch);
        try {
            expect(await testLLMConnection({ provider: definition.id, providerDefinition: definition, model: 'selected',
                chatgpt: { session: session() } })).toMatchObject({ success: true });
        } finally { vi.unstubAllGlobals(); }
        await driver.dispose();
    });

    it('streams data-only events and emits complete function calls once', async () => {
        const tool = { type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{"x":1}', namespace: 'functions' };
        const fetch = vi.fn(async () => sse([
            { type: 'response.created', response: { id: 'r1' } },
            { type: 'response.output_text.delta', delta: 'Hello' },
            { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"x":1}' },
            { type: 'response.function_call_arguments.done', item_id: 'fc1' },
            { type: 'response.output_item.done', item: tool }, completed([tool]),
        ], false));
        const driver = client(fetch);
        const stream = await driver.chat.create({ ...request, stream: true, tools: [{ type: 'function',
            function: { name: 'lookup', parameters: { type: 'object' } } }],
            toolChoice: { type: 'function', function: { name: 'lookup' } } });
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        expect(chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls ?? [])).toEqual([
            { id: 'call', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } },
        ]);
        expect(chunks.at(-1)).toMatchObject({ id: 'r1', choices: [{ finish_reason: 'stop' }] });
        const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
        expect(body.tools[0]).toMatchObject({ type: 'namespace', name: 'functions', tools: [{ name: 'lookup' }] });
        await driver.dispose();
    });

    it('preserves mixed assistant text and function-call history with namespace bindings', async () => {
        const fetch = vi.fn(async () => sse([completed()]));
        const driver = client(fetch);
        await driver.chat.create({ messages: [{ role: 'assistant', content: 'Checking', tool_calls: [
            { id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ] }, { role: 'tool', tool_call_id: 'call', content: 'Found' }, ...request.messages] });
        const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
        expect(body.input.slice(0, 3)).toEqual([
            { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'Checking' }] },
            { type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{}', namespace: 'functions' },
            { type: 'function_call_output', call_id: 'call', output: 'Found' },
        ]);
        await driver.dispose();
    });

    it.each([
        [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }, 'subscription_sharing_usage_limit_exceeded'],
        [{ type: 'response.incomplete' }, 'response_incomplete'],
        [{ type: 'error', error: { code: 'subscription_sharing_usage_unavailable' } }, 'subscription_sharing_usage_unavailable'],
        [{ type: 'response.completed', response: {} }, 'invalid_completed_response'],
    ])('rejects unsuccessful terminals without repeating generation: %s', async (event, reason) => {
        const fetch = vi.fn(async () => sse([{ type: 'response.output_text.delta', delta: 'Partial' }, event]));
        const driver = client(fetch);
        await expect(driver.chat.create(request)).rejects.toMatchObject({ reason, retryable: false });
        expect(fetch).toHaveBeenCalledTimes(1);
        await driver.dispose();
    });

    it('rejects EOF and malformed events instead of returning partial success', async () => {
        for (const response of [sse([{ type: 'response.output_text.delta', delta: 'Partial' }]),
            new Response('data: invalid-json\n\n')]) {
            const driver = client(async () => response);
            await expect(driver.chat.create(request)).rejects.toBeInstanceOf(ChatGPTError);
            await driver.dispose();
        }
    });

    it('surfaces errors after yielded deltas and cancels the underlying stream', async () => {
        const cancel = vi.fn();
        const wire = new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n'
                + 'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_unavailable"}}}\n\n'));
        }, cancel });
        const driver = client(async () => new Response(wire));
        const stream = await driver.chat.create({ ...request, stream: true });
        expect((await stream.next()).value.choices[0].delta.content).toBe('Partial');
        await expect(stream.next()).rejects.toMatchObject({ reason: 'subscription_sharing_usage_unavailable' });
        expect(cancel).toHaveBeenCalledOnce();
        await driver.dispose();
    });

    it('rejects alternate endpoints, incompatible protocols and API-key-only configuration', () => {
        expect(() => new LLMDriver({ provider: 'chatgpt', apiKey: 'not-oauth' })).toThrow('auth_session_required');
        expect(() => new LLMDriver({ provider: 'chatgpt', chatgpt: { session: session() }, protocol: 'openai-chat' }))
            .toThrow('responses_protocol_required');
        expect(() => new LLMDriver({ provider: 'chatgpt', chatgpt: { session: session() }, apiBaseUrl: 'https://evil.example/v1' }))
            .toThrow('unsupported_endpoint');
    });

    it.each([{ audioOutput: {} }, { modalities: ['image'] }, { tools: [{ type: 'mcp' as const }] },
        { messages: [{ role: 'user' as const, content: [{ type: 'video' as const, video: { url: 'https://example.com/video' } }] }] }])(
        'rejects unsupported media or tools before network access: %s', async params => {
            const fetch = vi.fn();
            const driver = client(fetch);
            await expect(driver.chat.create({ ...request, ...params })).rejects.toThrow();
            expect(fetch).not.toHaveBeenCalled();
            await driver.dispose();
        });

    it('does not retry transport failures or HTTP failures and does not expose server messages', async () => {
        for (const transport of [async () => { throw new TypeError('fetch failed'); },
            async () => new Response(JSON.stringify({ error: { message: 'secret' } }), { status: 503 })]) {
            const fetch = vi.fn(transport);
            const driver = client(fetch);
            await expect(driver.chat.create(request)).rejects.toMatchObject({ retryable: false });
            expect(fetch).toHaveBeenCalledOnce();
            await driver.dispose();
        }
    });

    it('supports the connection tester with host credentials and a selected model', async () => {
        const fetch = vi.fn(async () => sse([completed()]));
        vi.stubGlobal('fetch', fetch);
        try {
            expect(await testLLMConnection({ provider: 'chatgpt', model: 'selected', chatgpt: { session: session() } }))
                .toMatchObject({ success: true });
        } finally { vi.unstubAllGlobals(); }
    });
});

describe('host-managed ChatGPT credentials', () => {
    it('checks granted plan permissions before sending any request', async () => {
        const auth = createChatGPTAuthSession({ read: async () => ({ accessToken: 'secret', scopes: ['openid'] }) });
        const fetch = vi.fn();
        const driver = client(fetch, auth);
        await expect(driver.chat.create(request)).rejects.toMatchObject({ reason: 'plan_permission_required' });
        expect(fetch).not.toHaveBeenCalled();
        await driver.dispose();
    });

    it('shares one refresh across concurrent model-specific requests and catalog reads', async () => {
        let credential = { ...token('old'), expiresAt: Date.now() - 1 };
        const refresh = vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            credential = { ...token('new'), expiresAt: Date.now() + 100_000 };
            return credential;
        });
        const auth = createChatGPTAuthSession({ read: async () => credential, refresh });
        const fetch = vi.fn(async (url: any, init?: RequestInit) => {
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer new');
            return String(url).endsWith('/models') ? Response.json({ models: [] }) : sse([completed()]);
        });
        const driver = client(fetch, auth);
        await Promise.all([driver.chat.create(request), driver.chat.create({ ...request, model: 'other' }),
            listChatGPTModels({ session: auth }, { fetch })]);
        expect(refresh).toHaveBeenCalledOnce();
        await driver.dispose();
    });

    it('refreshes a rejected token once and stops after a second 401', async () => {
        let credential = token('old');
        const refresh = vi.fn(async () => (credential = token('new')));
        const auth = createChatGPTAuthSession({ read: async () => credential, refresh });
        const fetch = vi.fn(async () => new Response('{}', { status: 401 }));
        const driver = client(fetch, auth);
        await expect(driver.chat.create(request)).rejects.toMatchObject({ statusCode: 401, retryable: false });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(refresh).toHaveBeenCalledOnce();
        await driver.dispose();
    });

    it('uses already-rotated credentials for a late 401 without refreshing twice', async () => {
        const refresh = vi.fn(async () => token('new'));
        const auth = createChatGPTAuthSession({ read: async () => token('new'), refresh });
        await expect(auth.getToken({ rejectedAccessToken: 'old' })).resolves.toMatchObject({ accessToken: 'new' });
        expect(refresh).not.toHaveBeenCalled();
    });

    it('keeps one cancelled refresh waiter from cancelling other requests', async () => {
        let resolve!: (value: ChatGPTAccessToken) => void;
        const refresh = vi.fn(() => new Promise<ChatGPTAccessToken>(done => { resolve = done; }));
        const auth = createChatGPTAuthSession({ read: async () => ({ ...token(), expiresAt: 0 }), refresh });
        const abort = new AbortController();
        const first = auth.getToken({ signal: abort.signal });
        const second = auth.getToken();
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        abort.abort();
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        resolve(token('new'));
        await expect(second).resolves.toMatchObject({ accessToken: 'new' });
    });

    it('rejects expired credentials without refresh and changed permissions after refresh', async () => {
        const read = async () => ({ ...token(), expiresAt: 0 });
        await expect(createChatGPTAuthSession({ read }).getToken()).rejects.toMatchObject({ reason: 'reauthorization_required' });
        await expect(createChatGPTAuthSession({ read, refresh: async () => ({ ...token(), scopes: [] }) }).getToken())
            .rejects.toMatchObject({ reason: 'plan_permission_required' });
    });
});

describe('ChatGPT model catalog', () => {
    it('preserves account ordering, display labels and visible slugs without guessing capabilities', async () => {
        const fetch = vi.fn(async () => Response.json({ models: [
            { slug: 'b', display_name: 'Second', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' },
            { slug: 'a', display_name: 'First', visibility: 'list' },
        ] }));
        const models = await listChatGPTModels({ session: session() }, { fetch });
        expect(models.map(model => [model.id, model.name])).toEqual([['b', 'Second'], ['a', 'First']]);
        expect(models[0].supportsVision).toBeUndefined();
        expect(fetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    });

    it('routes the existing catalog API through OAuth and never falls back to API-key parsing', async () => {
        const provider = { id: 'chatgpt', name: 'ChatGPT', implementation: 'openai-compatible' as const,
            baseURL: 'https://ignored.example', apiKey: 'wrong-key', models: [] };
        await expect(listProviderModels(provider)).rejects.toThrow('auth_session_required');
        const fetch = vi.fn(async () => Response.json({ data: [{ id: 'api-key-model' }] }));
        await expect(listProviderModels(provider, { chatgpt: { session: session() }, fetch })).rejects.toThrow('invalid_model_catalog');
    });
});
