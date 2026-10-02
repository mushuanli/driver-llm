// @file: driver-llm/providers/codex/index.ts
// CodexProvider facade: selects between the one-shot `exec` adapter and the
// persistent `app-server` adapter, and serializes calls (the app-server thread
// state is not concurrency-safe; exec is serialized for parity).

import type {
    ChatCompletionChunk,
    ChatCompletionParams,
    ChatCompletionResponse,
    LLMProviderConfig,
    ProviderCapabilities,
} from '../../types';
import { BaseProvider } from '../base';
import { CodexExecAdapter } from './exec-adapter';
import { CodexAppServerAdapter } from './app-server-adapter';

/** Adapter from the local Codex CLI to the provider-neutral chat completion API. */
export class CodexProvider extends BaseProvider {
    readonly name = 'codex';
    // Capabilities reflect the app-server mode; the legacy `exec` mode is a
    // subset (e.g. audio input is rejected there — see validateCodexParams).
    readonly capabilities: ProviderCapabilities = {
        vision: true,
        documents: true,
        audioInput: true,
        tools: true,
        structuredOutput: true,
        jsonMode: true,
        streaming: true,
        thinking: true,
        codeExecution: true,
        mcp: true,
    };

    private readonly execAdapter: CodexExecAdapter;
    private readonly appServerAdapter: CodexAppServerAdapter;
    private mutex: Promise<void> = Promise.resolve();

    constructor(config: LLMProviderConfig) {
        super(config);
        this.execAdapter = new CodexExecAdapter(config);
        this.appServerAdapter = new CodexAppServerAdapter(config);
    }

    private get mode(): 'exec' | 'app-server' {
        return this.config.codex?.mode === 'exec' ? 'exec' : 'app-server';
    }

    async create(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
        const release = await this.acquire();
        try {
            return await (this.mode === 'exec'
                ? this.execAdapter.create(params)
                : this.appServerAdapter.create(params));
        } finally {
            release();
        }
    }

    async *stream(params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
        const release = await this.acquire();
        try {
            yield* this.mode === 'exec'
                ? this.execAdapter.stream(params)
                : this.appServerAdapter.stream(params);
        } finally {
            release();
        }
    }

    /** Release provider-held resources (a lazily-started local app-server). */
    async dispose(): Promise<void> {
        await this.appServerAdapter.dispose();
    }

    /** Serialize create/stream per instance — see the class docstring. */
    private async acquire(): Promise<() => void> {
        let release!: () => void;
        const previous = this.mutex;
        this.mutex = new Promise<void>(resolve => { release = resolve; });
        await previous;
        return release;
    }
}
