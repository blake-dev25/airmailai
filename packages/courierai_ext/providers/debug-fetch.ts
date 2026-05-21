import { DEBUG_API_LOGGING } from '../debug';

// AI SDK providers accept a `fetch` matching globalThis.fetch (re-exported
// as @ai-sdk/provider-utils#FetchFunction, but that package isn't a direct
// dep here). Use the global signature directly.
type FetchFunction = typeof globalThis.fetch;

const LOG = '[courier:ext]';

// Wrap fetch so the final POST body the SDK builds — after our convert step
// and after the provider adapter serializes ModelMessages into provider-
// shaped content (anthropic thinking blocks, openai reasoning items,
// openrouter reasoning_details, etc.) — gets logged before the network
// call. Returns undefined when logging is off so the SDK's own fetch path
// runs unchanged.
export function makeDebugFetch(provider: string): FetchFunction | undefined {
    if (!DEBUG_API_LOGGING) return undefined;
    return async (input, init) => {
        const raw = init?.body;
        if (typeof raw === 'string') {
            try {
                console.log(
                    LOG,
                    `[debug] ${provider}: → request`,
                    JSON.parse(raw)
                );
            } catch {
                console.log(LOG, `[debug] ${provider}: → request (raw)`, raw);
            }
        }
        return fetch(input, init);
    };
}
