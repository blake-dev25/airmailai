import { assertSafeModelId, tsString } from './shared';

export function updateTiersFile(
    text: string,
    sectionComment: string,
    derivedIds: string[]
): {
    text: string;
    newIds: string[];
    staleEntries: Array<{ id: string; tier: string }>;
} {
    for (const id of derivedIds) assertSafeModelId(id);
    const lines = text.split('\n');
    const sectionIdx = lines.findIndex((l) => l.trim() === sectionComment);
    if (sectionIdx === -1) {
        throw new Error(
            `Could not find section "${sectionComment}" in tiers.ts`
        );
    }
    let endIdx = lines.length;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith('//') || t.startsWith('};')) {
            endIdx = i;
            break;
        }
    }

    const sectionEntries: Array<{
        id: string;
        tier: string;
        assignment: string;
    }> = [];
    for (let i = sectionIdx + 1; i < endIdx; i++) {
        const m = lines[i].match(/^\s*'([^']+)':\s*(.+),\s*$/);
        if (!m) continue;
        const tiers = Array.from(
            m[2].matchAll(/'([^']+)'/g),
            (match) => match[1]
        );
        if (tiers.length === 0) continue;
        sectionEntries.push({
            id: m[1],
            tier: tiers.join(','),
            assignment: m[2],
        });
    }

    const allExisting = new Set<string>();
    for (const l of lines) {
        const m = l.match(/^\s*'([^']+)':/);
        if (m) allExisting.add(m[1]);
    }
    const newIds = derivedIds.filter((id) => !allExisting.has(id));

    const derivedSet = new Set(derivedIds);
    const staleEntries = sectionEntries.filter((e) => !derivedSet.has(e.id));

    const combined = [
        ...sectionEntries,
        ...newIds.map((id) => ({
            id,
            tier: 'legacy',
            assignment: tsString('legacy'),
        })),
    ];
    combined.sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true })
    );
    const sortedLines = combined.map(
        (e) => `    ${tsString(e.id)}: ${e.assignment},`
    );

    const updated = [
        ...lines.slice(0, sectionIdx + 1),
        ...sortedLines,
        ...lines.slice(endIdx),
    ];
    const newText = updated.join('\n');
    return { text: newText, newIds, staleEntries };
}
