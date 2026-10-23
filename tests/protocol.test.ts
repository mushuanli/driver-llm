import { describe, expect, it } from 'vitest';
import { resolveModelProtocol, type ApiProtocol, type LLMProvider } from '../src/contracts';

const provider: LLMProvider = { id: 'p', name: 'P', implementation: 'openai-compatible',
    defaultProtocol: 'openai-chat', models: [
        { id: 'optimal', name: 'Optimal' },
        { id: 'selected', name: 'Selected', preferredProtocol: 'anthropic-messages' },
    ] };

describe('declared model protocol identity', () => {
    it('uses explicit connection protocol before the actual model preference and Provider default', () => {
        expect(resolveModelProtocol({ protocol: 'openai-responses' }, provider, 'selected')).toBe('openai-responses');
        expect(resolveModelProtocol({}, provider, 'selected')).toBe('anthropic-messages');
        expect(resolveModelProtocol({}, provider, 'optimal')).toBe('openai-chat');
    });

    it('keeps unknown declarations unknown rather than inferring from names or implementation', () => {
        expect(resolveModelProtocol({}, undefined, 'selected')).toBeUndefined();
        expect(resolveModelProtocol({}, { ...provider, defaultProtocol: undefined }, 'optimal')).toBeUndefined();
        expect(resolveModelProtocol({ protocol: 'invalid' as ApiProtocol }, provider, 'selected')).toBeUndefined();
        expect(resolveModelProtocol({}, { ...provider, models: [{ id: 'selected', name: 'Selected',
            preferredProtocol: 'invalid' as ApiProtocol }] }, 'selected')).toBeUndefined();
        expect(resolveModelProtocol({}, { ...provider, defaultProtocol: 'invalid' as ApiProtocol }, 'optimal')).toBeUndefined();
    });
});
