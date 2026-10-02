import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMDriver } from '../src/core/driver';

const globalFetch = vi.fn();
global.fetch = globalFetch;

describe('Gemini Provider', () => {
    beforeEach(() => vi.resetAllMocks());

    it('should put API key in URL and transform messages to contents', async () => {
        const driver = new LLMDriver({
            provider: 'gemini',
            apiKey: 'gemini-key',
            model: 'gemini-1.5-pro'
        });

        globalFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                candidates: [{
                    content: {
                        parts: [{ text: 'Hello from Google' }]
                    },
                    finishReason: 'STOP'
                }],
                usageMetadata: { totalTokenCount: 10 }
            })
        });

        await driver.chat.create({
            messages: [
                { role: 'user', content: 'Hi Gemini' }
            ]
        });

        const [url, options] = globalFetch.mock.calls[0];
        const body = JSON.parse(options.body);

        // Check URL structure
        expect(url).toContain('gemini-1.5-pro:generateContent');
        expect(url).toContain('key=gemini-key');

        // Check Body structure (OpenAI messages -> Gemini contents)
        expect(body.contents[0].role).toBe('user');
        expect(body.contents[0].parts[0].text).toBe('Hi Gemini');
    });
});
