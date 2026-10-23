import type { LLMModel } from '../types';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Ark directory declarations describe capabilities, not permission to invoke a paid endpoint. */
export function arkCatalogDeclarations(row: Record<string, unknown>): Record<string, unknown> {
    const modalities = record(row.modalities), features = record(row.features), limits = record(row.token_limits);
    const structured = record(features.structured_outputs), tools = record(features.tools);
    const flags: Partial<LLMModel> = {};
    if (Array.isArray(row.task_type) && row.task_type.includes('TextToImage')) {
        flags.category = 'image'; flags.supportedOperations = ['image.generate'];
    }
    if (Array.isArray(row.task_type) && row.task_type.some(task => ['TextEmbedding', 'ImageEmbedding'].includes(task))) flags.category = 'embedding';
    if (typeof tools.function_calling === 'boolean') flags.supportsTools = tools.function_calling;
    const formats = [structured.json_object, structured.json_schema];
    if (formats.includes(true)) flags.supportsStructuredOutput = true;
    else if (formats.every(value => value === false)) flags.supportsStructuredOutput = false;
    const input = modalities.input_modalities;
    const normalizedInput = Array.isArray(input) ? input.map(value =>
        ['first_frame', 'first_last_frame', 'reference'].includes(String(value)) ? 'image' : value) : input;
    return {...flags, input_modalities: normalizedInput, output_modalities: modalities.output_modalities,
        context_window: limits.context_window, max_output_tokens: limits.max_output_token_length};
}
