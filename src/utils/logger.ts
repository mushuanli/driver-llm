import type { LLMLogSink } from '../types/provider';
export const noopLog: LLMLogSink = { debug() {}, info() {}, warn() {}, error() {} };
