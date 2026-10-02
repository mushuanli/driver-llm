import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMDriver } from '../src/core/driver';

const globalFetch = vi.fn();
global.fetch = globalFetch;

describe('Anthropic Provider', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('should separate system prompt and transform thinking params', async () => {
        const driver = new LLMDriver({
            provider: 'anthropic',
            apiKey: 'sk-ant-test',
            model: 'claude-3-7-sonnet-20250219'
        });

        globalFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                content: [
                    { type: 'thinking', thinking: 'I should analyze this...' },
                    { type: 'text', text: 'Here is the answer.' }
                ],
                stop_reason: 'end_turn',
                model: 'claude-3-7-sonnet-20250219',
                usage: { input_tokens: 10, output_tokens: 20 }
            })
        });

        const response = await driver.chat.create({
            messages: [
                { role: 'system', content: 'You are a coder.' },
                { role: 'user', content: 'Write code.' }
            ],
            thinking: true,
            thinkingBudget: 2048,
            maxTokens: 8192
        });

        // 1. Verify Request Structure
        const requestCall = globalFetch.mock.calls[0];
        const body = JSON.parse(requestCall[1].body);

        // System prompt should be top-level
        expect(body.system).toBe('You are a coder.');
        // Messages should NOT contain system prompt
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].role).toBe('user');
        // Thinking param should be transformed
        expect(body.thinking).toEqual({
            type: 'enabled',
            budget_tokens: 2048
        });
        // Max tokens should be enforced
        expect(body.max_tokens).toBeGreaterThan(2048);

        // 2. Verify Response Normalization
        expect(response.choices[0].message.thinking).toBe('I should analyze this...');
        expect(response.choices[0].message.content).toBe('Here is the answer.');
    });
});
