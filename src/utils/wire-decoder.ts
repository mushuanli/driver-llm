export type WireObject = Record<string, unknown>;
const record = (value: unknown): value is WireObject => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Decode provider envelopes while retaining provider-specific extension fields. */
export function decodeWireObject(value: unknown, requiredArray?: string): WireObject {
    if (!record(value)) throw new TypeError('Invalid LLM response envelope');
    if (requiredArray && !Array.isArray(value[requiredArray])) throw new TypeError(`Invalid LLM response: ${requiredArray}`);
    for (const key of ['choices', 'content', 'candidates', 'output']) {
        if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every(record))) {
            throw new TypeError(`Invalid LLM response: ${key}`);
        }
    }
    for (const key of ['message', 'response']) {
        if (value[key] !== undefined && !record(value[key])) throw new TypeError(`Invalid LLM response: ${key}`);
    }
    if (value.delta !== undefined && typeof value.delta !== 'string' && !record(value.delta)) throw new TypeError('Invalid LLM response: delta');
    for (const key of ['usage', 'usageMetadata']) {
        if (value[key] !== undefined && value[key] !== null && !record(value[key])) throw new TypeError(`Invalid LLM response: ${key}`);
    }
    validateNestedCollections(value);
    validateBlocks(value.content);
    for (const item of (value.output ?? []) as WireObject[]) validateBlocks(item.content);
    return value;
}

function validateNestedCollections(value: WireObject): void {
    for (const choice of (value.choices ?? []) as WireObject[]) {
        for (const key of ['message', 'delta']) {
            if (choice[key] !== undefined && !record(choice[key])) throw new TypeError(`Invalid LLM choice: ${key}`);
            if (record(choice[key])) validateMessage(choice[key]);
        }
    }
    for (const candidate of (value.candidates ?? []) as WireObject[]) {
        if (candidate.content !== undefined && !record(candidate.content)) throw new TypeError('Invalid LLM candidate content');
        const parts = record(candidate.content) ? candidate.content.parts : undefined;
        if (parts !== undefined && (!Array.isArray(parts) || !parts.every(record))) throw new TypeError('Invalid LLM candidate parts');
    }
}

/** Malformed SSE frames can be skipped without losing subsequent valid events. */
export function parseWireEvent(data: string): WireObject {
    return decodeWireObject(JSON.parse(data) as unknown);
}

function validateMessage(value: WireObject): void {
    if (value.content !== undefined && value.content !== null && typeof value.content !== 'string'
        && (!Array.isArray(value.content) || !value.content.every(record))) throw new TypeError('Invalid LLM message content');
    for (const key of ['reasoning_content', 'refusal']) {
        if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') throw new TypeError(`Invalid LLM message: ${key}`);
    }
    if (value.tool_calls !== undefined && (!Array.isArray(value.tool_calls) || !value.tool_calls.every(call =>
        record(call) && (call.function === undefined || record(call.function))))) throw new TypeError('Invalid LLM tool calls');
}
function validateBlocks(value: unknown): void {
    if (value === undefined) return;
    if (!Array.isArray(value) || !value.every(record)) throw new TypeError('Invalid LLM content blocks');
    for (const block of value) {
        for (const key of ['type', 'text', 'thinking', 'id', 'name']) {
            if (block[key] !== undefined && typeof block[key] !== 'string') throw new TypeError(`Invalid LLM content block: ${key}`);
        }
    }
}
