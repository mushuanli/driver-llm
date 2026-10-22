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

function nativeProvider(): LLMProvider {
    const p = provider(); p.baseURL = 'https://speech.example.test';
    p.media!['speech.synthesize'] = {adapter: 'doubao-speech', sampleRate: 24000};
    return p;
}
const speech = {operation: 'speech.synthesize', model: 'voice', input: 'private text', voice: 'demo', format: 'mp3'} as const;
it('adapts native speech authentication, payload, split UTF-8/JSON frames and completion without retry', async () => {
    const text = JSON.stringify({code: 0, data: btoa('one'), message: '中文'}) + '\n' + JSON.stringify({header: {code: 0}, data: btoa('two')}) + '\n' + JSON.stringify({code: 20000000});
    const bytes = new TextEncoder().encode(text), fetch = vi.fn(async () => new Response(new ReadableStream({start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close();
    }})));
    const result = await new LLMMediaClient({provider: nativeProvider(), apiKey: 'native-key', fetch}).generate(speech);
    expect(new TextDecoder().decode(result.assets[0].data)).toBe('onetwo');
    expect(result.assets[0].mimeType).toBe('audio/mpeg'); expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://speech.example.test/api/v3/tts/unidirectional');
    expect(init.headers).toMatchObject({'X-Api-Key': 'native-key', 'X-Api-Resource-Id': 'voice'});
    expect(init.headers).not.toHaveProperty('Authorization');
    expect((init.headers as Record<string, string>)['X-Api-Request-Id']).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(JSON.parse(String(init.body))).toEqual({req_params: {text: speech.input, speaker: 'demo', audio_params: {format: 'mp3', sample_rate: 24000}}});
});
it.each(['json-lines', 'sse'])('accepts native speech completion with null audio in %s responses', async framing => {
    const frames = [{code: 0, data: btoa('audio')}, {code: 20000000, message: 'OK', data: null, usage: {text_words: 2}}];
    const body = frames.map(frame => `${framing === 'sse' ? 'data: ' : ''}${JSON.stringify(frame)}\n`).join('\n');
    const fetch = vi.fn(async () => new Response(body)), info = vi.fn(), error = vi.fn();
    const result = await new LLMMediaClient({provider: nativeProvider(), apiKey: 'key', fetch, logger: {info, error, debug: vi.fn(), warn: vi.fn()}}).generate(speech);
    expect(new TextDecoder().decode(result.assets[0].data)).toBe('audio');
    expect(fetch).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith('media.request.completed', expect.objectContaining({bytes: 5}));
    expect(error).not.toHaveBeenCalled();
});
it.each([null, '*invalid*', 'YQ=', 123, {}])('rejects native speech without valid audio despite a successful completion: %j', async data => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({code: 0, data}) + '\n' + JSON.stringify({code: 20000000, data: null})));
    await expect(new LLMMediaClient({provider: nativeProvider(), apiKey: 'key', fetch}).generate(speech)).rejects.toMatchObject({code: data === null ? 'MEDIA_EMPTY_AUDIO' : 'MEDIA_RESPONSE'});
    expect(fetch).toHaveBeenCalledOnce();
});
it('rejects native business errors after audio without returning partial media or logging private content', async () => {
    const error = vi.fn(), logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error};
    const fetch = vi.fn(async () => new Response(JSON.stringify({code: 0, data: btoa('partial')}) + '\n' + JSON.stringify({code: 45000000, message: 'private text'}), {headers: {'X-Tt-Logid': 'safe-log-id'}}));
    await expect(new LLMMediaClient({provider: nativeProvider(), apiKey: 'native-key', fetch, logger}).generate(speech)).rejects.toMatchObject({code: 'MEDIA_REMOTE_ERROR', remoteCode: '45000000', requestId: 'safe-log-id'});
    expect(fetch).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledWith('media.request.failed', expect.objectContaining({code: 'MEDIA_REMOTE_ERROR', serverRequestId: 'safe-log-id'}));
    expect(JSON.stringify(logger.info.mock.calls) + JSON.stringify(error.mock.calls)).not.toMatch(/private text|native-key|partial/);
});
it.each([{code: 0}, {code: 0, data: '*invalid*'}, {data: btoa('audio')}])('rejects incomplete native speech responses: %j', async frame => {
    await expect(new LLMMediaClient({provider: nativeProvider(), apiKey: 'key', fetch: async () => Response.json(frame)}).generate(speech)).rejects.toThrow();
});
it('validates native formats, speed, sample rates and UUID fallback before transport', async () => {
    const fetch = vi.fn(), p = nativeProvider();
    p.models[1].operations!['speech.synthesize']!.formats.push('wav');
    await expect(new LLMMediaClient({provider: p, apiKey: 'key', fetch}).generate({...speech, format: 'wav'})).rejects.toMatchObject({code: 'MEDIA_FORMAT'});
    expect(fetch).not.toHaveBeenCalled();
    expect(isMediaCatalog(p.media, p.models[1].operations)).toBe(true);
    expect(isMediaCatalog({'speech.synthesize': {adapter: 'doubao-speech', sampleRate: 12345}}, undefined)).toBe(false);
});

it('cancels native speech during transfer and never returns buffered audio', async () => {
    const abort = new AbortController();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream({start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({code: 0, data: btoa('partial')}) + '\n'));
        init!.signal!.addEventListener('abort', () => controller.error(new DOMException('Cancelled', 'AbortError')), {once: true});
    }})));
    const result = new LLMMediaClient({provider: nativeProvider(), apiKey: 'key', fetch}).generate({...speech, signal: abort.signal});
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); abort.abort();
    await expect(result).rejects.toMatchObject({code: 'ABORTED'}); expect(fetch).toHaveBeenCalledOnce();
});
it('maps native speech speed and Opus output without using the OpenAI speech body', async () => {
    const p = nativeProvider(), caps = p.models[1].operations!['speech.synthesize']!;
    caps.formats.push('opus'); caps.speedRange = {min: 0.5, max: 2};
    const fetch = vi.fn(async () => Response.json({code: 0, data: btoa('audio')}));
    const result = await new LLMMediaClient({provider: p, apiKey: 'key', fetch}).generate({...speech, format: 'opus', speed: 1.5});
    expect(result.assets[0].mimeType).toBe('audio/ogg');
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.req_params.audio_params).toMatchObject({format: 'ogg_opus', speech_rate: 50});
});
