import { formatErr, reportAppError } from './errorStore.svelte';

export type AsyncResourceState<T> =
    | { status: 'idle' }
    | { status: 'loading'; previous: T | null }
    | { status: 'ready'; value: T }
    | { status: 'error'; message: string };

export interface ResourceFailureReport {
    context: string;
    userMessage: string;
}

export class AsyncResource<T> {
    state = $state.raw<AsyncResourceState<T>>({ status: 'idle' });
    value = $derived(
        this.state.status === 'ready'
            ? this.state.value
            : this.state.status === 'loading'
              ? this.state.previous
              : null
    );
    private generation = 0;

    async load(
        fetcher: () => Promise<T>,
        report?: ResourceFailureReport
    ): Promise<void> {
        const generation = ++this.generation;
        this.state = { status: 'loading', previous: this.value };
        try {
            const value = await fetcher();
            if (generation === this.generation) {
                this.state = { status: 'ready', value };
            }
        } catch (err) {
            if (generation !== this.generation) return;
            this.state = { status: 'error', message: formatErr(err) };
            if (report) reportAppError(report.context, report.userMessage, err);
        }
    }

    set(value: T): void {
        this.generation++;
        this.state = { status: 'ready', value };
    }

    update(transform: (value: T) => T): void {
        if (this.state.status !== 'ready') return;
        this.set(transform(this.state.value));
    }
}
