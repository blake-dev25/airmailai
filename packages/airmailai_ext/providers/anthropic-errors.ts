import Anthropic from '@anthropic-ai/sdk';

export function toReadableAnthropicError(error: unknown): unknown {
    if (!(error instanceof Anthropic.APIError) || !error.apiMessage) {
        return error;
    }
    return Object.assign(
        new Error(`${error.status} ${error.apiMessage}`, { cause: error }),
        { status: error.status }
    );
}
