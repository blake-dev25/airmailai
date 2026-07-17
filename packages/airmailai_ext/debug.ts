import { createLogger, normalizeLogLevel } from '@airmailai/shared';

declare const __LOG_LEVEL__: string | undefined;

/**
 * Set AIRMAILAI_LOG_LEVEL in the root .env (or the environment) to control
 * console logging. The store zip build forces 'errors' regardless of .env
 * (see the ext zip script).
 *
 *   errors  Errors and warnings only. The default.
 *   info    Adds operational logs: storage requests, db writes, stream
 *           lifecycle, settings loads.
 *   all     Adds full API request payloads, each with a `[debug]` prefix.
 *           Verbose - two flows are logged per turn:
 *
 *             site -> ext request     Turn payload arriving at the SW from
 *                                     the website (provider, model, params,
 *                                     hydrated messages).
 *             <provider>: -> request  Final request body the provider shaper
 *                                     hands to the upstream SDK / API
 *                                     endpoint, just before the call fires.
 */
export const LOG_LEVEL = normalizeLogLevel(
    typeof __LOG_LEVEL__ !== 'undefined' ? __LOG_LEVEL__ : undefined
);

export const log = createLogger('[airmailai:ext]', LOG_LEVEL);
