// @file: driver-llm/core/api.ts

import type { ConnectionTestResult, ProviderConnectionTestParams } from '../types';
import { LLMDriver } from './driver';
import { LLM_PROVIDERS } from '../defaults';
import { LLMError } from '../errors';
import { noopLog as log } from '../utils/logger';

export type { ConnectionTestResult };

/**
 * 测试 LLM 连接
 */
export async function testLLMConnection(config: ProviderConnectionTestParams & {
    timeout?: number;
    codex?: import('../types/provider').CodexCLIConfig;
}): Promise<ConnectionTestResult> {
    const { provider, apiKey, baseURL, model, timeout = 15000, codex } = config;
    
    // 1. 参数校验
    if (!provider) {
        return { success: false, message: 'Provider is required' };
    }
    if (!apiKey && provider !== 'codex') {
        return { success: false, message: 'API Key is required' };
    }
    
    // 2. 确定模型
    const testModel = model || 
        LLM_PROVIDERS[provider]?.models?.[0]?.id ||
        'gpt-4o-mini';
    
    log.debug('Testing connection', { provider, model: testModel });
    
    const startTime = Date.now();
    
    let driver: LLMDriver | undefined;
    try {
        // 3. 创建 Driver
        driver = new LLMDriver({
            provider,
            connection: config.protocol ? { id: 'provider-test', name: 'Provider test', providerId: provider,
                protocol: config.protocol, apiKey, baseURL, model: testModel } : undefined,
            customProviderDefaults: config.providerDefinition ? { [provider]: config.providerDefinition } : undefined,
            apiKey,
            apiBaseUrl: baseURL,
            model: testModel,
            timeout,
            maxRetries: 1, // 测试时不重试
            codex,
        });
        
        // 4. 发送测试请求
        const response = await driver.chat.create({
            messages: [{ role: 'user', content: 'Hi' }],
            model: testModel,
            maxTokens: 5,
            stream: false
        });
        
        const latency = Date.now() - startTime;
        
        // 5. 验证响应
        if (response.choices?.length > 0) {
            log.info('Connection test passed', { provider, latency });
            return {
                success: true,
                message: 'Connection successful',
                latency,
                model: response.model || testModel
            };
        } else {
            return {
                success: false,
                message: 'Response was empty',
                latency
            };
        }
        
    } catch (error: any) {
        const latency = Date.now() - startTime;
        
        if (error instanceof LLMError) {
            log.warn('Connection test failed', { provider, code: error.code });
            return {
                success: false,
                message: `${error.code}: ${error.message}`,
                latency
            };
        }
        
        log.error('Connection test error', { provider, error: error.message });

        if (error.name === 'AbortError') {
            return {
                success: false,
                message: 'Request timed out',
                latency
            };
        }
        
        return {
            success: false,
            message: error.message || 'Unknown error',
            latency
        };
    } finally {
        await driver?.dispose();
    }
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
