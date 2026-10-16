import type { LLMModel, LLMProvider } from './connection';
import type { MediaEndpoint, MediaGenerationRequest, MediaModelCapabilities, MediaOperation } from './media';

export function supportsMediaEndpoint(endpoint: MediaEndpoint | undefined, operation: MediaOperation): boolean {
    return endpoint?.adapter === (operation === 'image.generate' ? 'openai-images' : 'openai-speech');
}
/** Categories and audio/vision flags never imply a generation operation. */
export function requireMediaCapabilities(provider: LLMProvider, model: LLMModel, operation: MediaOperation): MediaModelCapabilities {
    if (!supportsMediaEndpoint(provider.media?.[operation], operation)) throw new Error(`Unsupported media adapter: ${operation}`);
    const caps = model.operations?.[operation];
    if (!caps?.formats?.length) throw new Error(`Model media capability is unknown: ${operation}`);
    const output = operation === 'image.generate' ? 'image' : 'audio';
    if (!caps.inputModalities?.includes('text') || !caps.outputModalities?.includes(output)) throw new Error(`Unsupported media modalities: ${operation}`);
    return caps;
}
export function validateMediaRequest(provider: LLMProvider, request: MediaGenerationRequest): MediaModelCapabilities {
    if (!request || !['image.generate', 'speech.synthesize'].includes(request.operation)) throw new Error('Unsupported media operation');
    const model = provider.models.find(item => item.id === request.model);
    if (!model) throw new Error('Media request requires a known, explicit model');
    const caps = requireMediaCapabilities(provider, model, request.operation);
    if (!caps.formats.includes(request.format)) throw new Error(`Unsupported media format: ${request.format}`);
    const text = request.operation === 'image.generate' ? request.prompt : request.input;
    if (typeof text !== 'string' || !text.trim() || text.length > (caps.maxInputCharacters ?? 1_000_000)) throw new Error('Invalid media input length');
    if (request.operation === 'image.generate') validateImage(request, caps); else validateSpeech(request, caps);
    return caps;
}
function validateImage(request: Extract<MediaGenerationRequest, { operation: 'image.generate' }>, caps: MediaModelCapabilities): void {
    if (!['png', 'jpeg', 'webp'].includes(request.format)) throw new Error('Unsupported image format');
    const count = request.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > (caps.maxOutputs ?? 1)) throw new Error('Unsupported image count');
    if (request.size !== undefined && !caps.sizes?.includes(request.size)) throw new Error('Image size is unsupported or unknown');
    if (request.quality !== undefined && !caps.qualities?.includes(request.quality)) throw new Error('Image quality is unsupported or unknown');
}
function validateSpeech(request: Extract<MediaGenerationRequest, { operation: 'speech.synthesize' }>, caps: MediaModelCapabilities): void {
    if (!['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].includes(request.format)) throw new Error('Unsupported audio format');
    if (!caps.voices?.includes(request.voice)) throw new Error('Voice is unsupported or unknown');
    if (request.speed !== undefined && (!Number.isFinite(request.speed) || !caps.speedRange
        || request.speed < caps.speedRange.min || request.speed > caps.speedRange.max)) throw new Error('Speech speed is unsupported or unknown');
    if (request.instructions !== undefined && (typeof request.instructions !== 'string' || !caps.features?.includes('instructions')))
        throw new Error('Speech instructions are unsupported or unknown');
}
/** Validate catalog declarations without loading a network client. */
export function isMediaCatalog(media: unknown, operations: unknown): boolean {
    const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const strings = (v: unknown) => Array.isArray(v) && v.every(item => typeof item === 'string' && !!item.trim());
    const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
    const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
    const known = (key: string) => ['image.generate', 'speech.synthesize'].includes(key);
    if (media !== undefined && (!record(media) || !Object.entries(media).every(([key, v]) => known(key) && record(v)
        && supportsMediaEndpoint(v as unknown as MediaEndpoint, key as MediaOperation)
        && optional(v.path, item => typeof item === 'string' && /^\/(?!\/)[^?#\\]*$/.test(item))
        && optional(v.responseFormat, item => item === 'b64_json')
        && optional(v.outputFormatParameter, item => typeof item === 'boolean')))) return false;
    return operations === undefined || (record(operations) && Object.entries(operations).every(([key, v]) => known(key) && record(v)
        && ['inputModalities', 'outputModalities', 'formats'].every(field => strings(v[field]) && (v[field] as unknown[]).length > 0)
        && ['voices', 'sizes', 'qualities', 'features'].every(field => optional(v[field], strings))
        && ['maxInputCharacters', 'maxOutputs'].every(field => optional(v[field], positive))
        && optional(v.speedRange, item => record(item) && typeof item.min === 'number' && typeof item.max === 'number'
            && Number.isFinite(item.min) && Number.isFinite(item.max) && item.min > 0 && item.max >= item.min)));
}
