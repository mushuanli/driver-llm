import { expect, it, vi } from 'vitest';
import { testLLMConnection } from '../src/core/api';
import { LLMMediaClient } from '../src/media/client';
import { createMediaAdapterRegistry } from '../src/media/registry';
import { LLMDriver } from '../src/core/driver';
import { modelReasoning, resolveReasoningRequest } from '../src/types/reasoning';
import type { LLMProvider, LLMModel } from '../src/types';

function provider(): LLMProvider {
    return { id: 'p', name: 'P', implementation: 'custom', baseURL: 'https://example.test', defaultPath: '/chat',
        models: [{ id: 'image', name: 'Image', category: 'image', operations: { 'image.generate': {
            inputModalities: ['text'], outputModalities: ['image'], formats: ['png'], maxOutputs: 1 } } },
        { id: 'text', name: 'Text', category: 'chat' }], media: { 'image.generate': { adapter: 'volcengine-images' } } };
}
const image = { operation: 'image.generate', model: 'image', prompt: 'private prompt', format: 'png' } as const;

it('never tests a media model with a text request and never guesses a replacement', async () => {
    const fetch = vi.fn();
    expect(await testLLMConnection({ provider: 'p', providerDefinition: provider(), apiKey: 'secret', model: 'image', fetch })).toMatchObject({ success: false, code: 'CONNECTION_TEST_CONFIG' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await testLLMConnection({ provider: 'p', providerDefinition: provider(), apiKey: 'secret', fetch })).toMatchObject({ success: false, message: 'Model is required' });
});

it('tests the selected text model at the configured chat endpoint with safe correlated logs', async () => {
    const fetch = vi.fn(async () => Response.json({ model: 'text', choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await testLLMConnection({ provider: 'p', providerDefinition: provider(), apiKey: 'private-key', model: 'text', fetch, logger });
    expect(result).toMatchObject({ success: true, model: 'text', operation: 'chat' });
    expect(fetch.mock.calls[0][0]).toBe('https://example.test/chat');
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/private-key|Reply with OK/);
    expect(logger.info).toHaveBeenLastCalledWith('connection.test.completed', expect.objectContaining({ requestId: result.requestId, success: true }));
});

it('verifies images through the production adapter with native parameters and no retries', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ b64_json: btoa('\x89PNG\r\n\x1a\n') }], usage: { output_tokens: 10, total_tokens: 10, generated_images: 1 } }));
    const result = await testLLMConnection({ provider: 'p', providerDefinition: provider(), apiKey: 'key', model: 'image', operation: 'image.generate', request: image, fetch });
    expect(result).toMatchObject({ success: true, operation: 'image.generate', assets: [{ mimeType: 'image/png' }] });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ response_format: 'b64_json', sequential_image_generation: 'disabled', stream: false });
    expect(body).not.toHaveProperty('messages'); expect(body).not.toHaveProperty('n'); expect(fetch).toHaveBeenCalledOnce();
});

it('preserves nested upstream business errors without leaking credentials in diagnostics', async () => {
    const fetch = vi.fn(async () => Response.json({ header: { code: 45000010, message: 'Invalid X-Api-Key' } }, { status: 400, headers: { 'x-tt-logid': 'vendor-id' } }));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await testLLMConnection({ provider: 'p', providerDefinition: provider(), apiKey: 'private-key', model: 'image', operation: 'image.generate', request: image, fetch, logger });
    expect(result).toMatchObject({ success: false, code: 'MEDIA_HTTP', statusCode: 400, remoteCode: '45000010' });
    expect(result.message).toContain('Invalid X-Api-Key'); expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/private-key|private prompt|Invalid X-Api-Key/);
});

it('classifies a browser media fetch rejection as transport failure with no inferred HTTP status', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
    const result = await testLLMConnection({provider: 'p', providerDefinition: provider(), apiKey: 'private-key', model: 'image',
        operation: 'image.generate', request: image, fetch, logger});
    expect(result).toMatchObject({success: false, code: 'NETWORK_ERROR', stage: 'transport', model: 'image', operation: 'image.generate'});
    expect(result.statusCode).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenLastCalledWith('connection.test.completed', expect.objectContaining({requestId: result.requestId, stage: 'transport', code: 'NETWORK_ERROR'}));
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/private-key|private prompt/);
});

it('retains a recognized nested transport cause without copying arbitrary exception data', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed', {cause: Object.assign(new Error('private network details'), {code: 'ENOTFOUND'})}));
    const result = await testLLMConnection({provider: 'p', providerDefinition: provider(), apiKey: 'key', model: 'image',
        operation: 'image.generate', request: image, fetch});
    expect(result).toMatchObject({code: 'NETWORK_ERROR', stage: 'transport', transportCode: 'ENOTFOUND'});
    expect(JSON.stringify(result)).not.toContain('private network details');
});

it('downloads only explicitly allowed media URLs without sending inference credentials', async () => {
    const p = provider(); p.media!['image.generate'] = { adapter: 'openai-images', responseFormat: 'url', assetHosts: ['cdn.example.test'] };
    const fetch = vi.fn(async () => Response.json({ data: [{ url: 'https://cdn.example.test/image' }] }));
    fetch.mockImplementationOnce(async () => Response.json({ data: [{ url: 'https://cdn.example.test/image' }] })).mockImplementationOnce(async () => new Response(Uint8Array.from([137,80,78,71,13,10,26,10])));
    await new LLMMediaClient({ provider: p, apiKey: 'secret', fetch }).generate(image);
    expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(fetch.mock.calls[1][1]).not.toHaveProperty('headers');
    const rejected = vi.fn(async () => Response.json({ data: [{ url: 'https://private.example.test/image' }] }));
    await expect(new LLMMediaClient({ provider: p, apiKey: 'secret', fetch: rejected }).generate(image)).rejects.toThrow('not allowed');
    expect(rejected).toHaveBeenCalledOnce();
});

it('snapshots custom adapters per runtime and rejects missing registrations', async () => {
    const p = provider(); p.media!['image.generate'] = { adapter: 'example-image', operation: 'image.generate' };
    const registry = createMediaAdapterRegistry(), snapshot = registry.snapshot();
    registry.register('example-image', { operations: ['image.generate'], generate: async () => ({ model: 'image', assets: [{ mimeType: 'image/png', data: new Uint8Array([1]) }] }) });
    await expect(new LLMMediaClient({ provider: p, apiKey: 'key', adapterFactory: snapshot }).generate(image)).rejects.toThrow('not registered');
    expect((await new LLMMediaClient({ provider: p, apiKey: 'key', adapterFactory: registry.snapshot() }).generate(image)).model).toBe('image');
});

const model: LLMModel = { id: 'r', name: 'R', reasoning: { efforts: [{ id: 'low' }, { id: 'max', value: 'xhigh' }], canDisable: true },
    reasoningByProtocol: { 'anthropic-messages': { efforts: [{ id: 'high' }], canDisable: false }, 'gemini-generate': false } };
const request = { messages: [{ role: 'user', content: 'private input' }] } as const;

it('resolves route-specific reasoning levels, API mappings, defaults and explicit off', () => {
    const input = { messages: [...request.messages] };
    expect(modelReasoning(model, 'anthropic-messages')?.efforts.map(option => option.id)).toEqual(['high']);
    expect(resolveReasoningRequest(model, 'openai-chat', { ...input, reasoningEffort: 'max' })).toMatchObject({ thinking: true, reasoningEffort: 'xhigh' });
    expect(resolveReasoningRequest(model, 'openai-chat', { ...input, reasoningEffort: 'off' })).toMatchObject({ thinking: false, reasoningEffort: undefined });
    expect(() => resolveReasoningRequest(model, 'anthropic-messages', { ...input, reasoningEffort: 'max' })).toThrow('REASONING_EFFORT_UNSUPPORTED');
    expect(() => resolveReasoningRequest(model, 'anthropic-messages', { ...input, thinking: false })).toThrow('REASONING_CANNOT_DISABLE');
    expect(() => resolveReasoningRequest(model, 'gemini-generate', { ...input, reasoningEffort: 'low' })).toThrow('REASONING_UNSUPPORTED');
});

it('rejects unsupported reasoning before network transmission', async () => {
    const p = provider(); p.models = [model]; const fetch = vi.fn();
    const driver = new LLMDriver({ provider: 'p', model: 'r', apiKey: 'key', customProviderDefaults: { p }, fetch });
    await expect(driver.chat.create({ messages: [...request.messages], reasoningEffort: 'medium' })).rejects.toThrow('REASONING_EFFORT_UNSUPPORTED');
    expect(fetch).not.toHaveBeenCalled(); await driver.dispose();
});

it.each([
    ['openai-chat', 'effort', { choices: [{ message: { role: 'assistant', content: 'OK' } }] }, { reasoning_effort: 'high' }],
    ['openai-responses', 'effort', { id: 'r', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] }, { reasoning: { effort: 'high' } }],
    ['anthropic-messages', 'adaptive', { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }, { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }],
    ['gemini-generate', 'effort', { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }, { generationConfig: { thinkingConfig: { thinkingLevel: 'high' } } }],
] as const)('encodes the declared reasoning choice through %s', async (protocol, transport, response, expected) => {
    const p = provider(); p.models = [{ id: 'r', name: 'R', reasoning: { efforts: [{ id: 'max', value: 'high' }], transport } }];
    const fetch = vi.fn(async () => Response.json(response));
    const driver = new LLMDriver({ provider: 'p', model: 'r', protocol, apiKey: 'key', customProviderDefaults: { p }, fetch });
    await driver.chat.create({ messages: [{ role: 'user', content: 'OK' }], reasoningEffort: 'max' });
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject(expected);
    await driver.dispose();
});
