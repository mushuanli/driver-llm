/** Driver-owned communication DTOs. Context/history types are mapped by the caller. */

export type Role = 'system' | 'user' | 'assistant' | 'tool' | 'developer';

// ─── Message Content Parts ────────────────────────────────────────────────────

export interface MessageContentText {
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
}

export interface MessageContentImage {
    type: 'image_url' | 'image';
    // OpenAI format
    image_url?: { url: string; detail?: string; [key: string]: unknown };
    // Anthropic format (source can be an object or url string)
    source?: string | { type: string; media_type?: string; data?: string; url?: string; [key: string]: unknown };
}

export interface MessageContentAudio {
    type: 'input_audio' | 'audio';
    input_audio?: { data: string; format: string };
    transcript?: string;
}

export interface MessageContentVideo {
    type: 'video';
    video: {
        source?: string | { type: string; media_type?: string; data?: string; [key: string]: unknown };
        url?: string;
        file_id?: string;
        data?: string;
        mime_type?: string;
        duration?: number;
        [key: string]: unknown;
    };
}

export interface FileData {
    source?: string | { type: string; media_type?: string; data?: string; [key: string]: unknown };
    url?: string;
    file_id?: string;
    data?: string;
    filename?: string;
    mime_type?: string;
    [key: string]: unknown;
}

export interface MessageContentFile {
    type: 'file' | 'document';
    file?: FileData;
    document?: FileData;
}

export interface MessageContentToolResult {
    type: 'tool_result';
    tool_use_id: string;
    content: string | MessageContentPart[];
    is_error?: boolean;
}

export interface MessageContentCodeExecution {
    type: 'code_execution_result';
    id?: string;
    output?: string;
    error?: string;
}

export interface MessageContentCitation {
    type: 'citation';
    text: string;
    source?: string;
    page?: number;
}

/** Anthropic thinking block — carries signature for chain integrity. */
export interface MessageContentThinking {
    type: 'thinking';
    thinking: string;
    signature: string;
}

/** Anthropic tool_use block — represents an assistant-initiated tool call. */
export interface MessageContentToolUse {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export type MessageContentPart =
    | MessageContentText
    | MessageContentImage
    | MessageContentAudio
    | MessageContentVideo
    | MessageContentFile
    | MessageContentToolResult
    | MessageContentCodeExecution
    | MessageContentCitation
    | MessageContentThinking
    | MessageContentToolUse;

export type MessageContent = string | MessageContentPart[];

// ─── Tool Calls ───────────────────────────────────────────────────────────────

export interface ToolDefinition {
    type?: 'function' | 'computer_20241022' | 'bash_20241022' | 'text_editor_20241022' | 'mcp';
    function?: {
        name: string;
        description?: string;
        parameters?: Record<string, any>;
        strict?: boolean;
    };
    // Anthropic built-in tools
    name?: string;
    display_width_px?: number;
    display_height_px?: number;
    display_number?: number;
    computer_use?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface ToolCall {
    id: string;
    index?: number;
    type: 'function' | 'computer_20241022' | 'bash_20241022' | 'text_editor_20241022' | 'mcp';
    function?: { name?: string; arguments: string };
    // Anthropic computer use
    name?: string;
    input?: Record<string, unknown>;
    // MCP tool call
    mcp?: { server_name: string; tool_name: string; arguments?: Record<string, unknown> };
    // Computer use action
    computer_use?: Record<string, unknown>;
}

export interface MCPToolCall {
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
}

export interface ComputerUseAction {
    type: 'screenshot' | 'mouse_move' | 'left_click' | 'right_click' | 'double_click'
        | 'left_click_drag' | 'type' | 'key' | 'scroll' | 'cursor_position';
    coordinate?: [number, number];
    text?: string;
    start_coordinate?: [number, number];
    direction?: 'up' | 'down';
    amount?: number;
}

// ─── Attachment ───────────────────────────────────────────────────────────────

/** Attachment category. */
export type AttachmentType = 'image' | 'audio' | 'video' | 'file' | 'text';

export interface Attachment {
    name?: string;
    /** Attachment category. */
    type: AttachmentType;
    /** Convenience input; normalize binary sources into content before JSON serialization. */
    source: string | File | Blob | ArrayBuffer;
    size?: number;
    filename?: string;
    /** MIME type used when normalizing the source. */
    mimeType?: string;
    options?: Record<string, any>;
}

// ─── Chat Message ─────────────────────────────────────────────────────────────

export interface ChatMessage {
    role: Role;
    content: MessageContent;
    /** Provider reasoning retained when continuing an assistant tool-call turn. */
    thinking?: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    audio?: { id?: string; data?: string; transcript?: string };
    attachments?: Attachment[];
    cache_control?: { type: 'ephemeral' };
    tags?: string[];
}
