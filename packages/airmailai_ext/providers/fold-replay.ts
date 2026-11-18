import type {
    AirmailAIMessage,
    AirmailAISourceUrlPart,
    AirmailAIToolPart,
} from '@airmailai/shared';

type CodeExecPart = Extract<AirmailAIToolPart, { name: 'code_execution' }>;

function sourcesBlock(sources: AirmailAISourceUrlPart[]): string {
    if (!sources.length) return '';
    const lines = sources.map((s, i) =>
        s.title ? `${i + 1}. [${s.title}](${s.url})` : `${i + 1}. ${s.url}`
    );
    return 'Sources:\n' + lines.join('\n');
}

function codeBlock(runs: CodeExecPart[]): string {
    const blocks = runs
        .map((r) => {
            const sections: string[] = [];
            if (r.input?.code)
                sections.push('Input\n```\n' + r.input.code + '\n```');
            if (r.output?.stdout)
                sections.push('Output\n```\n' + r.output.stdout + '\n```');
            if (r.output?.stderr)
                sections.push('Error\n```\n' + r.output.stderr + '\n```');
            else if (r.errorText)
                sections.push('Error\n```\n' + r.errorText + '\n```');
            return sections.join('\n');
        })
        .filter(Boolean);
    return blocks.length ? 'Code:\n' + blocks.join('\n\n') : '';
}

function webCallOutcome(call: AirmailAIToolPart): string {
    switch (call.state) {
        case 'running':
            return 'Interrupted';
        case 'done':
            return 'Success';
        case 'error':
            return call.errorText ? `Error: ${call.errorText}` : 'Error';
    }
}

interface WebCallLine {
    target: string | undefined;
    outcome: string;
}

function webCallsBlock(
    heading: string,
    untargetedLabel: string,
    calls: WebCallLine[]
): string {
    if (!calls.length) return '';
    const lines = calls.map(
        (c, i) => `${i + 1}. ${c.target || untargetedLabel} - ${c.outcome}`
    );
    return heading + '\n' + lines.join('\n');
}

export function hasReplayableContent(msg: AirmailAIMessage): boolean {
    return (
        msg.parts.some((p) => p.type === 'file') ||
        foldReplayIntoText(msg).length > 0
    );
}

export function foldReplayIntoText(msg: AirmailAIMessage): string {
    let text = '';
    const sources: AirmailAISourceUrlPart[] = [];
    const runs: CodeExecPart[] = [];
    const searches: WebCallLine[] = [];
    const fetches: WebCallLine[] = [];
    for (const part of msg.parts) {
        if (part.type === 'text') text += part.text;
        else if (part.type === 'source-url') sources.push(part);
        else if (part.type === 'tool') {
            if (part.name === 'code_execution') runs.push(part);
            else if (part.name === 'web_search')
                searches.push({
                    target: part.input?.query,
                    outcome: webCallOutcome(part),
                });
            else
                fetches.push({
                    target: part.input?.url,
                    outcome: webCallOutcome(part),
                });
        }
    }
    return [
        text,
        codeBlock(runs),
        webCallsBlock('Web searches performed:', 'Web search', searches),
        webCallsBlock('Web pages fetched:', 'Web fetch', fetches),
        sourcesBlock(sources),
    ]
        .filter(Boolean)
        .join('\n\n');
}
