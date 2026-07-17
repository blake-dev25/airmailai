const TEST_TIMEOUT_MS = 10_000;

export interface KeyTestResult {
    ok: boolean;
    message?: string;
}

function testEndpoint(
    provider: string,
    apiKey: string
): { url: string; headers: Record<string, string> } {
    if (provider === 'anthropic') {
        return {
            url: 'https://api.anthropic.com/v1/models?limit=1',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
        };
    }
    if (provider === 'openai') {
        return {
            url: 'https://api.openai.com/v1/models',
            headers: { Authorization: `Bearer ${apiKey}` },
        };
    }
    if (provider === 'google') {
        return {
            url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
            headers: { 'x-goog-api-key': apiKey },
        };
    }
    if (provider === 'openrouter') {
        return {
            url: 'https://openrouter.ai/api/v1/key',
            headers: { Authorization: `Bearer ${apiKey}` },
        };
    }
    throw new Error(`Key testing is not supported for ${provider}.`);
}

async function extractErrorMessage(resp: Response): Promise<string> {
    let detail = '';
    try {
        const body = (await resp.json()) as { error?: { message?: unknown } };
        if (typeof body.error?.message === 'string')
            detail = body.error.message;
    } catch {
        detail = '';
    }
    return detail
        ? `HTTP ${resp.status}: ${detail}`
        : `HTTP ${resp.status} ${resp.statusText}`.trim();
}

export async function testProviderKey(
    provider: string,
    apiKey: string
): Promise<KeyTestResult> {
    const { url, headers } = testEndpoint(provider, apiKey);
    const resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (resp.ok) return { ok: true };
    return { ok: false, message: await extractErrorMessage(resp) };
}
