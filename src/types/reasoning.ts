import type { ApiProtocol, LLMModel } from './connection';
import type { ChatCompletionParams } from './response';

export interface ReasoningCapabilities {
    source?: 'catalog' | 'preset' | 'user';
    efforts: Array<{ id: string; label?: string; value?: string }>;
    defaultEffort?: string;
    canDisable?: boolean;
    budget?: { min: number; max: number };
    transport?: 'effort' | 'deepseek' | 'adaptive' | 'budget';
}

/** A gateway can narrow or override the model's native reasoning contract. */
export function modelReasoning(model: LLMModel | undefined, protocol?: ApiProtocol): ReasoningCapabilities | undefined {
    return protocol && model?.reasoningByProtocol?.[protocol] !== undefined
        ? model.reasoningByProtocol[protocol] || undefined : model?.reasoning || undefined;
}

export function isReasoningCapabilities(value: unknown): value is ReasoningCapabilities | false | undefined {
    if (value === undefined || value === false) return true;
    if (!value || typeof value !== 'object') return false;
    const row = value as ReasoningCapabilities, ids = new Set<string>();
    if (!Array.isArray(row.efforts) || row.efforts.length > 32) return false;
    for (const option of row.efforts) {
        if (!option || typeof option.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(option.id) || ids.has(option.id)) return false;
        if (option.value !== undefined && (typeof option.value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(option.value))) return false;
        if (option.label !== undefined && (typeof option.label !== 'string' || option.label.length > 128)) return false;
        ids.add(option.id);
    }
    return (row.defaultEffort === undefined || ids.has(row.defaultEffort))
        && (row.source === undefined || ['catalog', 'preset', 'user'].includes(row.source))
        && (row.canDisable === undefined || typeof row.canDisable === 'boolean')
        && (row.transport === undefined || ['effort', 'deepseek', 'adaptive', 'budget'].includes(row.transport))
        && (!row.budget || Number.isSafeInteger(row.budget.min) && Number.isSafeInteger(row.budget.max)
            && row.budget.min >= 0 && row.budget.max >= row.budget.min);
}

/** Preserve legacy requests, but enforce every explicit model/protocol declaration. */
export function resolveReasoningRequest(model: LLMModel | undefined, protocol: ApiProtocol | undefined,
    request: ChatCompletionParams): ChatCompletionParams {
    const caps = modelReasoning(model, protocol), explicit = request.reasoningEffort;
    const override = protocol ? model?.reasoningByProtocol?.[protocol] : undefined;
    const disabled = override === undefined ? model?.reasoning === false : override === false;
    if (disabled && (explicit !== undefined || request.thinking === true)) throw reasoningError('REASONING_UNSUPPORTED');
    if (!caps) return request;
    if (explicit === 'off' && caps.canDisable === true) return { ...request, thinking: false, reasoningEffort: undefined, thinkingBudget: undefined };
    if (request.thinking === false && caps.canDisable === false) throw reasoningError('REASONING_CANNOT_DISABLE');
    if (request.thinkingBudget !== undefined && (!caps.budget || !Number.isSafeInteger(request.thinkingBudget)
        || request.thinkingBudget < caps.budget.min || request.thinkingBudget > caps.budget.max)) throw reasoningError('REASONING_BUDGET');
    if (request.thinking === false && explicit !== undefined) throw reasoningError('REASONING_CONFLICT');
    const selected = explicit ?? (request.thinking === false ? undefined : caps.defaultEffort);
    const option = selected === undefined ? undefined : caps.efforts.find(item => item.id === selected);
    if (selected !== undefined && !option) throw reasoningError('REASONING_EFFORT_UNSUPPORTED');
    return { ...request, reasoningEffort: option?.value ?? option?.id,
        ...(option ? { thinking: true } : {}) };
}

function reasoningError(code: string): Error {
    return Object.assign(new Error(`Invalid model reasoning configuration: ${code}`), { code });
}
