import { log } from './log';

class ErrorStore {
    appError = $state<string | null>(null);

    setAppError(message: string): void {
        log.warn('app error:', message);
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
    log.error(context, err);
    errorStore.setAppError(`${userMessage}: ${formatErr(err)}`);
}
