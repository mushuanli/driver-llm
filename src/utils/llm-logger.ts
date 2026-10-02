/**
 * @file driver-llm/src/utils/llm-logger.ts
 * @description NoopLLMLogger — default no-op logger (for web, DevTools Network works fine)
 */

import type { ILLMLogger, LLMRequestLog, LLMResponseLog } from '../types';

export class NoopLLMLogger implements ILLMLogger {
    logMessage(_session: string, _role: 'user' | 'assistant' | 'system', _content: string): void {}
    logRequest(_session: string, _request: LLMRequestLog): void {}
    logResponse(_session: string, _response: LLMResponseLog): void {}
}
