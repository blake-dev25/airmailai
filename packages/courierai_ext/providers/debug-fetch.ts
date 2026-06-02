import { DEBUG_API_LOGGING } from '../debug';

const LOG = '[courierai:ext]';

// Call-signature only: Bun's `typeof fetch` carries a static `preconnect`
// member that a plain function expression lacks. We only ever produce the call
// signature, so type it as such to stay portable across the ext (DOM) and
// script (Bun) typecheckers.
type FetchFn = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

async function readRequestBody(
    input: Parameters<FetchFn>[0],
    init: Parameters<FetchFn>[1]
): Promise<string | undefined> {
    if (typeof init?.body === 'string') return init.body;
    if (input instanceof Request) return input.clone().text();
    return undefined;
}

function logRequestBody(provider: string, raw: string): void {
    try {
        console.log(LOG, `[debug] ${provider}: -> request`, JSON.parse(raw));
    } catch {
        console.log(LOG, `[debug] ${provider}: -> request (raw)`, raw);
    }
}

// Wrap fetch so SDK-produced request bodies get logged immediately before the
// network call. Returns undefined when logging is off so each SDK's default
// fetch path runs unchanged.
export function makeDebugFetch(provider: string): FetchFn | undefined {
    if (!DEBUG_API_LOGGING) return undefined;
    return async (input, init) => {
        const raw = await readRequestBody(input, init);
        if (raw) logRequestBody(provider, raw);
        return init == null ? fetch(input) : fetch(input, init);
    };
}
