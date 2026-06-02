import type {
    CourierAIMessage,
    CourierAISourceUrlPart,
} from '@courierai/shared';

// Stateless web-search replay for providers that don't round-trip results
// natively (OpenAI/Google/OpenRouter): on the next turn the model re-reads the
// URLs from its own prior message. We append a markdown `Sources:` block built
// from the message's source-url parts to its outgoing text. Verified to make
// the model recite URLs verbatim without re-searching. See plan D3/D4.
//
// Anthropic does NOT use this - it round-trips web_search_tool_result natively.
export function foldSourcesIntoText(msg: CourierAIMessage): string {
    let text = '';
    const sources: CourierAISourceUrlPart[] = [];
    for (const part of msg.parts) {
        if (part.type === 'text') text += part.text;
        else if (part.type === 'source-url') sources.push(part);
    }
    if (!sources.length) return text;

    const lines = sources.map((s, i) =>
        s.title ? `${i + 1}. [${s.title}](${s.url})` : `${i + 1}. ${s.url}`
    );
    const block = 'Sources:\n' + lines.join('\n');
    return text ? `${text}\n\n${block}` : block;
}
