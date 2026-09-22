import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type ProviderKey, test } from './fixtures';

export function parseRuns(envName: string): number {
    const raw = process.env[envName];
    if (raw === undefined) return 1;
    const runs = Number(raw);
    if (!Number.isInteger(runs) || runs < 1) {
        throw new Error(`${envName} must be a positive integer, got "${raw}"`);
    }
    return runs;
}

export function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function shuffled<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
}

export type SamplesByRun = Map<number, number>;
export type Samples<Column extends string> = Partial<
    Record<Column, SamplesByRun>
>;

interface Measurement<Column extends string> {
    provider: ProviderKey;
    column: Column;
    run: number;
    ms: number;
}

export interface ExtraColumn<Column extends string> {
    header: string;
    cell: (row: Samples<Column>) => string;
}

export function createLatencyLog<Column extends string>(
    name: string,
    columns: readonly Column[],
    runs: number
) {
    const file = () =>
        path.join(test.info().project.outputDir, `${name}.jsonl`);

    function record(
        provider: ProviderKey,
        column: Column,
        run: number,
        ms: number
    ): void {
        const measurement: Measurement<Column> = { provider, column, run, ms };
        const target = file();
        mkdirSync(path.dirname(target), { recursive: true });
        appendFileSync(target, JSON.stringify(measurement) + '\n');
        console.log(`[${name}] ${provider} ${column} ${ms.toFixed(0)}ms`);
    }

    function read(): Map<ProviderKey, Samples<Column>> {
        const results = new Map<ProviderKey, Samples<Column>>();
        const target = file();
        if (!existsSync(target)) return results;
        for (const line of readFileSync(target, 'utf-8').split('\n')) {
            if (!line) continue;
            const { provider, column, run, ms } = JSON.parse(
                line
            ) as Measurement<Column>;
            const row: Samples<Column> = results.get(provider) ?? {};
            (row[column] ??= new Map()).set(run, ms);
            results.set(provider, row);
        }
        return results;
    }

    function formatStats(values: number[]): string {
        if (!values.length) return '-';
        const stats =
            runs === 1
                ? median(values).toFixed(0)
                : `${Math.min(...values).toFixed(0)}/${median(values).toFixed(0)}/${Math.max(...values).toFixed(0)}`;
        const count =
            values.length === runs ? '' : ` (${values.length}/${runs})`;
        return `${stats}${count}`;
    }

    function formatCell(samples: SamplesByRun | undefined): string {
        return formatStats([...(samples?.values() ?? [])]);
    }

    function printTable(
        providers: readonly ProviderKey[],
        title: string,
        extra?: ExtraColumn<Column>
    ): void {
        const results = read();
        const width = runs === 1 ? 14 : 24;
        const header = [
            'provider'.padEnd(width),
            ...columns.map((c) => c.padStart(width)),
            ...(extra ? [extra.header.padStart(width)] : []),
        ].join('');
        const rows = providers.map((provider) => {
            const row: Samples<Column> = results.get(provider) ?? {};
            return [
                provider.padEnd(width),
                ...columns.map((c) => formatCell(row[c]).padStart(width)),
                ...(extra ? [extra.cell(row).padStart(width)] : []),
            ].join('');
        });
        console.log(`\n${title}\n${header}\n${rows.join('\n')}\n`);
    }

    const runsNote = runs > 1 ? `, min/median/max of ${runs} runs` : '';

    return { record, printTable, runsNote };
}
