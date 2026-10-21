// @file: driver-llm/core/api.ts

import type { ConnectionTestResult, ProviderConnectionTestParams } from '../types';
import { executeProbe, probeFailure, probeLogger, validateProbe } from './connection-probe';
import { requestUUID } from '../utils/uuid';
import { noopLog as log } from '../utils/logger';

export type { ConnectionTestResult };

/**
 * 测试 LLM 连接
 */
export async function testLLMConnection(config: ProviderConnectionTestParams & {
    timeout?: number;
    codex?: import('../types/provider').CodexCLIConfig;
    chatgpt?: import('../types/chatgpt').ChatGPTConfig;
    logger?: import('../types/provider').LLMLogSink;
    fetch?: typeof globalThis.fetch;
    mediaAdapterFactory?: import('../types').MediaAdapterFactory;
}): Promise<ConnectionTestResult> {
    const started = performance.now(), requestId = requestUUID(), operation = config.operation ?? 'chat';
    const logger = config.logger ?? log, metadata = { requestId, operation, providerId: config.provider, model: config.model };
    logger.info('connection.test.started', metadata);
    const invalid = validateProbe(config);
    let result: Partial<ConnectionTestResult>;
    try {
        result = invalid ? { success: false, code: 'CONNECTION_TEST_CONFIG', stage: 'validation', message: invalid }
            : await executeProbe(config, { provider: config.provider, apiKey: config.apiKey,
                customProviderDefaults: config.providerDefinition ? { [config.provider]: config.providerDefinition } : undefined,
                apiBaseUrl: config.baseURL, model: config.model, protocol: config.protocol,
                timeout: config.timeout ?? 15_000, mediaTimeout: 120_000, maxRetries: 1,
                codex: config.codex, chatgpt: config.chatgpt, fetch: config.fetch, mediaAdapterFactory: config.mediaAdapterFactory, logger: probeLogger(logger, requestId) });
    } catch (error) { result = probeFailure(error); }
    if (config.apiKey && result.message) result.message = result.message.split(config.apiKey).join('[redacted]');
    const latency = Math.round(performance.now() - started);
    logger[result.success ? 'info' : 'error']('connection.test.completed', { ...metadata, success: !!result.success,
        stage: result.stage ?? 'response', validationReason: invalid,
        code: result.code, statusCode: result.statusCode, remoteCode: result.remoteCode, transportCode: result.transportCode, durationMs: latency });
    return { success: false, message: '', ...result, model: result.model ?? config.model, requestId, operation, latency };
}

/**
 * 批量测试多个连接
 */
export async function testMultipleConnections(
    configs: Array<{
        id: string;
        provider: string;
        apiKey?: string;
        baseURL?: string;
        model?: string;
    }>
): Promise<Map<string, ConnectionTestResult>> {
    log.debug('Testing multiple connections', { count: configs.length });
    
    const results = new Map<string, ConnectionTestResult>();
    
    await Promise.all(configs.map(async (config) => {
        const result = await testLLMConnection(config);
        results.set(config.id, result);
    }));
    
    const successCount = Array.from(results.values()).filter(r => r.success).length;
    log.info('Batch test completed', {
        total: configs.length,
        success: successCount
    });
    
    return results;
}
