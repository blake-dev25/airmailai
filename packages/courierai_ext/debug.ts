/**
 * Set to true to log full API request payloads and responses to the console.
 * Verbose — for debugging only.
 *
 * When enabled, two distinct flows are logged, each with a `[debug]` prefix:
 *
 *   site → ext request        Turn payload arriving at the SW from the
 *                             website (provider, model, params, hydrated
 *                             messages). Logged once per turn at stream
 *                             start. No symmetric `ext → site response`
 *                             log because the response is a stream of many
 *                             small `chunk` postMessages — logging every
 *                             one would drown the console.
 *
 *   <provider>: → request     Final request body the provider shaper hands
 *                             to the upstream SDK / REST endpoint. One
 *                             entry per turn, just before the call fires.
 *
 *   <provider>: ← response    Terminal response object from the provider
 *                             after the stream completes (for Google: the
 *                             collected chunks). Carries usage, tool-call
 *                             output, finish reason, etc.
 */
export const DEBUG_API_LOGGING = true;
