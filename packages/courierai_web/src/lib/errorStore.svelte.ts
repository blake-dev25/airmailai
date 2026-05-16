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
