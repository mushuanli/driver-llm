import type { LLMModel } from '../types';
import { isReasoningCapabilities } from '../types/reasoning';
import { isMediaCatalog } from '../types/media-capabilities';
import { arkCatalogDeclarations } from './catalog-ark';

const fields = ['supportsVision', 'supportsThinking', 'supportsTools', 'supportsAudio', 'supportsVideo', 'supportsStructuredOutput'] as const;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;

/** Preserve affirmative, negative and unknown declarations without guessing from model names. */
export function catalogCapabilities(row: Record<string, unknown>): Partial<LLMModel> {
    row = {...Object.fromEntries(Object.entries(arkCatalogDeclarations(row)).filter(([, value]) => value !== undefined)), ...row};
    const caps = strings(row.capabilities) ? Object.fromEntries(strings(row.capabilities)!.map(key => [key, true])) : record(row.capabilities);
    const architecture = record(row.architecture), parameters = strings(row.supported_parameters);
    const input = strings(row.input_modalities ?? architecture.input_modalities ?? caps.input_modalities), output = strings(row.output_modalities ?? architecture.output_modalities ?? caps.output_modalities);
    const result = declaredFlags(row, caps);
    if (input) {result.supportsVision ??= input.includes('image'); result.supportsAudio ??= input.includes('audio'); result.supportsVideo ??= input.includes('video');}
    if (parameters) {result.supportsTools ??= parameters.includes('tools'); result.supportsThinking ??= parameters.includes('reasoning');
        result.supportsStructuredOutput ??= parameters.includes('response_format') || parameters.includes('structured_outputs');}
    if (['chat', 'image', 'audio', 'video', 'embedding'].includes(String(row.category))) result.category = row.category as LLMModel['category'];
    if (!result.category && output) result.category = output.includes('image') ? 'image' : output.includes('audio') ? 'audio' : output.includes('video') ? 'video' : output.includes('text') ? 'chat' : undefined;
    if (row.operations && isMediaCatalog(undefined, row.operations)) result.operations = row.operations as LLMModel['operations'];
    if (Array.isArray(row.supportedOperations) && row.supportedOperations.every(operation => operation === 'image.generate' || operation === 'speech.synthesize'))
        result.supportedOperations = row.supportedOperations as LLMModel['supportedOperations'];
    if (row.reasoning !== undefined && isReasoningCapabilities(row.reasoning)) result.reasoning = row.reasoning;
    const effort = record(row.effort), levels = strings(effort.supported_levels);
    if (levels?.length) {
        const reasoning = { efforts: levels.map(id => ({ id })), source: 'catalog' as const,
            ...(typeof effort.default_level === 'string' ? { defaultEffort: effort.default_level } : {}) };
        if (isReasoningCapabilities(reasoning)) { result.reasoning = reasoning; result.supportsThinking = true; }
    }
    result.capabilitiesKnown = fields.some(field => result[field] !== undefined) || !!result.category || !!result.operations;
    return {...result, ...modelBounds(row)};
}

function declaredFlags(row: Record<string, unknown>, caps: Record<string, unknown>): Partial<LLMModel> {
    const result: Partial<LLMModel> = {};
    for (const field of fields) {
        const value = row[field] ?? caps[field];
        if (typeof value === 'boolean') result[field] = value;
    }
    const aliases = {vision: 'supportsVision', thinking: 'supportsThinking', reasoning: 'supportsThinking', tools: 'supportsTools',
        function_calling: 'supportsTools', audio: 'supportsAudio', video: 'supportsVideo', structured_output: 'supportsStructuredOutput'} as const;
    for (const [key, field] of Object.entries(aliases)) if (typeof caps[key] === 'boolean' && result[field] === undefined) result[field] = caps[key] as boolean;
    return result;
}

function modelBounds(row: Record<string, unknown>): Partial<LLMModel> {
    const result: Partial<LLMModel> = {};
    const context = row.context_length ?? row.context_window ?? row.contextWindow, max = row.max_output_tokens ?? row.maxOutput;
    if (typeof context === 'number' && Number.isSafeInteger(context) && context > 0) result.contextWindow = context;
    if (typeof max === 'number' && Number.isSafeInteger(max) && max > 0) result.maxOutput = max;
    return result;
}
