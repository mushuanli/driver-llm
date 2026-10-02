import type { LLMModel, LLMProvider } from '../types';

type CatalogPage = Record<string, unknown>;

function catalogURL(provider: LLMProvider): URL {
    if (provider.modelsPath) {
        return new URL(provider.modelsPath, provider.baseURL.replace(/\/$/, '') + '/');
    }
    const base = provider.baseURL.replace(/\/$/, '');
    const version = provider.implementation === 'gemini' ? 'v1beta' : 'v1';
    return new URL(/\/v\d+(?:beta\d*)?$/.test(base) ? `${base}/models` : `${base}/${version}/models`);
}

function catalogHeaders(provider: LLMProvider): Record<string, string> {
    const key = provider.apiKey?.trim();
    if (provider.implementation === 'anthropic') {
        return { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) };
    }
    if (provider.implementation === 'gemini') return key ? { 'x-goog-api-key': key } : {};
    if (!key) return {};
    if (provider.authMethod === 'api-key') return { 'x-api-key': key };
    if (provider.authMethod === 'query-param') return {};
    return { Authorization: `Bearer ${key}` };
}

function normalizeModel(entry: unknown, gemini: boolean): LLMModel | undefined {
    if (!entry || typeof entry !== 'object') return;
    const row = entry as Record<string, unknown>;
    const rawID = gemini ? row.name : row.id;
    if (typeof rawID !== 'string' || !rawID.trim()) return;
    const id = gemini ? rawID.trim().replace(/^models\//, '') : rawID.trim();
    if (!id) return;
    const methods = Array.isArray(row.supportedGenerationMethods) ? row.supportedGenerationMethods : [];
    const category = gemini && methods.some(method => typeof method === 'string' && /embed/i.test(method))
        && !methods.includes('generateContent') ? 'embedding' : 'chat';
    const name = row.displayName ?? row.display_name;
    return { id, name: typeof name === 'string' ? name : id, category,
        supportsVision: true, supportsThinking: true, supportsTools: true };
}

function nextCursor(page: CatalogPage, gemini: boolean): string | undefined {
    if (gemini) return typeof page.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : undefined;
    if (page.has_more !== true) return;
    if (typeof page.last_id !== 'string' || !page.last_id) throw new Error('Invalid model catalog pagination');
    return page.last_id;
}

/** Read all pages atomically so failures never return a partial catalog. */
export async function listProviderModels(provider: LLMProvider): Promise<LLMModel[]> {
    if (provider.id === 'codex') throw new Error('This provider does not expose an HTTP model catalog');
    const url = catalogURL(provider);
    if (provider.authMethod === 'query-param' && provider.apiKey) url.searchParams.set('key', provider.apiKey);
    const gemini = provider.implementation === 'gemini';
    const headers = catalogHeaders(provider);
    const signal = AbortSignal.timeout(30_000);
    const models = new Map<string, LLMModel>();
    const cursors = new Set<string>();
    for (let index = 0; index < 100; index++) {
        const response = await fetch(url, { headers, signal });
        if (!response.ok) throw new Error(`Model catalog request failed: HTTP ${response.status}`);
        const page: CatalogPage = await response.json();
        const entries = page?.[gemini ? 'models' : 'data'];
        if (!Array.isArray(entries)) throw new Error('Invalid model catalog response');
        for (const entry of entries) {
            const model = normalizeModel(entry, gemini);
            if (model && !models.has(model.id)) models.set(model.id, model);
        }
        const cursor = nextCursor(page, gemini);
        if (!cursor) return [...models.values()];
        if (cursors.has(cursor)) throw new Error('Repeated model catalog pagination cursor');
        cursors.add(cursor);
        url.searchParams.set(gemini ? 'pageToken' : 'after_id', cursor);
    }
    throw new Error('Model catalog pagination limit exceeded');
}
