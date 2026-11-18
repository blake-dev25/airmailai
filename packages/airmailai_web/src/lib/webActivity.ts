import type { AirmailAIMessage, AirmailAIToolPart } from '@airmailai/shared';

export type WebCallStatus =
    | { kind: 'running' }
    | { kind: 'success' }
    | { kind: 'error'; reason: string }
    | { kind: 'interrupted' };

type WebCallStatusKind = WebCallStatus['kind'];

export interface WebCallView {
    id: string;
    target?: string;
    href?: string;
    status: WebCallStatus;
}

export interface WebCallCount {
    kind: WebCallStatusKind;
    text: string;
}

export interface WebActivityView {
    searches: WebCallView[];
    fetches: WebCallView[];
}

const STATUS_KIND_ORDER: WebCallStatusKind[] = [
    'running',
    'success',
    'error',
    'interrupted',
];

const STATUS_KIND_LABELS: Record<WebCallStatusKind, string> = {
    running: 'Running',
    success: 'Success',
    error: 'Error',
    interrupted: 'Interrupted',
};

function webCallStatus(
    part: AirmailAIToolPart,
    streaming: boolean
): WebCallStatus {
    switch (part.state) {
        case 'running':
            return streaming ? { kind: 'running' } : { kind: 'interrupted' };
        case 'done':
            return { kind: 'success' };
        case 'error':
            return {
                kind: 'error',
                reason: part.errorText?.trim() || STATUS_KIND_LABELS.error,
            };
    }
}

export function buildWebActivityView(
    msg: AirmailAIMessage,
    streaming: boolean
): WebActivityView {
    const searches: WebCallView[] = [];
    const fetches: WebCallView[] = [];
    for (const part of msg.parts) {
        if (part.type !== 'tool') continue;
        if (part.name === 'web_search') {
            const query = part.input?.query?.trim();
            searches.push({
                id: part.toolCallId,
                ...(query ? { target: query } : {}),
                status: webCallStatus(part, streaming),
            });
        } else if (part.name === 'web_fetch') {
            const url = part.input?.url?.trim();
            fetches.push({
                id: part.toolCallId,
                ...(url ? { target: url } : {}),
                ...(url && /^https?:\/\//i.test(url) ? { href: url } : {}),
                status: webCallStatus(part, streaming),
            });
        }
    }
    return { searches, fetches };
}

export function webCallCounts(calls: WebCallView[]): WebCallCount[] {
    const out: WebCallCount[] = [];
    for (const kind of STATUS_KIND_ORDER) {
        const count = calls.filter((c) => c.status.kind === kind).length;
        if (count > 0) {
            out.push({ kind, text: `${count} ${STATUS_KIND_LABELS[kind]}` });
        }
    }
    return out;
}

export function webCallStatusText(status: WebCallStatus): string {
    return status.kind === 'error'
        ? status.reason
        : STATUS_KIND_LABELS[status.kind];
}
