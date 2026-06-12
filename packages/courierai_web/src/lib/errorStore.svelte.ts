const LOG = '[courierai:web]';

class ErrorStore {
    appError = $state<string | null>(null);

    setAppError(message: string): void {
        console.warn(LOG, 'app error:', message);
        this.appError = `App Error: ${message}`;
    }

    clearAppError(): void {
        this.appError = null;
    }
}

export const errorStore = new ErrorStore();

export function formatErr(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

export function reportAppError(
    context: string,
    userMessage: string,
    err: unknown
): void {
    console.error(LOG, context, err);
    errorStore.setAppError(`${userMessage}: ${formatErr(err)}`);
}
