import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMDriver } from '../src/core/driver';

const globalFetch = vi.fn();
global.fetch = globalFetch;

describe('Responses Provider', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('maps messages to input items and extracts instructions', async () => {
        const driver = new LLMDriver({
            connection: { providerId: 'deepseek', protocol: 'openai-responses' },
            apiKey: 'sk-test',
            model: 'deepseek-v4-flash',
        });

        globalFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'resp_1',
                status: 'completed',
                model: 'deepseek-v4-flash',
                output: [
                    { type: 'message', content: [{ type: 'output_text', text: 'Hello!' }] },
                ],
                usage: { input_tokens: 5, output_tokens: 2 },
            }),
        });

        const response = await driver.chat.create({
            messages: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hi' },
            ],
        });

        const body = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(body.model).toBe('deepseek-v4-flash');
        expect(body.instructions).toBe('You are helpful.');
        expect(body.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }]);

        expect(response.choices[0].message.content).toBe('Hello!');
        expect(response.choices[0].finish_reason).toBe('stop');
        expect(response.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    });

    it('converts Chat Completions image objects to Responses image URL strings', async () => {
        const driver = new LLMDriver({ connection: { providerId: 'openai', protocol: 'openai-responses' }, apiKey: 'test', model: 'test' });
        globalFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'r', output: [] }) });
        await driver.chat.create({ messages: [{ role: 'user', content: [
            { type: 'text', text: 'Describe' },
            { type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 'high' } },
        ] }] });
        expect(JSON.parse(globalFetch.mock.calls[0][1].body).input[0].content).toEqual([
            { type: 'input_text', text: 'Describe' },
            { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'high' },
        ]);
        await driver.dispose();
    });

    it('flattens tool schema and normalizes function_call output', async () => {
        const driver = new LLMDriver({
            connection: { providerId: 'deepseek', protocol: 'openai-responses' },
            apiKey: 'sk-test',
            model: 'deepseek-v4-flash',
        });

        globalFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'resp_2',
                status: 'completed',
                model: 'deepseek-v4-flash',
                output: [
                    { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Beijing"}' },
                ],
            }),
        });

        const response = await driver.chat.create({
            messages: [{ role: 'user', content: 'Weather in Beijing?' }],
            tools: [{
                type: 'function',
                function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
            }],
        });

        const body = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(body.tools).toEqual([{
            type: 'function', name: 'get_weather', description: 'Get weather', parameters: { type: 'object' },
        }]);

        expect(response.choices[0].finish_reason).toBe('stop');
        expect(response.choices[0].message.tool_calls).toEqual([{
            id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
        }]);
    });

    it('aggregates semantic SSE deltas into a stream', async () => {
        const driver = new LLMDriver({
            connection: { providerId: 'deepseek', protocol: 'openai-responses' },
            apiKey: 'sk-test',
            model: 'deepseek-v4-flash',
        });

        const encoder = new TextEncoder();
        const sse = [
            'event: response.created\ndata: {"id":"resp_3"}\n\n',
            'event: response.output_text.delta\ndata: {"delta":"Hel"}\n\n',
            'event: response.output_text.delta\ndata: {"delta":"lo"}\n\n',
            'event: response.completed\ndata: {"usage":{"input_tokens":3,"output_tokens":2}}\n\n',
        ].join('');

        globalFetch.mockResolvedValue({
            ok: true,
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(sse));
                    controller.close();
                },
            }),
        });

        const chunks: any[] = [];
        for await (const chunk of (await driver.chat.create({ messages: [{ role: 'user', content: 'tell 10 word story' }], stream: true }))) {
            chunks.push(chunk);
        }

        const content = chunks.flatMap((c: any) => c.choices?.[0]?.delta?.content ?? []);
        expect(JSON.parse(globalFetch.mock.calls[0][1].body)).toMatchObject({ stream: true,
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tell 10 word story' }] }] });

        expect(content.join('')).toBe('Hello');
        expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
        expect(chunks.at(-1).usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2 });
    });

    it('maps status to finish_reason', async () => {
        const driver = new LLMDriver({
            connection: { providerId: 'deepseek', protocol: 'openai-responses' },
            apiKey: 'sk-test',
            model: 'deepseek-v4-flash',
        });

        globalFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'r', status: 'incomplete', model: 'm', output: [] }),
        });

        const response = await driver.chat.create({ messages: [{ role: 'user', content: 'x' }] });
        expect(response.choices[0].finish_reason).toBe('length');
    });
});

describe('DeepSeek API mode (Responses API)', () => {
    const okResponse = {
        ok: true,
        json: async () => ({
            id: 'resp_ds',
            status: 'completed',
            model: 'deepseek-v4-flash',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        }),
    };

    beforeEach(() => {
        vi.resetAllMocks();
    });

    const deepseekDriver = (metadata?: Record<string, unknown>) => new LLMDriver({
        connection: { providerId: 'deepseek', protocol: 'openai-responses', metadata },
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash',
    });

    it('routes to baseURL + responsesPath with Bearer auth', async () => {
        globalFetch.mockResolvedValue(okResponse);

        await deepseekDriver().chat.create({ messages: [{ role: 'user', content: 'Hi' }] });

        // deepseek 目录声明 responsesPath='/responses' → https://api.deepseek.com/responses
        expect(globalFetch.mock.calls[0][0]).toBe('https://api.deepseek.com/responses');
        expect(globalFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test');
    });

    it('maps params.reasoningEffort to reasoning.effort', async () => {
        globalFetch.mockResolvedValue(okResponse);

        await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'Hi' }],
            reasoningEffort: 'xhigh',
        });

        const body = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(body.reasoning).toEqual({ effort: 'xhigh' });
    });

    it('maps connection metadata.reasoningEffort (connection-level setting)', async () => {
        globalFetch.mockResolvedValue(okResponse);

        await deepseekDriver({ reasoningEffort: 'medium' }).chat.create({
            messages: [{ role: 'user', content: 'Hi' }],
        });

        const body = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(body.reasoning).toEqual({ effort: 'medium' });
    });

    it('thinking=false disables reasoning (effort none, DeepSeek defaults thinking ON)', async () => {
        globalFetch.mockResolvedValue(okResponse);

        await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'Hi' }],
            thinking: false,
        });

        const body = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(body.reasoning).toEqual({ effort: 'none' });
    });

    it('omits reasoning when unset (model default thinking behavior)', async () => {
        globalFetch.mockResolvedValue(okResponse);

        await deepseekDriver().chat.create({ messages: [{ role: 'user', content: 'Hi' }] });

        const body = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(body.reasoning).toBeUndefined();
    });

    it('webSearch appends the built-in web_search tool', async () => {
        globalFetch.mockResolvedValue(okResponse);

        await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'Search news' }],
            webSearch: true,
        });

        const body = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(body.tools).toEqual([{ type: 'web_search' }]);
    });

    it('passes through web_search tool definitions without flattening', async () => {
        globalFetch.mockResolvedValue(okResponse);

        await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'Search' }],
            tools: [
                { type: 'web_search' },
                { type: 'function', function: { name: 'get_weather', description: 'Get weather' } },
            ],
        });

        const body = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(body.tools).toEqual([
            { type: 'web_search' },
            { type: 'function', name: 'get_weather', description: 'Get weather', parameters: undefined },
        ]);
    });

    it('converts named function tool_choice to Responses format', async () => {
        globalFetch.mockResolvedValue(okResponse);

        await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'Weather?' }],
            tools: [{ type: 'function', function: { name: 'get_weather' } }],
            toolChoice: { type: 'function', function: { name: 'get_weather' } },
        });

        const body = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(body.tool_choice).toEqual({ type: 'function', name: 'get_weather' });
    });

    it('keeps reasoning off for non-DeepSeek providers (no effort=none mapping)', async () => {
        globalFetch.mockResolvedValue(okResponse);

        const driver = new LLMDriver({
            connection: { providerId: 'openai', protocol: 'openai-responses' },
            apiKey: 'sk-test',
            model: 'gpt-5.5',
        });

        await driver.chat.create({
            messages: [{ role: 'user', content: 'Hi' }],
            thinking: false,
        });

        const body = JSON.parse(globalFetch.mock.calls[0][1].body);
        expect(body.reasoning).toBeUndefined();
    });

    it('maps web_search_call output items to response.citations (unified citation承载)', async () => {
        globalFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'resp_ws',
                status: 'completed',
                model: 'deepseek-v4-flash',
                output: [
                    { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'DeepSeek docs' }, url: 'https://api-docs.deepseek.com' },
                    { type: 'message', content: [{ type: 'output_text', text: 'See docs' }] },
                ],
            }),
        });

        const response = await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'Search DeepSeek docs' }],
            webSearch: true,
        });

        expect(response.citations).toEqual([{
            text: 'DeepSeek docs',
            source: 'web_search',
            url: 'https://api-docs.deepseek.com',
        }]);
        expect(response.choices[0].message.content).toBe('See docs');
    });

    it('omits citations when no web_search_call items exist', async () => {
        globalFetch.mockResolvedValue(okResponse);

        const response = await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'Hi' }],
        });

        expect(response.citations).toBeUndefined();
    });

    it('collects web_search_call from stream terminal response output', async () => {
        const encoder = new TextEncoder();
        const sse = [
            'event: response.created\ndata: {"id":"resp_ws"}\n\n',
            'event: response.output_text.delta\ndata: {"delta":"Here"}\n\n',
            // DeepSeek streams the final response object with usage + output at terminal event
            'event: response.completed\ndata: {"id":"resp_ws","usage":{"input_tokens":3,"output_tokens":2},"output":[{"type":"web_search_call","search_query":"DeepSeek","url":"https://x"}]}\n\n',
        ].join('');

        globalFetch.mockResolvedValue({
            ok: true,
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(sse));
                    controller.close();
                },
            }),
        });

        const chunks: any[] = [];
        for await (const chunk of (await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'search' }],
            stream: true,
        }))) {
            chunks.push(chunk);
        }

        // 终态 chunk 携带 citations（流式采集内置 web_search_call）
        expect(chunks.at(-1).citations).toEqual([
            { text: 'DeepSeek', source: 'web_search', url: 'https://x' },
        ]);
    });

    it('captures usage from nested response object in terminal event (DeepSeek shape)', async () => {
        const encoder = new TextEncoder();
        const sse = [
            'event: response.created\ndata: {"id":"resp_ws"}\n\n',
            'event: response.output_text.delta\ndata: {"delta":"Here"}\n\n',
            // DeepSeek 终态事件把完整 response 嵌套在 response 字段下（usage 在 response.usage）
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ws","usage":{"input_tokens":3,"output_tokens":2,"input_tokens_details":{"cached_tokens":1},"output_tokens_details":{"reasoning_tokens":4}},"output":[{"type":"message","content":[{"type":"output_text","text":"Here"}]}]}}\n\n',
        ].join('');

        globalFetch.mockResolvedValue({
            ok: true,
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(sse));
                    controller.close();
                },
            }),
        });

        const chunks: any[] = [];
        for await (const chunk of (await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'search' }],
            stream: true,
        }))) {
            chunks.push(chunk);
        }

        // 终态 chunk 携带 usage（嵌套在 response 下也能采集，不再恒为 0）
        expect(chunks.at(-1).usage).toEqual({
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
            cached_tokens: 1,
            thinking_tokens: 4,
            details: { reasoning_tokens: 4 },
        });
    });

    it('uses friendly action label when no query present', async () => {
        globalFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'r',
                status: 'completed',
                model: 'deepseek-v4-flash',
                output: [
                    { type: 'web_search_call', action: { type: 'open_page' }, url: 'https://x' },
                ],
            }),
        });

        const response = await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'search' }],
            webSearch: true,
        });

        // 无 query 时 text 用友好动作标签，而非 "open_page"
        expect(response.citations).toEqual([{
            text: '打开链接', source: 'web_search', url: 'https://x',
        }]);
    });

    it('extracts queries from action.queries (plural) and filters ws_call_id pseudo-entries', async () => {
        globalFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'r',
                status: 'completed',
                model: 'deepseek-v4-flash',
                output: [
                    {
                        type: 'web_search_call',
                        id: 'call_00',
                        status: 'completed',
                        action: {
                            type: 'search',
                            queries: ['DeepSeek 最新版本 发布 今天', 'DeepSeek release latest version', 'ws_call_id=call_00'],
                        },
                    },
                ],
            }),
        });

        const response = await deepseekDriver().chat.create({
            messages: [{ role: 'user', content: 'search' }],
            webSearch: true,
        });

        expect(response.citations).toEqual([{
            text: 'DeepSeek 最新版本 发布 今天；DeepSeek release latest version',
            source: 'web_search',
        }]);
    });
});
