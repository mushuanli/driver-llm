import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMDriver } from '../src/core/driver';

// Mock fetch globally
const globalFetch = vi.fn();
global.fetch = globalFetch;

describe('Thinking Mode Normalization', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('preserves assistant tool calls and reasoning when sending tool results back', async () => {
        const driver = new LLMDriver({ provider: 'deepseek', apiKey: 'test' });
        globalFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'found' }, finish_reason: 'stop' }],
        }) });
        const call = { id: 'grep-1', type: 'function' as const, function: { name: 'Grep', arguments: '{"pattern":"mdx"}' } };
        await driver.chat.create({ messages: [
            { role: 'user', content: 'find mdx' },
            { role: 'assistant', content: '', thinking: 'Search the workspace.', tool_calls: [call] },
            { role: 'tool', tool_call_id: 'grep-1', content: '/workspace/file.ts' },
        ] });
        const request = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(request.messages[1]).toMatchObject({ tool_calls: [call], reasoning_content: 'Search the workspace.' });
        expect(request.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'grep-1' });
    });

    // 1. 测试 DeepSeek / OpenAI Compatible (字段: reasoning_content)
    it('should parse DeepSeek/OpenAI reasoning_content correctly', async () => {
        const driver = new LLMDriver({ 
            provider: 'deepseek', // 使用 openai-compatible 实现
            apiKey: 'test',
            supportsThinking: true // 强制开启支持
        });

        globalFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: 'The answer is 42.',
                        reasoning_content: 'Calculating 6 * 7...' // DeepSeek 格式
                    },
                    finish_reason: 'stop'
                }],
                model: 'deepseek-r1'
            })
        });

        const response = await driver.chat.create({
            messages: [{ role: 'user', content: 'Calc' }],
            thinking: true
        });

        expect(response.choices[0].message.content).toBe('The answer is 42.');
        expect(response.choices[0].message.thinking).toBe('Calculating 6 * 7...');
    });

    // 2. 测试 Anthropic (Block type: thinking)
    it('should parse Anthropic thinking blocks correctly', async () => {
        const driver = new LLMDriver({ 
            provider: 'anthropic', 
            apiKey: 'test' 
        });

        globalFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                content: [
                    { type: 'thinking', thinking: 'Analysis in progress...' }, // Claude 格式
                    { type: 'text', text: 'Here is the result.' }
                ],
                stop_reason: 'end_turn',
                model: 'claude-3-7-sonnet'
            })
        });

        const response = await driver.chat.create({
            messages: [{ role: 'user', content: 'Hi' }],
            thinking: true,
            thinkingBudget: 1024
        });

        // 验证请求参数转换 (thinking -> budget_tokens)
        const requestBody = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(requestBody.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });

        // 验证响应解析
        expect(response.choices[0].message.content).toBe('Here is the result.');
        expect(response.choices[0].message.thinking).toBe('Analysis in progress...');
    });

    // 3. 测试 Gemini (Field: thought / part.thought)
    it('should parse Gemini thought parts correctly', async () => {
        const driver = new LLMDriver({ 
            provider: 'gemini', 
            apiKey: 'test' 
        });

        globalFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                candidates: [{
                    content: {
                        parts: [
                            { thought: 'Processing logic...' }, // Gemini 可能的格式 (需视具体API版本而定)
                            { text: 'Done.' }
                        ]
                    },
                    finishReason: 'STOP'
                }]
            })
        });

        const response = await driver.chat.create({
            messages: [{ role: 'user', content: 'Hi' }],
            thinking: true
        });

        expect(response.choices[0].message.content).toBe('Done.');
        expect(response.choices[0].message.thinking).toBe('Processing logic...');
    });
});
