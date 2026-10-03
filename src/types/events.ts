import type { ChatCompletionParams, Citation } from './response';

export interface AgentEventStreamThinking {
    type: 'stream:thinking';
    delta: string;
}

export interface AgentEventStreamContent {
    type: 'stream:content';
    delta: string;
}

export interface AgentEventCitations {
    type: 'citations';
    citations: Citation[];
}

export interface AgentEventLlmRequest {
    type: 'llm:request';
    effectId: string;
    connectionId: string;
    request: Omit<ChatCompletionParams, 'signal'>;
}

/** Events emitted by model communication, before task lifecycle processing. */
export type LlmCommunicationEvent = AgentEventStreamThinking | AgentEventStreamContent | AgentEventCitations | AgentEventLlmRequest;
