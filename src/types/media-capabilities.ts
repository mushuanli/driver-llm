import type { LLMModel, LLMProvider } from './connection';
import type { MediaEndpoint, MediaGenerationRequest, MediaModelCapabilities, MediaOperation } from './media';

export function supportsMediaEndpoint(endpoint: MediaEndpoint | undefined, operation: MediaOperation): boolean {
    if (endpoint?.operation === operation && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(endpoint.adapter)
        && !['openai-images', 'volcengine-images', 'openai-speech', 'doubao-speech'].includes(endpoint.adapter)) return true;
    return operation === 'image.generate' ? endpoint?.adapter === 'openai-images' || endpoint?.adapter === 'volcengine-images'
        : endpoint?.adapter === 'openai-speech' || endpoint?.adapter === 'doubao-speech';
}
/** Categories and audio/vision flags never imply a generation operation. */
export function requireMediaCapabilities(provider: LLMProvider, model: LLMModel, operation: MediaOperation): MediaModelCapabilities {
    if (!supportsMediaEndpoint(provider.media?.[operation], operation)) throw Object.assign(new Error(`Unsupported media adapter: ${operation}`), { code: 'MEDIA_ADAPTER_UNSUPPORTED', stage: 'validation' });
    const caps = model.operations?.[operation];
    if (!caps?.formats?.length) throw Object.assign(new Error(`Model media capability is unknown: ${operation}`), { code: 'MEDIA_CAPABILITY_UNKNOWN', stage: 'validation' });
    const output = operation === 'image.generate' ? 'image' : 'audio';
    if (!caps.inputModalities?.includes('text') || !caps.outputModalities?.includes(output)) throw Object.assign(new Error(`Unsupported media modalities: ${operation}`), { code: 'MEDIA_MODALITY_UNSUPPORTED', stage: 'validation' });
    return caps;
}
export function validateMediaRequest(provider: LLMProvider, request: MediaGenerationRequest): MediaModelCapabilities {
    if (!request || !['image.generate', 'speech.synthesize'].includes(request.operation)) throw Object.assign(new Error('Unsupported media operation'), { code: 'MEDIA_OPERATION_UNSUPPORTED', stage: 'validation' });
    const model = provider.models.find(item => item.id === request.model);
    if (!model) throw Object.assign(new Error('Media request requires a known, explicit model'), { code: 'MEDIA_MODEL_REQUIRED', stage: 'validation' });
    const caps = requireMediaCapabilities(provider, model, request.operation);
    if (!caps.formats.includes(request.format)) throw Object.assign(new Error(`Unsupported media format: ${request.format}`), { code: 'MEDIA_FORMAT_UNSUPPORTED', stage: 'validation' });
    const text = request.operation === 'image.generate' ? request.prompt : request.input;
    if (typeof text !== 'string' || !text.trim() || text.length > (caps.maxInputCharacters ?? 1_000_000)) throw Object.assign(new Error('Invalid media input length'), { code: 'MEDIA_INPUT_LENGTH', stage: 'validation' });
    if (request.operation === 'image.generate') validateImage(request, caps); else validateSpeech(request, caps);
    return caps;
}
function validateImage(request: Extract<MediaGenerationRequest, { operation: 'image.generate' }>, caps: MediaModelCapabilities): void {
    if (!['png', 'jpeg', 'webp'].includes(request.format)) throw Object.assign(new Error('Unsupported image format'), { code: 'MEDIA_FORMAT_UNSUPPORTED', stage: 'validation' });
    const count = request.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > (caps.maxOutputs ?? 1)) throw Object.assign(new Error('Unsupported image count'), { code: 'MEDIA_OUTPUT_COUNT', stage: 'validation' });
    if (request.size !== undefined && !caps.sizes?.includes(request.size)) throw Object.assign(new Error('Image size is unsupported or unknown'), { code: 'MEDIA_IMAGE_SIZE', stage: 'validation' });
    if (request.quality !== undefined && !caps.qualities?.includes(request.quality)) throw Object.assign(new Error('Image quality is unsupported or unknown'), { code: 'MEDIA_IMAGE_QUALITY', stage: 'validation' });
}
function validateSpeech(request: Extract<MediaGenerationRequest, { operation: 'speech.synthesize' }>, caps: MediaModelCapabilities): void {
    if (!['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].includes(request.format)) throw Object.assign(new Error('Unsupported audio format'), { code: 'MEDIA_FORMAT_UNSUPPORTED', stage: 'validation' });
    if (!caps.voices?.includes(request.voice)) throw Object.assign(new Error('Voice is unsupported or unknown'), { code: 'MEDIA_VOICE_UNSUPPORTED', stage: 'validation' });
    if (request.speed !== undefined && (!Number.isFinite(request.speed) || !caps.speedRange
        || request.speed < caps.speedRange.min || request.speed > caps.speedRange.max)) throw Object.assign(new Error('Speech speed is unsupported or unknown'), { code: 'MEDIA_SPEED_UNSUPPORTED', stage: 'validation' });
    if (request.instructions !== undefined && (typeof request.instructions !== 'string' || !caps.features?.includes('instructions')))
        throw Object.assign(new Error('Speech instructions are unsupported or unknown'), { code: 'MEDIA_INSTRUCTIONS_UNSUPPORTED', stage: 'validation' });
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
        && optional(v.operation, operation => operation === key)
        && optional(v.adapterVersion, item => typeof item === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(item))
        && optional(v.path, item => typeof item === 'string' && /^\/(?!\/)[^?#\\]*$/.test(item))
        && optional(v.responseFormat, item => item === 'b64_json' || item === 'url')
        && optional(v.assetHosts, item => strings(item) && (item as string[]).every(host => /^[a-z0-9.-]+$/.test(host) && host.includes('.')))
        && optional(v.outputFormatParameter, item => typeof item === 'boolean')
        && optional(v.sampleRate, item => v.adapter === 'doubao-speech' && [8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(item as number))))) return false;
    return operations === undefined || (record(operations) && Object.entries(operations).every(([key, v]) => known(key) && record(v)
        && ['inputModalities', 'outputModalities', 'formats'].every(field => strings(v[field]) && (v[field] as unknown[]).length > 0)
        && ['voices', 'sizes', 'qualities', 'features'].every(field => optional(v[field], strings))
        && ['maxInputCharacters', 'maxOutputs'].every(field => optional(v[field], positive))
        && optional(v.speedRange, item => record(item) && typeof item.min === 'number' && typeof item.max === 'number'
            && Number.isFinite(item.min) && Number.isFinite(item.max) && item.min > 0 && item.max >= item.min)));
}
