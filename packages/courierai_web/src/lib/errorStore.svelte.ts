const LOG = '[courier:web]';

// App-wide error surface. Non-stream failures (storage CRUD, settings save,
// OpenRouter hydrate, key save/clear, etc.) flow through this and render as
// a banner in App.svelte. Stream errors stay per-chat in chatStore.chatErrors
// so they're visible alongside the chat they refer to.
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

// One-stop reporter for non-stream failures: tagged console log + user-
// facing banner. `context` is the operator-facing breadcrumb (component +
// what failed); `userMessage` is the human-readable "Couldn't X" lead-in
// that gets ": <err>" appended.
export function reportAppError(
    context: string,
    userMessage: string,
    err: unknown
): void {
    console.error(LOG, context, err);
    errorStore.setAppError(`${userMessage}: ${formatErr(err)}`);
}
