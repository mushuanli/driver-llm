// @file: driver-llm/utils/stream.ts

export interface SSEEvent {
    event?: string;
    data: string;
}

/**
 * 解析 SSE 流
 *
 * @param stream ReadableStream
 * @yields 每个 data 事件的内容
 */
export async function* parseSSEStream(
    stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
    for await (const item of parseEventStream(stream)) {
        yield item.data;
    }
}

/**
 * 解析语义化 SSE 流 — 保留 event 字段。
 *
 * OpenAI Responses API 每个事件含 `event:` 行（事件类型）+ `data:` 行（JSON 载荷），
 * 无 `[DONE]` 终止符。与 Chat Completions 的纯 `data:` 行格式不同。
 *
 * @param stream ReadableStream
 * @yields { event, data } — event 为 `event:` 值（如 response.output_text.delta），data 为 JSON 字符串
 */
export async function* parseEventStream(
    stream: ReadableStream<Uint8Array>
): AsyncGenerator<SSEEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent: string | undefined;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;

                if (trimmed.startsWith('event:')) {
                    currentEvent = trimmed.slice(6).trim();
                } else if (trimmed.startsWith('data:')) {
                    const data = trimmed.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    yield { event: currentEvent, data };
                    currentEvent = undefined;
                }
            }
        }

        if (buffer.trim()) {
            const trimmed = buffer.trim();
            if (trimmed.startsWith('data:')) {
                const data = trimmed.slice(5).trim();
                if (data && data !== '[DONE]') {
                    yield { event: currentEvent, data };
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * 创建可取消的流
 */
export function createCancellableStream<T>(
    stream: AsyncGenerator<T>,
    signal?: AbortSignal
): AsyncGenerator<T> {
    if (!signal) return stream;
    
    return (async function* () {
        for await (const chunk of stream) {
            if (signal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            yield chunk;
        }
    })();
}

/**
 * 合并多个流
 */
export async function* mergeStreams<T>(
    streams: AsyncGenerator<T>[]
): AsyncGenerator<T> {
    const iterators = streams.map(s => s[Symbol.asyncIterator]());
    const pending = new Set(iterators.map((it, i) => ({ iterator: it, index: i })));
    
    while (pending.size > 0) {
        const promises = Array.from(pending).map(async ({ iterator, index }) => {
            const result = await iterator.next();
            return { result, index, iterator };
        });
        
        const { result, index, iterator } = await Promise.race(promises);
        
        if (result.done) {
            pending.delete({ iterator, index });
        } else {
            yield result.value;
        }
    }
}
