import { LLMError, LLMErrorCode } from '../errors';

/** Preserve why an abort happened even when a transport replaces signal.reason. */
export class RequestCancellation {
    readonly controller = new AbortController();
    private timer?: ReturnType<typeof setTimeout>;
    private readonly onAbort = () => this.controller.abort(new LLMError('Request aborted', {
        code: LLMErrorCode.ABORTED, provider: this.provider, retryable: false, cause: this.parent?.reason,
    }));

    constructor(private readonly provider: string, private readonly timeout: number, private readonly parent?: AbortSignal) {
        if (parent?.aborted) this.onAbort();
        else parent?.addEventListener('abort', this.onAbort, { once: true });
        this.reset();
    }

    reset(): void {
        clearTimeout(this.timer);
        if (this.controller.signal.aborted) return;
        this.timer = setTimeout(() => this.controller.abort(new LLMError(`Request timed out after ${this.timeout} ms without a response`, {
            code: LLMErrorCode.TIMEOUT, provider: this.provider, retryable: true,
        })), this.timeout);
    }

    error(error: unknown): unknown {
        return this.controller.signal.aborted ? this.controller.signal.reason : error;
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.parent?.removeEventListener('abort', this.onAbort);
    }
}
