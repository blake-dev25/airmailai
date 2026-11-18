import { errorMessage } from '@airmailai/shared';
import { log } from './log';

export type AppWarning = { kind: 'model-unavailable'; modelId: string };

class ErrorStore {
    appError = $state<string | null>(null);
    appWarning = $state<AppWarning | null>(null);

    setAppError(message: string): void {
        log.warn('app error:', message);
        this.appError = `App Error: ${message}`;
    }

    clearAppError(): void {
        this.appError = null;
    }

    setAppWarning(warning: AppWarning): void {
        log.warn('app warning:', warning);
        this.appWarning = warning;
    }

    clearAppWarning(): void {
        this.appWarning = null;
    }
}

export const errorStore = new ErrorStore();

export function reportAppError(
    context: string,
    userMessage: string,
    detail?: unknown
): void {
    if (detail === undefined) {
        log.error(context);
        errorStore.setAppError(userMessage);
        return;
    }
    log.error(context, detail);
    errorStore.setAppError(`${userMessage}: ${errorMessage(detail)}`);
}
