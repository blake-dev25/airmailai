export class HttpError extends Error {
    constructor(
        readonly label: string,
        readonly status: number,
        readonly body: string
    ) {
        super(`HTTP ${status} from ${label}: ${body.slice(0, 500)}`);
        this.name = 'HttpError';
    }
}

export interface HttpRequest {
    url: string;
    label: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: unknown;
    attempts?: number;
}

export interface HttpResponse {
    status: number;
    text: string;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1000, 2000];
const TIMEOUT_MS = 30_000;

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
    const attempts = req.attempts ?? DEFAULT_ATTEMPTS;
    const headers: Record<string, string> = { ...req.headers };
    let body: string | undefined;
    if (req.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(req.body);
    }
    for (let attempt = 1; ; attempt++) {
        let failure: string;
        try {
            const res = await fetch(req.url, {
                method: req.method ?? 'GET',
                headers,
                body,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const text = await res.text();
            if (!RETRYABLE_STATUSES.has(res.status) || attempt === attempts) {
                return { status: res.status, text };
            }
            failure = `HTTP ${res.status}`;
        } catch (e) {
            if (attempt === attempts) {
                throw new Error(`${req.label}: ${errorMessage(e)}`, {
                    cause: e,
                });
            }
            failure = errorMessage(e);
        }
        const delay =
            RETRY_BACKOFF_MS[
                Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)
            ];
        console.log(
            `${req.label} attempt ${attempt}/${attempts} failed (${failure}) - retrying in ${delay / 1000}s`
        );
        await sleep(delay);
    }
}

export async function httpJson<T>(req: HttpRequest): Promise<T> {
    const { status, text } = await httpRequest(req);
    if (status < 200 || status >= 300) {
        throw new HttpError(req.label, status, text);
    }
    return JSON.parse(text) as T;
}
