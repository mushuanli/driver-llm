import type { ChatGPTConfig, LLMModel } from '../types';
import { ChatGPTError, chatGPTFailure, fetchChatGPT } from './chatgpt-auth';

/** Account-scoped catalog; no cached fallback or inferred model capabilities. */
export async function listChatGPTModels(config: ChatGPTConfig,
    options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {}): Promise<LLMModel[]> {
    const signal = options.signal ?? AbortSignal.timeout(30_000);
    const response = await fetchChatGPT(config.session, 'models', { signal }, options.fetch);
    const page = await response.json().catch(() => undefined);
    if (!response.ok) throw chatGPTFailure(page?.error, `http_${response.status}`, response.status);
    if (!Array.isArray(page?.models)) throw new ChatGPTError('invalid_model_catalog');
    const models = new Map<string, LLMModel>();
    for (const entry of page.models) {
        if (entry?.visibility !== 'list') continue;
        if (typeof entry.slug !== 'string' || !entry.slug.trim()) throw new ChatGPTError('invalid_model_catalog');
        if (!models.has(entry.slug)) models.set(entry.slug, {
            id: entry.slug, name: typeof entry.display_name === 'string' ? entry.display_name : entry.slug,
            category: 'chat', preferredProtocol: 'openai-responses',
        });
    }
    return [...models.values()];
}
