import type {
    CourierAIMessage,
    CourierAISourceUrlPart,
    CourierAIToolPart,
} from '@courierai/shared';

type CodeExecPart = Extract<CourierAIToolPart, { name: 'code_execution' }>;

function sourcesBlock(sources: CourierAISourceUrlPart[]): string {
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

export function foldReplayIntoText(msg: CourierAIMessage): string {
    let text = '';
    const sources: CourierAISourceUrlPart[] = [];
    const runs: CodeExecPart[] = [];
    for (const part of msg.parts) {
        if (part.type === 'text') text += part.text;
        else if (part.type === 'source-url') sources.push(part);
        else if (part.type === 'tool' && part.name === 'code_execution')
            runs.push(part);
    }
    return [text, codeBlock(runs), sourcesBlock(sources)]
        .filter(Boolean)
        .join('\n\n');
}
