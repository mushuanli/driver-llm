import { expect, it } from 'vitest';
import { LLMDriver } from '../src/core/driver';
import { parseWireEvent } from '../src/utils/wire-decoder';

it.each([null, [], { choices: 'invalid' }, { choices: [null] }, { choices: [{ message: [] }] }])
('rejects malformed successful HTTP responses: %j', async value => {
    const driver = new LLMDriver({ provider: 'openai', apiKey: 'test', maxRetries: 0,
        fetch: async () => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }) });
    try { await expect(driver.chat.create({ messages: [{ role: 'user', content: 'Hello' }] })).rejects.toThrow('Invalid LLM'); }
    finally { await driver.dispose(); }
});
it('skips a malformed SSE frame and preserves the next valid delta', async () => {
    const frames = ['null', JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: null }] }), '[DONE]'];
    const driver = new LLMDriver({ provider: 'openai', apiKey: 'test', maxRetries: 0,
        fetch: async () => new Response(frames.map(frame => `data: ${frame}\n\n`).join(''), { status: 200 }) });
    try {
        const content: string[] = [];
        for await (const chunk of (await driver.chat.create({ messages: [{ role: 'user', content: 'Hello' }], stream: true }))) {
            content.push(chunk.choices[0]?.delta.content ?? '');
        }
        expect(content.join('')).toBe('OK');
    } finally { await driver.dispose(); }
});
it('accepts Responses text deltas and rejects malformed Gemini parts', () => {
    expect(parseWireEvent('{"type":"response.output_text.delta","delta":"Hello"}').delta).toBe('Hello');
    expect(() => parseWireEvent('{"candidates":[{"content":{"parts":[null]}}]}')).toThrow('Invalid LLM candidate parts');
});
