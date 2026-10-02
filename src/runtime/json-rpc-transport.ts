// @file: driver-llm/runtime/json-rpc-transport.ts
// Shared newline-delimited JSON-RPC framing for Codex app-server transports.
// Subclasses only provide `writeLine`; inbound line dispatch, pending-request
// tracking, and event delivery are handled here so Node and Tauri transports
// do not duplicate the wire protocol.

import type { CodexAppServerTransport, CodexRPCMessage } from '../types/provider';
import { AsyncEventHub, rejectPending, type PendingRequest } from './async-event-hub';

export abstract class JsonRpcLineTransport implements CodexAppServerTransport {
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly queue = new AsyncEventHub<CodexRPCMessage>();
    protected isClosed = false;

    /** Send one JSON-encoded line to the peer. */
    protected abstract writeLine(line: string): void | Promise<void>;

    /** Send a fire-and-forget JSON-RPC notification (no id). */
    protected notify(method: string, params?: any): void {
        void this.writeLine(JSON.stringify({ method, params }));
    }

    request<T = any>(method: string, params?: any): Promise<T> {
        const id = this.nextId++;
        void this.writeLine(JSON.stringify({ method, id, params }));
        return new Promise<T>((resolve, reject) => {
            const entry: PendingRequest = {
                resolve: value => resolve(value as T),
                reject,
            };
            this.pending.set(id, entry);
        });
    }

    events(): AsyncIterable<CodexRPCMessage> {
        return this.queue.subscribe();
    }

    async respond(id: string | number, result: any): Promise<void> {
        await this.writeLine(JSON.stringify({ id, result }));
    }

    /**
     * Frame one inbound line: responses (id without method) resolve their
     * pending request, notifications (method) are pushed to subscribers.
     */
    protected handleLine(line: string): void {
        if (!line.trim()) return;
        let message: any;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        if (message.id != null && !message.method) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) {
                pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
            } else {
                pending.resolve(message.result);
            }
            return;
        }
        if (message.method) this.queue.push(message);
    }

    /** Reject every in-flight request and stop delivering events (idempotent). */
    protected fail(error: Error): void {
        if (this.isClosed) return;
        this.isClosed = true;
        this.queue.close();
        rejectPending(this.pending, error);
    }

    async close(): Promise<void> {
        this.fail(new Error('Codex app-server transport closed'));
    }
}
