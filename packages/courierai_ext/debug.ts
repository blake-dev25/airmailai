/**
 * Set to true to log API request payloads to the console. Verbose - for
 * debugging only.
 *
 * When enabled, two distinct flows are logged, each with a `[debug]` prefix:
 *
 *   site -> ext request        Turn payload arriving at the SW from the
 *                             website (provider, model, params, hydrated
 *                             messages). Logged once per turn at stream
 *                             start.
 *
 *   <provider>: -> request     Final request body the provider shaper hands
 *                             to the upstream SDK / REST endpoint. One
 *                             entry per turn, just before the call fires.
 *
 * No response logging: responses arrive as a stream of many small chunk
 * postMessages - logging each would drown the console.
 */
export const DEBUG_API_LOGGING = true;
