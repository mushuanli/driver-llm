import { afterEach, expect, it, vi } from 'vitest';
import type { LLMProvider } from '@itookit/driver-llm/contracts';
import { listProviderModels } from '../src/providers/model-catalog';

const base: LLMProvider = { id: 'custom', name: 'Custom', implementation: 'openai-compatible',
    baseURL: 'https://example.com', apiKey: 'secret', models: [] };
const page = (body: unknown) => ({ ok: true, json: async () => body });
afterEach(() => vi.unstubAllGlobals());

it('rejects providers without catalog discovery before transport and retains safe diagnostics', async () => {
    const fetch = vi.fn(), logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = { ...base, modelsPath: false as const, models: [{ id: 'preset', name: 'Preset' }] };
    await expect(listProviderModels(provider, { fetch, logger })).rejects.toMatchObject({ code: 'MODEL_CATALOG_UNSUPPORTED' });
    expect(fetch).not.toHaveBeenCalled(); expect(provider.models).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith('model.catalog.failed', expect.objectContaining({ code: 'MODEL_CATALOG_UNSUPPORTED', requestId: expect.any(String), durationMs: expect.any(Number) }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
});

it('uses OpenAI auth, respects versioned bases and custom catalog paths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page({ data: [{ id: 'a' }, { id: 'a' }, {}] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listProviderModels({ ...base, baseURL: 'https://example.com/v1' })).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://example.com/v1/models');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer secret' });
    await listProviderModels({ ...base, modelsPath: '/api/catalog' });
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://example.com/api/catalog');
});

it('uses Anthropic authentication and traverses all pages', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: URL) => url.searchParams.has('after_id')
        ? page({ data: [{ id: 'b' }], has_more: false })
        : page({ data: [{ id: 'a', display_name: 'A' }], has_more: true, last_id: 'a' }));
    vi.stubGlobal('fetch', fetchMock);
    const models = await listProviderModels({ ...base, implementation: 'anthropic' });
    expect(models.map(model => model.id)).toEqual(['a', 'b']);
    expect(models[0].name).toBe('A');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' });
});

it('normalizes Gemini names and embeddings and follows nextPageToken', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: URL) => url.searchParams.has('pageToken')
        ? page({ models: [{ name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] })
        : page({ models: [{ name: 'models/chat', displayName: 'Chat', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next' }));
    vi.stubGlobal('fetch', fetchMock);
    const models = await listProviderModels({ ...base, implementation: 'gemini' });
    expect(models.map(model => [model.id, model.category])).toEqual([['chat', 'chat'], ['embed', 'embedding']]);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'x-goog-api-key': 'secret' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1beta/models');
});

it('rejects malformed catalogs, HTTP failures and repeated cursors without partial results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page({ unexpected: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listProviderModels(base)).rejects.toThrow('Invalid model catalog');
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(listProviderModels(base)).rejects.toThrow('HTTP 401');
    fetchMock.mockResolvedValue(page({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }));
    await expect(listProviderModels(base)).rejects.toThrow('Repeated');
});

it('derives a catalog path from the configured API prefix without a vendor-name branch', async () => {
    const fetch = vi.fn().mockResolvedValue(page({data: [{id: 'id-only'}]}));
    const models = await listProviderModels({...base, baseURL: 'https://ark.cn-beijing.volces.com', defaultPath: '/api/v3/chat/completions'}, {fetch});
    expect(String(fetch.mock.calls[0][0])).toBe('https://ark.cn-beijing.volces.com/api/v3/models');
    expect(models[0]).toEqual({id: 'id-only', name: 'id-only', capabilitiesKnown: false});
    await listProviderModels({...base, baseURL: 'https://example.com/api/v3', defaultPath: '/api/v3/chat/completions'}, {fetch});
    expect(String(fetch.mock.calls[1][0])).toBe('https://example.com/api/v3/models');
});
it('maps explicit capabilities and modalities while preserving negative and unknown values', async () => {
    const fetch = vi.fn().mockResolvedValue(page({data: [
        {id: 'one', capabilities: {vision: true, reasoning: false, function_calling: true}, context_length: 1000},
        {id: 'two', architecture: {input_modalities: ['text'], output_modalities: ['image']}, supported_parameters: []},
        {id: 'three', capabilities: ['vision', 'tools']},
    ]}));
    const models = await listProviderModels(base, {fetch});
    expect(models[0]).toMatchObject({supportsVision: true, supportsThinking: false, supportsTools: true, contextWindow: 1000, capabilitiesKnown: true});
    expect(models[1]).toMatchObject({category: 'image', supportsVision: false, supportsTools: false});
    expect(models[1].operations).toBeUndefined();
    expect(models[2]).toMatchObject({supportsVision: true, supportsTools: true});
});

 it('adapts Ark nested declarations without guessing operations or model names', async () => {
    const fetch = vi.fn().mockResolvedValue(page({data: [
        {id: 'opaque-image', modalities: {input_modalities: ['text', 'image'], output_modalities: ['image']}},
        {id: 'opaque-video', modalities: {input_modalities: ['text', 'first_frame'], output_modalities: ['video']}},
        {id: 'opaque-chat', modalities: {input_modalities: ['text'], output_modalities: ['text']},
            features: {tools: {function_calling: false}, structured_outputs: {json_object: false, json_schema: false}},
            token_limits: {context_window: 32768, max_output_token_length: 4096}},
        {id: 'seedream-unknown'},
        {id: 'structured', features: {structured_outputs: {json_object: true, json_schema: false}}},
        {id: 'partial', features: {structured_outputs: {json_object: false}}, token_limits: {context_window: -1}},
        {id: 'embedding', task_type: ['TextEmbedding'], modalities: {input_modalities: ['text']}},
    ]}));
    const models = await listProviderModels(base, {fetch});
    expect(models[0]).toMatchObject({category: 'image', supportsVision: true, capabilitiesKnown: true});
    expect(models[1]).toMatchObject({category: 'video', supportsVision: true});
    expect(models[2]).toMatchObject({category: 'chat', supportsTools: false, supportsStructuredOutput: false,
        contextWindow: 32768, maxOutput: 4096});
    expect(models[2].supportsThinking).toBeUndefined();
    expect(models[3]).toEqual({id: 'seedream-unknown', name: 'seedream-unknown', capabilitiesKnown: false});
    expect(models[4].supportsStructuredOutput).toBe(true);
    expect(models[5].supportsStructuredOutput).toBeUndefined();
    expect(models[5].contextWindow).toBeUndefined();
    expect(models[6].category).toBe('embedding');
    expect(models.every(model => model.operations === undefined)).toBe(true);
});

it('preserves explicit Ark generation task types without inventing output formats', async () => {
    const fetch = vi.fn().mockResolvedValue(page({data: [
        {id: 'opaque-generator', task_type: ['TextToImage', 'ImageToImage']},
        {id: 'seedream-name-only', features: {tools: {function_calling: false}}},
    ]}));
    const models = await listProviderModels(base, {fetch});
    expect(models[0]).toMatchObject({category: 'image', supportedOperations: ['image.generate'], capabilitiesKnown: true});
    expect(models[0].operations).toBeUndefined();
    expect(models[1].category).toBeUndefined(); expect(models[1].supportedOperations).toBeUndefined();
});
