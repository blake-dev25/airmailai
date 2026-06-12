/**
 * Set WXT_DEBUG_API_LOGGING=true in the root .env (or the environment) to log
 * API request payloads to the console. Verbose - for debugging only. The store
 * zip build forces this off regardless of .env (see the ext zip script).
 *
 * When enabled, two distinct flows are logged, each with a `[debug]` prefix:
 *
 *   site -> ext request        Turn payload arriving at the SW from the
 *                             website (provider, model, params, hydrated
 *                             messages). Logged once per turn at stream
 *                             start.
 *
 *   <provider>: -> request     Final request body the provider shaper hands
 *                             to the upstream SDK / API endpoint. One
 *                             entry per turn, just before the call fires.
 */
export const DEBUG_API_LOGGING =
    typeof __DEBUG_API_LOGGING__ !== 'undefined'
        ? __DEBUG_API_LOGGING__
        : import.meta.env.WXT_DEBUG_API_LOGGING === 'true';
