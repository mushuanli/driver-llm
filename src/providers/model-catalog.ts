import type { LLMModel, LLMProvider } from '../types';
import type { ChatGPTConfig } from '../types';
import { ChatGPTError } from './chatgpt-auth';
import { listChatGPTModels } from './chatgpt-models';
import { catalogCapabilities } from './catalog-capabilities';
import type { LLMLogSink } from '../types/provider';
import { requestUUID } from '../utils/uuid';

type CatalogPage = Record<string, unknown>;

function catalogURL(provider: LLMProvider): URL {
    if (provider.modelsPath) {
        return new URL(provider.modelsPath, provider.baseURL.replace(/\/$/, '') + '/');
    }
    const base = provider.baseURL.replace(/\/$/, '');
    const path = (provider.chatPath ?? provider.defaultPath)?.replace(/\/(chat\/completions|messages|responses)\/?$/, '/models');
    if (path?.endsWith('/models')) {
        const parsed = new URL(base), prefix = parsed.pathname.replace(/\/$/, '');
        return new URL(prefix && path.startsWith(prefix + '/') ? path : prefix + path, parsed.origin);
    }
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
    const name = row.displayName ?? row.display_name ?? row.name;
    const capabilities = catalogCapabilities(row);
    if (gemini && methods.length) {capabilities.category = methods.includes('generateContent') ? 'chat' : methods.some(method => typeof method === 'string' && /embed/i.test(method)) ? 'embedding' : capabilities.category; capabilities.capabilitiesKnown = !!capabilities.category;}
    return { id, name: typeof name === 'string' ? name : id, ...capabilities };
}

function nextCursor(page: CatalogPage, gemini: boolean): string | undefined {
    if (gemini) return typeof page.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : undefined;
    if (page.has_more !== true) return;
    if (typeof page.last_id !== 'string' || !page.last_id) throw new Error('Invalid model catalog pagination');
    return page.last_id;
}

/** Read all pages atomically so failures never return a partial catalog. */
export async function listProviderModels(provider: LLMProvider,
    options: { chatgpt?: ChatGPTConfig; fetch?: typeof globalThis.fetch; signal?: AbortSignal; logger?: LLMLogSink; requestId?: string } = {}): Promise<LLMModel[]> {
    const started = performance.now(), requestId = options.requestId ?? requestUUID();
    options.logger?.info('model.catalog.started', {requestId, providerId: provider.id});
    try {
        const models = await fetchProviderModels(provider, {...options, requestId});
        options.logger?.info('model.catalog.completed', {requestId, providerId: provider.id, count: models.length,
            imageModels: models.filter(model => model.category === 'image').length,
            videoModels: models.filter(model => model.category === 'video').length,
            mediaOperations: models.filter(model => model.operations && Object.keys(model.operations).length).length,
            unknownCapabilities: models.filter(model => model.capabilitiesKnown === false).length, durationMs: Math.round(performance.now() - started)});
        return models;
    } catch (error) {
        const {code, statusCode} = (error as {code?: unknown; statusCode?: unknown}) ?? {};
        options.logger?.error('model.catalog.failed', {requestId, providerId: provider.id,
            code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : error instanceof SyntaxError ? 'MODEL_CATALOG_JSON' : 'MODEL_CATALOG_FAILED',
            ...(typeof statusCode === 'number' ? {statusCode} : {}), durationMs: Math.round(performance.now() - started)});
        throw error;
    }
}

async function fetchProviderModels(provider: LLMProvider, options: Parameters<typeof listProviderModels>[1] = {}): Promise<LLMModel[]> {
    if (provider.modelsPath === false) throw Object.assign(new Error('This provider does not expose a remote model catalog; use configured models'), {code: 'MODEL_CATALOG_UNSUPPORTED'});
    if (provider.id === 'chatgpt' || provider.implementation === 'chatgpt' || options.chatgpt) {
        if (!options.chatgpt) throw new ChatGPTError('auth_session_required', 401);
        return listChatGPTModels(options.chatgpt, options);
    }
    if (provider.id === 'codex') throw new Error('This provider does not expose an HTTP model catalog');
    const url = catalogURL(provider);
    if (provider.authMethod === 'query-param' && provider.apiKey) url.searchParams.set('key', provider.apiKey);
    const gemini = provider.implementation === 'gemini';
    const headers = catalogHeaders(provider);
    const signal = options.signal ?? AbortSignal.timeout(30_000);
    const models = new Map<string, LLMModel>();
    const cursors = new Set<string>();
    for (let index = 0; index < 100; index++) {
        const {page, entries} = await catalogPage(url, {headers, signal}, gemini, options, index);
        for (const entry of entries) {
            const model = normalizeModel(entry, gemini);
            if (model && !models.has(model.id)) models.set(model.id, model);
        }
        options.logger?.info('model.catalog.page', {requestId: options.requestId, page: index, count: entries.length, total: models.size,
            unknownCapabilities: [...models.values()].filter(model => model.capabilitiesKnown === false).length});
        const cursor = nextCursor(page, gemini);
        if (!cursor) return [...models.values()];
        if (cursors.has(cursor)) throw new Error('Repeated model catalog pagination cursor');
        cursors.add(cursor);
        url.searchParams.set(gemini ? 'pageToken' : 'after_id', cursor);
    }
    throw new Error('Model catalog pagination limit exceeded');
}

async function catalogPage(url: URL, init: RequestInit, gemini: boolean, options: NonNullable<Parameters<typeof listProviderModels>[1]>, index: number) {
    options.logger?.info('model.catalog.request', {requestId: options.requestId, page: index, path: url.pathname});
    const response = await (options.fetch ?? globalThis.fetch)(url, init);
    if (!response.ok) throw Object.assign(new Error(`Model catalog request failed: HTTP ${response.status}`), {code: 'MODEL_CATALOG_HTTP', statusCode: response.status});
    const page: CatalogPage = await response.json(), entries = page?.[gemini ? 'models' : 'data'];
    if (!Array.isArray(entries)) throw Object.assign(new Error('Invalid model catalog response'), {code: 'MODEL_CATALOG_RESPONSE'});
    return {page, entries};
}
