export const TTFT_PROMPT = 'test';
export const TTFT_MAX_TOKENS = 20;

export type TtftWorkerMode = 'ext-import' | 'raw';

export interface TtftWorkerResult {
    firstContentMs: number;
    headersMs?: number;
}
