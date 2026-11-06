import type { StreamErrorSource } from '@airmailai/shared';

export type TurnPhase =
    'pending' | 'streaming' | 'capturing' | 'persisting' | 'finished';

export type TurnOutcome =
    | { kind: 'completed' }
    | { kind: 'stopped'; truncateTo: number }
    | { kind: 'aborted' }
    | { kind: 'errored'; message: string; source: StreamErrorSource };

export class TurnLifecycle {
    private phase: TurnPhase = 'pending';
    private outcome: TurnOutcome | null = null;

    get currentPhase(): TurnPhase {
        return this.phase;
    }

    isPending(): boolean {
        return this.phase === 'pending';
    }

    start(): void {
        this.phase = 'streaming';
    }

    disconnect(): void {
        if (this.phase === 'pending') {
            this.phase = 'finished';
            this.outcome = { kind: 'aborted' };
        } else if (this.phase === 'streaming' && this.outcome === null) {
            this.outcome = { kind: 'aborted' };
        }
    }

    requestStop(truncateTo: number): boolean {
        const accepted =
            (this.phase === 'streaming' && this.outcome === null) ||
            (this.phase === 'capturing' && this.outcome?.kind === 'completed');
        if (accepted) this.outcome = { kind: 'stopped', truncateTo };
        return accepted;
    }

    isDelivering(): boolean {
        return this.phase === 'streaming' && this.outcome === null;
    }

    streamEnded(): void {
        this.outcome ??= { kind: 'completed' };
    }

    streamFailed(message: string, source: StreamErrorSource): void {
        this.outcome ??= { kind: 'errored', message, source };
    }

    beginCapturing(): void {
        this.phase = 'capturing';
    }

    beginPersisting(): void {
        this.phase = 'persisting';
    }

    finalizeFailed(message: string): void {
        this.outcome = { kind: 'errored', message, source: 'extension' };
    }

    warn(message: string): void {
        if (this.outcome?.kind === 'errored') return;
        this.outcome = { kind: 'errored', message, source: 'extension' };
    }

    truncateTo(): number | null {
        return this.outcome?.kind === 'stopped'
            ? this.outcome.truncateTo
            : null;
    }

    persistsMessage(): boolean {
        return this.outcome?.kind !== 'aborted';
    }

    finish(): TurnOutcome {
        this.phase = 'finished';
        this.outcome ??= {
            kind: 'errored',
            message: 'The response ended without a result.',
            source: 'extension',
        };
        return this.outcome;
    }
}
