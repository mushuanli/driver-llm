import { getPrimaryProtocol } from '../types';
import type { LLMProviderConfig, LLMProvider, ApiProtocol, ProviderFactory, ProviderConstructor, LLMProviderInstance } from '../types';
import { OpenAIProvider } from './openai';
import { ResponsesProvider } from './responses';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { CodexProvider } from './codex';
import { LLM_PROVIDERS } from '../defaults';

const protocols = Object.freeze({ 'openai-chat': OpenAIProvider, 'openai-responses': ResponsesProvider,
    'anthropic-messages': AnthropicProvider, 'gemini-generate': GeminiProvider });
const implementations: Readonly<Record<string, ProviderConstructor | undefined>> = Object.freeze({ 'openai-compatible': OpenAIProvider, anthropic: AnthropicProvider, gemini: GeminiProvider });
const builtins: Readonly<Record<string, ProviderConstructor>> = Object.freeze({
    openai: OpenAIProvider, deepseek: OpenAIProvider, groq: OpenAIProvider, openrouter: OpenAIProvider,
    ollama: OpenAIProvider, custom: OpenAIProvider, volcengine: OpenAIProvider,
    codex: CodexProvider, anthropic: AnthropicProvider, gemini: GeminiProvider,
});

export interface ProviderRegistry {
    register(name: string, constructor: ProviderConstructor): void;
    get(name: string): ProviderConstructor | undefined;
    names(): string[];
    /** Capture a factory whose model selection cannot be changed by later registrations. */
    snapshot(): ProviderFactory;
}

/** Each host owns its extensions; no global mutable registry is consulted. */
export function createProviderRegistry(custom: Record<string, ProviderConstructor> = {}): ProviderRegistry {
    const registry = new Map(Object.entries({ ...builtins, ...custom }));
    return {
        register(name, constructor) {
            if (!name.trim()) throw new Error('Provider name must be non-empty');
            registry.set(name, constructor);
        },
        get: name => registry.get(name),
        names: () => [...registry.keys()],
        snapshot() {
            const snapshot = new Map(registry);
            return (config, defaults) => instantiateProvider(config, defaults, name => snapshot.get(name));
        },
    };
}

/** Built-in protocol factory; customization belongs to an injected registry snapshot. */
export const createProvider: ProviderFactory = (config, defaults) =>
    instantiateProvider(config, defaults, name => Object.hasOwn(builtins, name) ? builtins[name] : undefined);

export function resolveProtocol(url: string, providerName: string, explicit?: ApiProtocol): ApiProtocol {
    if (explicit) return explicit;
    if (url.includes('/anthropic') || url.endsWith('/messages')) return 'anthropic-messages';
    if (url.includes('/chat/completions')) return 'openai-chat';
    if (url.includes('/responses')) return 'openai-responses';
    if (url.includes('generativelanguage') || url.includes('generateContent')) return 'gemini-generate';
    if (providerName === 'anthropic') return 'anthropic-messages';
    if (providerName === 'gemini') return 'gemini-generate';
    return 'openai-chat';
}

function definitionPath(definition: LLMProvider, protocol?: ApiProtocol): string | undefined {
    const primary = getPrimaryProtocol(definition), selected = protocol ?? primary;
    switch (selected) {
        case 'openai-responses': return definition.responsesPath;
        case 'anthropic-messages': return primary === selected ? definition.defaultPath : undefined;
        case 'gemini-generate': return definition.geminiPath ?? (primary === selected ? definition.defaultPath : undefined);
        case 'openai-chat': return definition.chatPath ?? (primary === selected ? definition.defaultPath : undefined);
    }
}

function instantiateProvider(config: LLMProviderConfig, defaults: Record<string, LLMProvider> | undefined,
    lookup: (name: string) => ProviderConstructor | undefined): LLMProviderInstance {
    const definition = defaults?.[config.provider] ?? LLM_PROVIDERS[config.provider];
    if (config.provider !== 'codex' && !config.protocol && definition) {
        const preferred = definition.models.find(model => model.id === config.model)?.preferredProtocol;
        config = { ...config, protocol: preferred ?? definition.defaultProtocol };
    }
    const implementation = definition && implementations[definition.implementation];
    const Provider = (config.protocol ? protocols[config.protocol] : undefined)
        ?? lookup(config.provider) ?? implementation ?? OpenAIProvider;
    return new Provider(definition ? applyDefinition(config, definition) : config);
}

function applyDefinition(config: LLMProviderConfig, definition: LLMProvider): LLMProviderConfig {
    return { ...config,
        supportsThinking: config.supportsThinking ?? definition.supportsThinking,
        requiresReferer: config.requiresReferer ?? definition.requiresReferer,
        apiBaseUrl: config.apiBaseUrl || definition.baseURL,
        defaultPath: config.defaultPath ?? definitionPath(definition, config.protocol),
        anthropicPath: config.anthropicPath ?? definition.anthropicPath,
        responsesPath: config.responsesPath ?? definition.responsesPath,
        responses: config.responses ?? definition.responses,
    };
}
