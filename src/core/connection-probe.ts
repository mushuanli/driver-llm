import type { ConnectionTestResult, ProviderConnectionTestParams, LLMClientConfig } from '../types';
import { LLMDriver } from './driver';
import { LLMError } from '../errors';
import type { LLMLogSink } from '../types/provider';
import { modelReasoning } from '../types/reasoning';

export function probeLogger(logger: LLMLogSink, operationId: string): LLMLogSink {
    const write = (level: 'debug' | 'info' | 'warn' | 'error') => (message: string, metadata?: Record<string, unknown>) =>
        logger[level](message, { ...metadata, operationId });
    return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

export function validateProbe(config: ProviderConnectionTestParams): string | undefined {
    if (!config.provider) return 'Provider is required';
    if (config.providerDefinition && config.providerDefinition.id !== config.provider) return 'Provider definition identity does not match';
    if (config.operation && !['chat', 'image.generate', 'speech.synthesize'].includes(config.operation)) return 'Unsupported verification operation';
    if (!config.model && config.provider !== 'codex') return 'Model is required';
    const model = config.providerDefinition?.models.find(item => item.id === config.model);
    if ((config.operation ?? 'chat') === 'chat') {
        if (config.providerDefinition?.models.length && !model && config.provider !== 'codex') return 'Selected text model is not in the Provider catalog';
        if (model && model.category === undefined && model.capabilitiesKnown === false) return 'Text model capability is unknown; declare its category first';
        if (model && (model.category ?? 'chat') !== 'chat') return 'Provider tests require a text model; verify media separately';
    } else if (!config.request || config.request.operation !== config.operation || config.request.model !== config.model) {
        return 'Media verification requires a matching operation, explicit model and request';
    }
    if (!config.apiKey && config.provider !== 'codex' && config.provider !== 'chatgpt'
        && config.providerDefinition?.implementation !== 'chatgpt' && config.providerDefinition?.credentialMode !== 'host') return 'API Key is required';
}

export async function executeProbe(config: ProviderConnectionTestParams, options: LLMClientConfig): Promise<Partial<ConnectionTestResult>> {
    const driver = new LLMDriver(options);
    try {
        if (config.operation && config.operation !== 'chat') {
            const result = await driver.generateMedia(config.request!);
            const bytes = result.assets.reduce((sum, asset) => sum + asset.data.length, 0);
            return { success: true, model: result.model, message: 'Media verification successful',
                ...(bytes <= 8 * 1024 * 1024 ? { assets: result.assets } : {}) };
        }
        const model = config.providerDefinition?.models.find(item => item.id === config.model);
        const reasoning = modelReasoning(model, config.protocol ?? model?.preferredProtocol ?? config.providerDefinition?.defaultProtocol);
        const result = await driver.chat.create({ messages: [{ role: 'user', content: 'Reply with OK.' }],
            model: config.model, maxTokens: 256, stream: false,
            ...(reasoning?.canDisable === true ? { thinking: false } : {}) });
        return { success: !!result.choices?.length, model: result.model || config.model,
            message: result.choices?.length ? 'Text connection successful' : 'Response was empty' };
    } finally { await driver.dispose(); }
}

export function probeFailure(error: unknown): Partial<ConnectionTestResult> {
    const failure = error as { code?: string; statusCode?: number; remoteCode?: string; message?: string; stage?: string };
    const transportCode = transportFailureCode(error);
    const network = transportCode || failure?.code === 'NETWORK_ERROR' || error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
    const code = network && !failure?.statusCode ? 'NETWORK_ERROR'
        : failure?.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ? failure.code : 'CONNECTION_TEST_FAILED';
    const stage = failure?.stage === 'validation' || code.startsWith('REASONING_') ? 'validation'
        : !failure?.statusCode && (network || ['TIMEOUT', 'ABORTED'].includes(code)) ? 'transport' : 'response';
    return { success: false, code, message: error instanceof LLMError ? `${code}: ${error.message}`
        : failure?.message ?? 'Connection verification failed', stage, ...(transportCode ? {transportCode} : {}),
        statusCode: failure?.statusCode, remoteCode: failure?.remoteCode };
}

/** Surface only recognized network causes, never arbitrary nested exception data. */
function transportFailureCode(error: unknown): string | undefined {
    const known = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
        'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
    const seen = new Set<unknown>();
    let current = error;
    while (current && typeof current === 'object' && !seen.has(current) && seen.size < 8) {
        seen.add(current);
        const row = current as {code?: unknown; cause?: unknown};
        if (typeof row.code === 'string' && known.has(row.code)) return row.code;
        current = row.cause;
    }
}
