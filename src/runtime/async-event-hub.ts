// @file: driver-llm/src/runtime/async-event-hub.ts
// Shared async event hub used by Codex app-server transports (Node stdio and
// Tauri bridge). Keeps the "buffered subscriber + async iterator" pattern in
// one place instead of duplicating it per transport.

export interface EventSubscriber<T> {
    values: T[];
    waiters: Array<(result: IteratorResult<T>) => void>;
}

export class AsyncEventHub<T> {
    private readonly subscribers = new Set<EventSubscriber<T>>();
    private closed = false;

    push(value: T): void {
        if (this.closed) return;
        for (const sub of this.subscribers) {
            const waiter = sub.waiters.shift();
            if (waiter) waiter({ value, done: false });
            else sub.values.push(value);
        }
    }

    subscribe(): AsyncIterable<T> {
        const sub: EventSubscriber<T> = { values: [], waiters: [] };
        this.subscribers.add(sub);
        return {
            [Symbol.asyncIterator]: () => ({
                next: (): Promise<IteratorResult<T>> => {
                    const value = sub.values.shift();
                    if (value !== undefined) return Promise.resolve({ value, done: false });
                    if (this.closed) return Promise.resolve({ value: undefined, done: true });
                    return new Promise(resolve => sub.waiters.push(resolve));
                },
                return: async (): Promise<IteratorResult<T>> => {
                    this.subscribers.delete(sub);
                    return { value: undefined, done: true };
                },
            }),
        };
    }

    /** Wake all waiters with done and drop subscribers. */
    close(): void {
        this.closed = true;
        for (const sub of this.subscribers) {
            for (const waiter of sub.waiters) waiter({ value: undefined, done: true });
            sub.waiters.length = 0;
        }
        this.subscribers.clear();
    }
}

export interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: Error): void;
}

/** Reject every in-flight request (used when a transport dies). */
export function rejectPending(
    pending: Map<number, PendingRequest>,
    error: Error,
): void {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
}
