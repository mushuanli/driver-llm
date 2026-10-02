import type { ApiProtocol, LLMProvider } from './connection';

export const API_PROTOCOLS: readonly ApiProtocol[] = [
    'openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate',
];

export function getPrimaryProtocol(provider: Pick<LLMProvider, 'implementation'>): ApiProtocol {
    if (provider.implementation === 'anthropic') return 'anthropic-messages';
    if (provider.implementation === 'gemini') return 'gemini-generate';
    return 'openai-chat';
}

/** Infer legacy support without interpreting empty paths as enabled protocols. */
export function getProviderProtocols(provider: LLMProvider): ApiProtocol[] {
    if (provider.supportedProtocols?.length) return [...new Set(provider.supportedProtocols)];
    const protocols = new Set<ApiProtocol>([getPrimaryProtocol(provider)]);
    if (provider.responsesPath) protocols.add('openai-responses');
    if (provider.anthropicPath) protocols.add('anthropic-messages');
    if (provider.geminiPath) protocols.add('gemini-generate');
    if (provider.defaultProtocol) protocols.add(provider.defaultProtocol);
    return [...protocols];
}

export function getProviderDefaultProtocol(provider: LLMProvider): ApiProtocol {
    return provider.defaultProtocol ?? (!provider.supportedProtocols && provider.anthropicPath
        ? 'anthropic-messages' : getPrimaryProtocol(provider));
}
