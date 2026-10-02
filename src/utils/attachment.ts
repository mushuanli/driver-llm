// @file: driver-llm/utils/attachment.ts

import { blobToBase64, arrayBufferToBase64 } from './base64';
import type {
    MessageContentPart,
    MessageContentText,
    MessageContentImage,
    MessageContentAudio,
    MessageContentVideo,
    MessageContentFile,
    Attachment,
    AttachmentType,
} from '../types/message';

// ─── 公共类型 ─────────────────────────────────────────────────────────────────

/**
 * 附件处理结果
 */
export interface ProcessedAttachment {
    mimeType: string;
    base64: string;
    filename?: string;
    size?: number;
}

/**
 * 支持的媒体类型
 */
export const SUPPORTED_MEDIA_TYPES = {
    image: [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    ] as const,
    audio: [
        'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/webm',
    ] as const,
    video: [
        'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
    ] as const,
    text: [
        'text/plain', 'text/markdown', 'text/csv', 'text/html',
        'text/xml', 'text/css', 'text/javascript',
        'application/json', 'application/xml', 'application/yaml',
    ] as const,
    document: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ] as const,
} as const;

/** 所有 text 类型的 MIME 集合（用于快速查找） */
const TEXT_MIME_SET: ReadonlySet<string> = new Set(SUPPORTED_MEDIA_TYPES.text);

// ─── 底层：processAttachment（二进制 → base64）──────────────────────────────

/**
 * 处理附件为 Base64 格式。
 *
 * 支持输入：
 * - Data URI
 * - HTTP URL
 * - File / Blob
 * - ArrayBuffer
 * - Base64 字符串
 */
export async function processAttachment(
    source: string | File | Blob | ArrayBuffer,
    options?: {
        fallbackMimeType?: string;
        maxSize?: number;
        allowedTypes?: readonly string[];
    },
): Promise<ProcessedAttachment> {
    const {
        fallbackMimeType = 'application/octet-stream',
        maxSize,
        allowedTypes,
    } = options ?? {};

    let mimeType: string;
    let base64: string;
    let filename: string | undefined;
    let size: number | undefined;

    // Data URI
    if (typeof source === 'string' && source.startsWith('data:')) {
        const match = source.match(/^data:(.+?);base64,(.+)$/);
        if (!match) throw new Error('Invalid data URI format');
        mimeType = match[1];
        base64 = match[2];
        size = Math.ceil((base64.length * 3) / 4);
    }
    // HTTP URL
    else if (typeof source === 'string' && source.startsWith('http')) {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
        const blob = await response.blob();
        mimeType = response.headers.get('content-type')?.split(';')[0] || fallbackMimeType;
        base64 = await blobToBase64(blob);
        size = blob.size;

        // 尝试从 URL 提取文件名
        const urlPath = new URL(source).pathname;
        filename = urlPath.split('/').pop() || undefined;
    }
    // Base64 字符串
    else if (typeof source === 'string') {
        mimeType = fallbackMimeType;
        base64 = source;
        size = Math.ceil((base64.length * 3) / 4);
    }
    // File
    else if (source instanceof File) {
        mimeType = source.type || fallbackMimeType;
        base64 = await blobToBase64(source);
        filename = source.name;
        size = source.size;
    }
    // Blob
    else if (source instanceof Blob) {
        mimeType = source.type || fallbackMimeType;
        base64 = await blobToBase64(source);
        size = source.size;
    }
    // ArrayBuffer
    else if (source instanceof ArrayBuffer) {
        mimeType = fallbackMimeType;
        base64 = arrayBufferToBase64(source);
        size = source.byteLength;
    }
    else {
        throw new Error('Unsupported attachment source type');
    }

    // 大小检查
    if (maxSize && size && size > maxSize) {
        throw new Error(`Attachment size ${size} exceeds maximum ${maxSize}`);
    }

    // 类型检查
    if (allowedTypes && !allowedTypes.includes(mimeType)) {
        throw new Error(`MIME type ${mimeType} is not allowed. Allowed: ${allowedTypes.join(', ')}`);
    }

    return { mimeType, base64, filename, size };
}

// ─── 底层：readTextSource（各种来源 → 纯文本字符串）────────────────────────

/**
 * 将各种数据源读取为纯文本字符串。
 *
 * 支持：纯文本字符串、Data URI、HTTP URL、File/Blob、ArrayBuffer
 */
export async function readTextSource(
    source: string | File | Blob | ArrayBuffer,
): Promise<string> {
    // 纯文本字符串（非 URL、非 Data URI）
    if (typeof source === 'string' && !source.startsWith('data:') && !source.startsWith('http')) {
        return source;
    }

    // Data URI
    if (typeof source === 'string' && source.startsWith('data:')) {
        const match = source.match(/^data:(.+?);base64,(.+)$/);
        if (match) {
            return new TextDecoder().decode(Uint8Array.from(atob(match[2]), char => char.charCodeAt(0)));
        }
        // 非 base64 的 data URI，直接返回逗号后内容
        const commaIdx = source.indexOf(',');
        return commaIdx >= 0 ? decodeURIComponent(source.slice(commaIdx + 1)) : source;
    }

    // HTTP URL
    if (typeof source === 'string' && source.startsWith('http')) {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`Failed to fetch text: ${response.statusText}`);
        return response.text();
    }

    // File / Blob
    if (source instanceof File || source instanceof Blob) {
        return source.text();
    }

    // ArrayBuffer
    if (source instanceof ArrayBuffer) {
        return new TextDecoder().decode(source);
    }

    throw new Error('Unsupported text source type');
}

// ─── 检测函数 ─────────────────────────────────────────────────────────────────

/**
 * 根据 MIME type 检测媒体类型分类
 */
export function detectMediaType(
    mimeType: string,
): 'image' | 'audio' | 'video' | 'text' | 'document' | 'unknown' {
    if ((SUPPORTED_MEDIA_TYPES.image as readonly string[]).includes(mimeType)) return 'image';
    if ((SUPPORTED_MEDIA_TYPES.audio as readonly string[]).includes(mimeType)) return 'audio';
    if ((SUPPORTED_MEDIA_TYPES.video as readonly string[]).includes(mimeType)) return 'video';
    if ((SUPPORTED_MEDIA_TYPES.text as readonly string[]).includes(mimeType)) return 'text';
    if ((SUPPORTED_MEDIA_TYPES.document as readonly string[]).includes(mimeType)) return 'document';
    // 兜底：任何 text/* MIME 均视为文本
    if (mimeType.startsWith('text/')) return 'text';
    return 'unknown';
}

/**
 * 检查是否为支持的视觉内容
 */
export function isSupportedVisionContent(mimeType: string): boolean {
    return (SUPPORTED_MEDIA_TYPES.image as readonly string[]).includes(mimeType);
}

/**
 * 检查是否为支持的音频内容
 */
export function isSupportedAudioContent(mimeType: string): boolean {
    return (SUPPORTED_MEDIA_TYPES.audio as readonly string[]).includes(mimeType);
}

/**
 * 检查是否为支持的视频内容
 */
export function isSupportedVideoContent(mimeType: string): boolean {
    return (SUPPORTED_MEDIA_TYPES.video as readonly string[]).includes(mimeType);
}

/**
 * 检查是否为支持的文本内容
 */
export function isSupportedTextContent(mimeType: string): boolean {
    return TEXT_MIME_SET.has(mimeType) || mimeType.startsWith('text/');
}

// ─── Builder 函数：各类型 → MessageContentPart ────────────────────────────────

/**
 * 构建文本消息内容。
 *
 * 将文本附件（纯文本、File、Blob、URL 等）转换为 MessageContentText。
 * 支持可选的 label / filename 作为前缀标注，便于 LLM 区分多段引用文本。
 */
export async function buildTextContent(
    source: string | File | Blob | ArrayBuffer,
    options?: {
        /** 在文本前添加标签（如文件名），格式: `[label]:\n<content>` */
        label?: string;
        /** 最大字符数，超出则截断并附加省略提示 */
        maxLength?: number;
        /** 截断时的省略提示 */
        truncationSuffix?: string;
    },
): Promise<MessageContentText> {
    const {
        label,
        maxLength,
        truncationSuffix = '\n... [truncated]',
    } = options ?? {};

    let text = await readTextSource(source);

    // 截断保护
    if (maxLength && text.length > maxLength) {
        text = text.slice(0, maxLength) + truncationSuffix;
    }

    // 可选 label 前缀
    if (label) {
        text = `[${label}]:\n${text}`;
    }

    return { type: 'text', text };
}

/**
 * 构建图片消息内容 — 增强版
 */
export async function buildImageContent(
    source: string | File | Blob,
    options?: {
        detail?: 'auto' | 'low' | 'high';
        format?: 'openai' | 'anthropic' | 'gemini';
    },
): Promise<MessageContentImage> {
    const { detail, format = 'openai' } = options ?? {};

    // 如果已经是 URL，直接使用
    if (typeof source === 'string' && (source.startsWith('http') || source.startsWith('data:'))) {
        if (format === 'anthropic' && source.startsWith('data:')) {
            const [header, data] = source.split(',');
            const mediaType = header.match(/data:(.*?);/)?.[1] || 'image/jpeg';
            return {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: mediaType,
                    data,
                },
            };
        }

        return {
            type: 'image_url',
            image_url: { url: source, detail },
        };
    }

    // 转换为 Base64
    const { mimeType, base64 } = await processAttachment(source, {
        allowedTypes: SUPPORTED_MEDIA_TYPES.image,
    });

    if (format === 'anthropic') {
        return {
            type: 'image',
            source: {
                type: 'base64',
                media_type: mimeType,
                data: base64,
            },
        };
    }

    const dataUri = `data:${mimeType};base64,${base64}`;
    return {
        type: 'image_url',
        image_url: { url: dataUri, detail },
    };
}

/**
 * 构建音频消息内容
 */
export async function buildAudioContent(
    source: string | File | Blob | ArrayBuffer,
    options?: {
        format?: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16';
    },
): Promise<MessageContentAudio> {
    const { mimeType, base64 } = await processAttachment(source, {
        allowedTypes: SUPPORTED_MEDIA_TYPES.audio,
    });

    type AudioFormat = 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16';

    let format: AudioFormat;

    if (options?.format) {
        format = options.format;
    } else {
        const formatMap: Record<string, AudioFormat> = {
            'audio/wav': 'wav',
            'audio/mp3': 'mp3',
            'audio/mpeg': 'mp3',
            'audio/flac': 'flac',
            'audio/ogg': 'opus',
        };
        format = formatMap[mimeType] ?? 'wav';
    }

    return {
        type: 'input_audio',
        input_audio: { data: base64, format },
    };
}

/**
 * 构建视频消息内容
 */
export async function buildVideoContent(
    source: string | File | Blob,
    options?: {
        duration?: number;
    },
): Promise<MessageContentVideo> {
    // URL 直接使用
    if (typeof source === 'string' && source.startsWith('http')) {
        return {
            type: 'video',
            video: {
                source: 'url',
                url: source,
                duration: options?.duration,
            },
        };
    }

    const { mimeType, base64 } = await processAttachment(source, {
        allowedTypes: SUPPORTED_MEDIA_TYPES.video,
    });

    return {
        type: 'video',
        video: {
            source: 'base64',
            data: base64,
            mime_type: mimeType,
            duration: options?.duration,
        },
    };
}

/**
 * 构建文件消息内容（二进制文件，如 PDF / Office 文档等）
 */
export async function buildFileContent(
    source: string | File | Blob,
    options?: {
        filename?: string;
    },
): Promise<MessageContentFile> {
    // URL 直接使用
    if (typeof source === 'string' && source.startsWith('http')) {
        return {
            type: 'file',
            file: {
                source: 'url',
                url: source,
                filename: options?.filename,
            },
        };
    }

    const { mimeType, base64, filename } = await processAttachment(source);

    return {
        type: 'file',
        file: {
            source: 'base64',
            data: base64,
            mime_type: mimeType,
            filename: options?.filename || filename,
        },
    };
}

// ─── Attachment → MessageContentPart 转换 ─────────────────────────────────────

/**
 * 根据 Attachment.type 和可选的 mimeType 推断实际处理类型。
 *
 * 当 `attachment.type === 'file'` 且 `attachment.mimeType` 为文本类 MIME 时，
 * 自动降级为 `'text'` 处理，而非发送二进制 file content part。
 */
function resolveAttachmentType(attachment: Attachment): AttachmentType {
    const declared = attachment.type;
    const mime = attachment.mimeType;

    // 显式声明 text → 直接走 text 路径
    if (declared === 'text') return 'text';

    // 声明为 file 但 MIME 是文本类 → 降级为 text
    if (declared === 'file' && mime && isSupportedTextContent(mime)) {
        return 'text';
    }

    return declared;
}

/**
 * 将单个 Attachment 转换为 MessageContentPart。
 *
 * 根据 attachment.type（text / image / audio / video / file）选择对应的 builder；
 * 对于 type='file' 但 mimeType 为文本类的附件，自动降级为 text content part。
 */
export async function attachmentToContentPart(
    attachment: Attachment,
    providerFormat?: 'openai' | 'anthropic' | 'gemini',
): Promise<MessageContentPart> {
    const effectiveType = resolveAttachmentType(attachment);

    switch (effectiveType) {
        case 'text':
            return buildTextContent(attachment.source, {
                label: attachment.filename ?? attachment.name,
            });

        case 'image':
            return buildImageContent(attachment.source as string | File | Blob, {
                detail: attachment.options?.detail,
                format: providerFormat,
            });

        case 'audio':
            return buildAudioContent(attachment.source, {
                format: attachment.options?.format as any,
            });

        case 'video':
            return buildVideoContent(attachment.source as string | File | Blob);

        case 'file':
            return buildFileContent(attachment.source as string | File | Blob, {
                filename: attachment.filename,
            });

        default:
            throw new Error(`Unsupported attachment type: ${attachment.type}`);
    }
}

/**
 * 批量处理附件 → MessageContentPart[]
 */
export async function processAttachments(
    attachments: Attachment[],
    providerFormat?: 'openai' | 'anthropic' | 'gemini',
): Promise<MessageContentPart[]> {
    return Promise.all(
        attachments.map(att => attachmentToContentPart(att, providerFormat)),
    );
}

// ─── 消息级附件展开 ──────────────────────────────────────────────────────────

/**
 * 将 ChatMessage.attachments 展开为 multipart content。
 *
 * 如果消息同时包含 `content`（字符串）和 `attachments`，
 * 将 content 转为 text part，附件转为对应的 content part，
 * 合并成 `MessageContentPart[]` 返回新消息（不修改原消息）。
 *
 * 如果没有 attachments 或 attachments 为空，返回原消息不变。
 */
export async function expandMessageAttachments(
    message: import('../types').ChatMessage,
    providerFormat?: 'openai' | 'anthropic' | 'gemini',
): Promise<import('../types').ChatMessage> {
    if (!message.attachments || message.attachments.length === 0) {
        return message;
    }

    const parts: import('../types').MessageContentPart[] = [];

    // 1. 保留原始 content
    if (typeof message.content === 'string' && message.content.length > 0) {
        parts.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
        parts.push(...message.content);
    }

    // 2. 展开 attachments
    const attachmentParts = await processAttachments(message.attachments, providerFormat);
    parts.push(...attachmentParts);

    // 3. 返回新消息（移除 attachments 字段，内容已内联）
    const { attachments: _, ...rest } = message;
    return { ...rest, content: parts };
}

/**
 * 批量展开消息列表中的附件。
 */
export async function expandMessagesAttachments(
    messages: import('../types').ChatMessage[],
    providerFormat?: 'openai' | 'anthropic' | 'gemini',
): Promise<import('../types').ChatMessage[]> {
    return Promise.all(
        messages.map(m => expandMessageAttachments(m, providerFormat)),
    );
}
