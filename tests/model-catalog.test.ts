import { afterEach, expect, it, vi } from 'vitest';
import type { LLMProvider } from '@itookit/llm-common';
import { listProviderModels } from '../src/providers/model-catalog';

const base: LLMProvider = { id: 'custom', name: 'Custom', implementation: 'openai-compatible',
    baseURL: 'https://example.com', apiKey: 'secret', models: [] };
const page = (body: unknown) => ({ ok: true, json: async () => body });
afterEach(() => vi.unstubAllGlobals());

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
        : page({ models: [{ name: 'models/chat', displayName: 'Chat' }], nextPageToken: 'next' }));
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
