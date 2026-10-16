import { expect, it, vi } from 'vitest';
import { LLMMediaClient } from '../src/media/client';
import { isMediaCatalog } from '../src/types/media-capabilities';
import type { LLMProvider, MediaGenerationRequest } from '../src/types';
function provider(): LLMProvider {
    return { id: 'p', name: 'P', baseURL: 'https://example.test/v1', implementation: 'openai-compatible', media: {
        'image.generate': { adapter: 'openai-images' }, 'speech.synthesize': { adapter: 'openai-speech' },
    }, models: [{ id: 'image', name: 'Image', category: 'image', operations: { 'image.generate': { inputModalities: ['text'], outputModalities: ['image'], formats: ['png'] } } },
        { id: 'voice', name: 'Voice', category: 'audio', operations: { 'speech.synthesize': { inputModalities: ['text'], outputModalities: ['audio'], formats: ['mp3'], voices: ['demo'] } } }] };
}
const request: MediaGenerationRequest = { operation: 'image.generate', model: 'image', prompt: 'A square', format: 'png' };
it('uses explicit media routes and binary results without retrying', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ b64_json: btoa('binary') }] }));
    const client = new LLMMediaClient({ provider: provider(), apiKey: 'fixture', fetch });
    expect((await client.generate(request)).assets[0].data).toEqual(new TextEncoder().encode('binary'));
    expect(fetch.mock.calls[0][0]).toBe('https://example.test/v1/images/generations');
    const failing = vi.fn(async () => new Response('error', { status: 503 }));
    await expect(new LLMMediaClient({ provider: provider(), apiKey: 'fixture', fetch: failing }).generate(request)).rejects.toThrow('503');
    expect(failing).toHaveBeenCalledOnce();
});
it.each([{ ...request, model: 'voice' }, { ...request, format: 'webp' }, { ...request, count: 2 }, { ...request, size: 'unknown' }])('rejects unsupported requests before transport', async bad => {
    const fetch = vi.fn(); await expect(new LLMMediaClient({ provider: provider(), apiKey: 'fixture', fetch }).generate(bad as MediaGenerationRequest)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
});
it('does not infer TTS from audio flags and rejects URL image results', async () => {
    const p = provider(); p.models[1].operations = undefined; p.models[1].supportsAudio = true;
    const fetch = vi.fn();
    await expect(new LLMMediaClient({ provider: p, apiKey: 'fixture', fetch }).generate({ operation: 'speech.synthesize', model: 'voice', input: 'Hello', voice: 'demo', format: 'mp3' })).rejects.toThrow('unknown');
    expect(fetch).not.toHaveBeenCalled();
    await expect(new LLMMediaClient({ provider: provider(), apiKey: 'fixture', fetch: async () => Response.json({ data: [{ url: 'https://other.test/image' }] }) }).generate(request)).rejects.toThrow('base64');
});
it('validates capability configuration and cancellation without loading a host runtime', async () => {
    expect(isMediaCatalog(provider().media, provider().models[0].operations)).toBe(true);
    expect(isMediaCatalog({ 'image.generate': { adapter: 'openai-speech' } }, undefined)).toBe(false);
    const abort = new AbortController(); abort.abort(); const fetch = vi.fn();
    await expect(new LLMMediaClient({ provider: provider(), apiKey: 'fixture', fetch }).generate({ ...request, signal: abort.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
});
