import { createLogger, normalizeLogLevel } from '@airmailai/shared';

declare const __LOG_LEVEL__: string | undefined;

export const LOG_LEVEL = normalizeLogLevel(
    typeof __LOG_LEVEL__ !== 'undefined' ? __LOG_LEVEL__ : undefined
);

export const log = createLogger('[airmailai:ext]', LOG_LEVEL);
