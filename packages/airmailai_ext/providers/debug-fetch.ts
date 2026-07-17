import { LOG_LEVEL, log } from '../debug';

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
        log.debug(`${provider}: -> request`, JSON.parse(raw));
    } catch {
        log.debug(`${provider}: -> request (raw)`, raw);
    }
}

export function makeDebugFetch(provider: string): FetchFn | undefined {
    if (LOG_LEVEL !== 'all') return undefined;
    return async (input, init) => {
        const raw = await readRequestBody(input, init);
        if (raw) logRequestBody(provider, raw);
        return init == null ? fetch(input) : fetch(input, init);
    };
}
