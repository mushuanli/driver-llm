import { expect, it } from 'vitest';
import { testLLMConnection } from '../src/core/api';

it('requires a caller-selected model instead of guessing a vendor-specific model', async () => {
    expect(await testLLMConnection({ provider: 'custom', apiKey: 'test' })).toEqual({ success: false, message: 'Model is required' });
});
