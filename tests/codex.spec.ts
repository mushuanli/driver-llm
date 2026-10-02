import { describe, expect, it, vi } from 'vitest';
import { LLMDriver } from '../src/core/driver';
import { createProvider } from '../src/providers/registry';
import { CodexProvider } from '../src/providers/codex';
import { AsyncEventHub, rejectPending } from '../src/runtime/async-event-hub';
import type { CodexAppServerTransport, CodexCommandRunner, CodexRPCMessage } from '../src/types/provider';

function mockTransport(turns: CodexRPCMessage[][]): CodexAppServerTransport & { request: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> } {
    let turn = 0;
    return {
        request: vi.fn(async (method: string) => method === 'thread/start' ? { thread: { id: 'thread-app' } } : { turn: { id: `turn-${turn + 1}` } }),
        respond: vi.fn(async () => undefined),
        events: () => (async function* () { yield* (turns[turn++] ?? []); })(),
    };
}

describe('CodexProvider', () => {
    it('takes precedence over an OpenAI-compatible saved provider definition', () => {
        const provider = createProvider({ provider: 'codex', apiKey: '' }, {
            codex: { id: 'codex', name: 'Codex', baseURL: '', implementation: 'openai-compatible', models: [] },
        });
        expect(provider).toBeInstanceOf(CodexProvider);
    });

    it('invokes codex exec with the documented defaults without an API key', async () => {
        const run = vi.fn(async () => ({ stdout: [
            '{"type":"thread.started","thread_id":"thread-1"}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}',
            '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":3,"output_tokens":2,"reasoning_output_tokens":1}}',
        ].join('\n'), stderr: '' }));
        const driver = new LLMDriver({
            provider: 'codex',
            model: 'gpt-5.6-sol',
            codex: { mode: 'exec', runner: { run } as CodexCommandRunner },
        });

        const response = await driver.chat.create({
            messages: [{ role: 'user', content: '只回复 OK' }],
        });

        expect(response.choices[0].message.content).toBe('OK');
        expect(response.id).toBe('thread-1');
        expect(response.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 3, thinking_tokens: 1 });
        expect(run).toHaveBeenCalledWith('codex', [
            'exec', '--skip-git-repo-check', '--json', '--color', 'never', '-m', 'gpt-5.6-sol',
            '-c', 'model_reasoning_effort="high"',
            'user: 只回复 OK',
        ], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('maps reasoning effort and supports the unified streaming API', async () => {
        const run = vi.fn();
        const streamEvents = vi.fn(async function* () {
            yield '{"type":"thread.started","thread_id":"t2"}\n';
            yield '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}\n';
            yield '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":1}}\n';
        });
        const driver = new LLMDriver({ provider: 'codex', codex: { mode: 'exec', runner: { run, stream: streamEvents } } });
        const stream = await driver.chat.create({
            model: 'gpt-5.6-sol',
            reasoningEffort: 'xhigh',
            messages: [{ role: 'system', content: 'Be concise' }, { role: 'user', content: 'Hi' }],
            stream: true,
        });

        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        expect(chunks.map(c => c.choices[0].delta.content).join('')).toBe('hello');
        expect(chunks.at(-1)?.usage?.total_tokens).toBe(5);
        expect(streamEvents.mock.calls[0][1]).toContain('model_reasoning_effort="xhigh"');
    });

    it('normalizes structured output and caller tool calls', async () => {
        const toolPayload = JSON.stringify({ tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } }] });
        const run = vi.fn(async () => ({ stdout: `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(toolPayload)}}}\n` }));
        const driver = new LLMDriver({ provider: 'codex', codex: { mode: 'exec', runner: { run } } });
        const response = await driver.chat.create({ messages: [{ role: 'user', content: 'weather?' }], tools: [{ type: 'function', function: { name: 'weather' } }] });
        expect(response.choices[0].finish_reason).toBe('tool_calls');
        expect(response.choices[0].message.tool_calls?.[0].function?.name).toBe('weather');
    });

    it('uses app-server deltas, native history, effort, schema, and usage', async () => {
        const transport = mockTransport([[
            { method: 'item/reasoning/textDelta', params: { threadId: 'thread-app', turnId: 'turn-1', delta: 'think' } },
            { method: 'item/agentMessage/delta', params: { threadId: 'thread-app', turnId: 'turn-1', delta: 'OK' } },
            { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-app', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 7, outputTokens: 2, totalTokens: 9, cachedInputTokens: 1, reasoningOutputTokens: 1 } } } },
            { method: 'turn/completed', params: { threadId: 'thread-app', turn: { status: 'completed' } } },
        ], [
            { method: 'item/agentMessage/delta', params: { threadId: 'thread-app', turnId: 'turn-2', delta: 'again' } },
            { method: 'turn/completed', params: { threadId: 'thread-app', turn: { status: 'completed' } } },
        ]]);
        const driver = new LLMDriver({ provider: 'codex', codex: { transport } });
        const first = await driver.chat.create({ reasoningEffort: 'high', responseFormat: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } }, messages: [{ role: 'user', content: 'one' }] });
        expect(first.choices[0].message.thinking).toBe('think');
        expect(first.usage?.total_tokens).toBe(9);
        await driver.chat.create({ messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'two' }] });
        expect(transport.request.mock.calls.filter(c => c[0] === 'thread/start')).toHaveLength(1);
        const starts = transport.request.mock.calls.filter(c => c[0] === 'turn/start');
        expect(starts[0][1]).toMatchObject({ effort: 'high', outputSchema: { type: 'object' } });
        expect(starts[1][1].input).toHaveLength(1);
    });

    it('bridges app-server dynamic tool calls back to caller tool results', async () => {
        const transport = mockTransport([[
            { id: 42, method: 'item/tool/call', params: { threadId: 'thread-app', turnId: 'turn-1', callId: 'call-1', tool: 'weather', arguments: { city: 'Shanghai' } } },
        ], [
            { method: 'item/agentMessage/delta', params: { threadId: 'thread-app', turnId: 'turn-1', delta: 'sunny' } },
            { method: 'turn/completed', params: { threadId: 'thread-app', turn: { status: 'completed' } } },
        ]]);
        const driver = new LLMDriver({ provider: 'codex', codex: { transport } });
        const first = await driver.chat.create({ messages: [{ role: 'user', content: 'weather?' }], tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }] });
        expect(first.choices[0].finish_reason).toBe('tool_calls');
        const second = await driver.chat.create({ messages: [
            { role: 'user', content: 'weather?' }, first.choices[0].message,
            { role: 'tool', tool_call_id: 'call-1', content: 'sunny' },
        ], tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }] });
        expect(transport.respond).toHaveBeenCalledWith(42, { success: true, contentItems: [{ type: 'inputText', text: 'sunny' }] });
        expect(second.choices[0].message.content).toBe('sunny');
    });

    it('serializes concurrent requests against the shared thread state', async () => {
        const order: string[] = [];
        const run = vi.fn(async () => {
            order.push('start');
            await new Promise(resolve => setTimeout(resolve, 5));
            order.push('end');
            return { stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n' };
        });
        const driver = new LLMDriver({ provider: 'codex', codex: { mode: 'exec', runner: { run } } });
        await Promise.all([
            driver.chat.create({ messages: [{ role: 'user', content: 'a' }] }),
            driver.chat.create({ messages: [{ role: 'user', content: 'b' }] }),
        ]);
        expect(order).toEqual(['start', 'end', 'start', 'end']);
    });

    it('reassembles exec stream events split across chunks', async () => {
        const streamEvents = vi.fn(async function* () {
            yield '{"type":"thread.started","thread_id":"t2"}\n{"type":"item.completed"';
            yield ',"item":{"type":"agent_message","text":"hello"}}\n{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":1}}\n';
        });
        const driver = new LLMDriver({ provider: 'codex', codex: { mode: 'exec', runner: { run: vi.fn(), stream: streamEvents } } });
        const chunks = [];
        for await (const chunk of await driver.chat.create({ messages: [{ role: 'user', content: 'hi' }], stream: true })) chunks.push(chunk);
        expect(chunks.map(c => c.choices[0].delta.content).join('')).toBe('hello');
        expect(chunks.at(-1)?.usage?.total_tokens).toBe(5);
    });

    it('starts a turn with role-prefixed inputs excluding native history', async () => {
        const transport = mockTransport([[{ method: 'turn/completed', params: { threadId: 'thread-app', turn: { status: 'completed' } } }]]);
        const driver = new LLMDriver({ provider: 'codex', codex: { transport } });
        await driver.chat.create({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'one' }] });
        const starts = transport.request.mock.calls.filter(c => c[0] === 'turn/start');
        expect(starts[0][1].input).toEqual([{ type: 'text', text: 'user: one', text_elements: [] }]);
    });
});

describe('AsyncEventHub / rejectPending', () => {
    it('wakes waiters with done on close', async () => {
        const hub = new AsyncEventHub<string>();
        const iterator = hub.subscribe()[Symbol.asyncIterator]();
        const next = iterator.next();
        hub.close();
        await expect(next).resolves.toEqual({ value: undefined, done: true });
    });

    it('rejects every in-flight request', async () => {
        const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
        const first = new Promise((resolve, reject) => pending.set(1, { resolve, reject }));
        const second = new Promise((resolve, reject) => pending.set(2, { resolve, reject }));
        rejectPending(pending, new Error('boom'));
        await expect(first).rejects.toThrow('boom');
        await expect(second).rejects.toThrow('boom');
        expect(pending.size).toBe(0);
    });
});
