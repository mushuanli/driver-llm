import {afterEach, expect, it, vi} from 'vitest';
import {requestUUID} from '../src/utils/uuid';
afterEach(() => vi.unstubAllGlobals());
it.each(['missing', 'throwing'])('creates distinct UUID v4 values when crypto is %s', state => {
    vi.stubGlobal('crypto', state === 'missing' ? undefined : {getRandomValues() {throw new Error('unavailable');}});
    const first = requestUUID(), second = requestUUID();
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(second).not.toBe(first);
});
