import type { TokenUsage } from './response';
export type MediaOperation = 'image.generate' | 'speech.synthesize';
export interface MediaModelCapabilities {
    inputModalities: string[]; outputModalities: string[]; formats: string[];
    voices?: string[]; sizes?: string[]; qualities?: string[]; features?: string[];
    maxInputCharacters?: number; maxOutputs?: number; speedRange?: { min: number; max: number };
}
export interface MediaEndpoint {
    adapter: 'openai-images' | 'openai-speech'; path?: string;
    responseFormat?: 'b64_json'; outputFormatParameter?: boolean;
}
export interface ImageGenerationRequest {
    operation: 'image.generate'; model?: string; prompt: string; format: 'png' | 'jpeg' | 'webp';
    size?: string; quality?: string; count?: number; signal?: AbortSignal;
}
export interface SpeechSynthesisRequest {
    operation: 'speech.synthesize'; model?: string; input: string; voice: string;
    format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'; speed?: number; instructions?: string; signal?: AbortSignal;
}
export type MediaGenerationRequest = ImageGenerationRequest | SpeechSynthesisRequest;
export type MediaGenerationInput = Omit<ImageGenerationRequest, 'signal'> | Omit<SpeechSynthesisRequest, 'signal'>;
export interface MediaGenerationResult {
    model: string; assets: Array<{ mimeType: string; data: Uint8Array }>; usage?: TokenUsage;
}
