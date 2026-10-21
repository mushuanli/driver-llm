import type { MediaEndpoint, MediaGenerationRequest, MediaGenerationResult, MediaOperation } from '../types';
import type { MediaHTTPConfig } from './http';

export interface MediaAdapter {
    readonly operations: readonly MediaOperation[];
    generate(context: { config: MediaHTTPConfig; endpoint: MediaEndpoint; request: MediaGenerationRequest;
        signal: AbortSignal; requestId: string }): Promise<MediaGenerationResult>;
}
export type MediaAdapterFactory = (id: string) => MediaAdapter | undefined;

/** A runtime owns its registry; later registrations never change an existing snapshot. */
export function createMediaAdapterRegistry(initial: Record<string, MediaAdapter> = {}) {
    const entries = new Map(Object.entries(initial));
    return {
        register(id: string, adapter: MediaAdapter): void {
            if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id) || !adapter.operations.length) throw new Error('Invalid media adapter registration');
            entries.set(id, adapter);
        },
        snapshot(): MediaAdapterFactory {
            const snapshot = new Map(entries);
            return id => snapshot.get(id);
        },
    };
}
