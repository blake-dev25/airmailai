import { readFile, writeFile } from 'node:fs/promises';
import { FIRST_PARTY_PROVIDER_IDS } from '../../packages/airmailai_web/src/lib/models/modelsFile';
import type { ModelsFile } from '../../packages/airmailai_web/src/lib/models/types';
import { LOCAL_TIERS_FILE } from './env';
import { type Provider, assertSafeModelId } from './shared';

const TIER_ENTRY = /^\s*'([^']+)':\s*(.+),\s*$/;
const SECTION_END = /^\s*(\/\/|};)/;

export interface TiersSync {
    text: string;
    added: string[];
    stale: Array<{ provider: Provider; id: string }>;
}

export function syncTiersFile(text: string, file: ModelsFile): TiersSync {
    let lines = text.split('\n');
    const existingIds = new Set(
        lines.flatMap((line) => line.match(TIER_ENTRY)?.[1] ?? [])
    );
    const added: string[] = [];
    const stale: TiersSync['stale'] = [];
    for (const provider of FIRST_PARTY_PROVIDER_IDS) {
        const ids = file.providers[provider].map((model) => model.id);
        ids.forEach(assertSafeModelId);
        const header = `// *** ${provider}`;
        const start = lines.findIndex((line) => line.trim() === header);
        if (start === -1) {
            throw new Error(
                `Could not find "${header}" in ${LOCAL_TIERS_FILE}`
            );
        }
        let end = start + 1;
        while (end < lines.length && !SECTION_END.test(lines[end])) end++;

        const entries = lines.slice(start + 1, end).flatMap((line) => {
            const match = line.match(TIER_ENTRY);
            return match ? [{ id: match[1], assignment: match[2] }] : [];
        });
        const listed = new Set(ids);
        for (const entry of entries) {
            if (!listed.has(entry.id)) stale.push({ provider, id: entry.id });
        }
        const fresh = ids.filter((id) => !existingIds.has(id));
        added.push(...fresh);

        const sectionLines = [
            ...entries,
            ...fresh.map((id) => ({ id, assignment: "'new'" })),
        ]
            .sort((a, b) =>
                a.id.localeCompare(b.id, undefined, { numeric: true })
            )
            .map(({ id, assignment }) => `    '${id}': ${assignment},`);
        lines = [
            ...lines.slice(0, start + 1),
            ...sectionLines,
            ...lines.slice(end),
        ];
    }
    return { text: lines.join('\n'), added, stale };
}

export async function syncLocalTiersFile(
    file: ModelsFile,
    write: boolean
): Promise<void> {
    const original = await readFile(LOCAL_TIERS_FILE, 'utf-8');
    const { text, added, stale } = syncTiersFile(original, file);
    if (added.length > 0) {
        console.log(
            `\n${write ? 'adding' : 'would add'} ${added.length} id(s) to tiers.ts as 'new':`
        );
        for (const id of added) console.log(`   - ${id}`);
    }
    if (stale.length > 0) {
        console.log(
            `\nWARN ${stale.length} tiers.ts entry/entries not in models.json, consider removing:`
        );
        for (const { provider, id } of stale) {
            console.log(`   - [${provider}] ${id}`);
        }
    }
    if (text === original) {
        console.log(`unchanged: ${LOCAL_TIERS_FILE}`);
    } else if (write) {
        await writeFile(LOCAL_TIERS_FILE, text);
        console.log(`OK wrote ${LOCAL_TIERS_FILE}`);
    } else {
        console.log(`would write: ${LOCAL_TIERS_FILE}`);
    }
}
