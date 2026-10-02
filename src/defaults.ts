import type { LLMProvider } from './types/connection';
export const DEFAULT_TIMEOUT = 60_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY = 1_000;
const endpoints: Record<string, string> = { openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com', deepseek: 'https://api.deepseek.com', groq: 'https://api.groq.com/openai', openrouter: 'https://openrouter.ai/api', ollama: 'http://localhost:11434' };
/** Protocol defaults only; catalogs, pricing and named connections belong to the host. */
export const LLM_PROVIDERS: Record<string, LLMProvider> = Object.fromEntries(Object.entries(endpoints).map(([id, baseURL]) => [id, { id, name: id, baseURL, implementation: id === 'anthropic' ? 'anthropic' : id === 'gemini' ? 'gemini' : 'openai-compatible', models: [], ...(id === 'deepseek' ? { responses: { defaultThinkingEnabled: true } } : {}) }]));
