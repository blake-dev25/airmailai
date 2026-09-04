import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { PROVIDER_ENV } from './env';
import {
    expect,
    PROVIDER_MODELS,
    type ProviderKey,
    QUICK_TIMEOUT,
    test,
} from './fixtures';
import {
    TTFT_MAX_TOKENS,
    TTFT_PROMPT,
    type TtftWorkerMode,
    type TtftWorkerResult,
} from './ttft-shared';

const ROOT = path.resolve(__dirname, '../..');
const WORKER = path.join(__dirname, 'ttft-worker.ts');

const PROVIDERS: ProviderKey[] = [
    'anthropic',
    'openai',
    'google',
    'openrouter',
];

type Column = 'ui' | 'ext-import' | 'raw' | 'raw-headers';
const COLUMNS: Column[] = ['ui', 'ext-import', 'raw', 'raw-headers'];

function parseRuns(raw: string | undefined): number {
    if (raw === undefined) return 1;
    const runs = Number(raw);
    if (!Number.isInteger(runs) || runs < 1) {
        throw new Error(`TTFT_RUNS must be a positive integer, got "${raw}"`);
    }
    return runs;
}
const RUNS = parseRuns(process.env.TTFT_RUNS);

interface Measurement {
    provider: ProviderKey;
    column: Column;
    run: number;
    ms: number;
}

function measurementsPath(): string {
    return path.join(test.info().project.outputDir, 'ttft.jsonl');
}

function record(
    provider: ProviderKey,
    column: Column,
    run: number,
    ms: number
): void {
    const measurement: Measurement = { provider, column, run, ms };
    const file = measurementsPath();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(measurement) + '\n');
    console.log(`[ttft] ${provider} ${column} ${ms.toFixed(0)}ms`);
}

type SamplesByRun = Map<number, number>;
type Samples = Partial<Record<Column, SamplesByRun>>;

function readMeasurements(): Map<ProviderKey, Samples> {
    const results = new Map<ProviderKey, Samples>();
    const file = measurementsPath();
    if (!existsSync(file)) return results;
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line) continue;
        const { provider, column, run, ms } = JSON.parse(line) as Measurement;
        const row = results.get(provider) ?? {};
        (row[column] ??= new Map()).set(run, ms);
        results.set(provider, row);
    }
    return results;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function formatStats(values: number[]): string {
    if (!values.length) return '-';
    const stats =
        RUNS === 1
            ? median(values).toFixed(0)
            : `${Math.min(...values).toFixed(0)}/${median(values).toFixed(0)}/${Math.max(...values).toFixed(0)}`;
    const count = values.length === RUNS ? '' : ` (${values.length}/${RUNS})`;
    return `${stats}${count}`;
}

function formatCell(samples: SamplesByRun | undefined): string {
    return formatStats([...(samples?.values() ?? [])]);
}

function formatUiMinusRaw(row: Samples): string {
    const diffs: number[] = [];
    for (const [run, ui] of row.ui ?? []) {
        const raw = row.raw?.get(run);
        if (raw !== undefined) diffs.push(ui - raw);
    }
    if (!diffs.length) return '-';
    const count = diffs.length === RUNS ? '' : ` (${diffs.length}/${RUNS})`;
    return `${median(diffs).toFixed(0)}${count}`;
}

interface UiMarks {
    start: number;
    first: number;
}

declare global {
    interface Window {
        airmailaiTtft?: UiMarks;
    }
}

async function armUiTimer(page: Page): Promise<void> {
    await page.evaluate(() => {
        const marks: UiMarks = { start: 0, first: 0 };
        window.airmailaiTtft = marks;
        document.addEventListener(
            'click',
            (e) => {
                if (marks.start) return;
                const target = e.target as Element;
                if (target.closest('button[aria-label="Send message"]')) {
                    marks.start = performance.now();
                }
            },
            true
        );
        const observer = new MutationObserver(() => {
            const assistants = document.querySelectorAll(
                '[data-msg-role="assistant"]'
            );
            const last = assistants[assistants.length - 1];
            if (!last?.textContent?.trim()) return;
            marks.first = performance.now();
            observer.disconnect();
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    });
}

function shuffled<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
}

function runWorker(
    mode: TtftWorkerMode,
    provider: ProviderKey
): TtftWorkerResult {
    const proc = spawnSync('bun', [WORKER, mode, provider], {
        cwd: ROOT,
        encoding: 'utf-8',
        env: process.env,
        timeout: QUICK_TIMEOUT,
    });
    if (proc.error) throw proc.error;
    if (proc.status !== 0) {
        throw new Error(
            `ttft-worker ${mode} ${provider} exited ${proc.status}:\n${proc.stderr}${proc.stdout}`
        );
    }
    const lastLine = proc.stdout.trim().split('\n').at(-1) ?? '';
    return JSON.parse(lastLine) as TtftWorkerResult;
}

for (let run = 1; run <= RUNS; run++) {
    for (const key of shuffled(PROVIDERS)) {
        const { label, chat, chatName } = PROVIDER_MODELS[key];
        const title = `${label} TTFT: ui vs ext-import vs raw${RUNS > 1 ? ` (run ${run}/${RUNS})` : ''}`;

        test(title, async ({ airmailai }) => {
            if (!process.env[PROVIDER_ENV[key]]) {
                throw new Error(`${PROVIDER_ENV[key]} missing from .env`);
            }

            await test.step('ui', async () => {
                await airmailai.goto();
                await airmailai.setProvider(label);
                if (key === 'openrouter') {
                    await airmailai.waitForOpenRouterCatalog();
                    await airmailai.setModelById(chat);
                }
                await expect(airmailai.modelTrigger()).toContainText(chatName);
                await airmailai.setThinkingLowest();
                await airmailai.setMaxTokens(TTFT_MAX_TOKENS);

                await armUiTimer(airmailai.page);
                await airmailai.compose(TTFT_PROMPT);
                await expect(airmailai.stopButton()).toBeHidden({
                    timeout: QUICK_TIMEOUT,
                });

                const marks = await airmailai.page.evaluate(
                    () => window.airmailaiTtft
                );
                if (!marks?.start || !marks.first) {
                    const alerts = await airmailai.appError().allTextContents();
                    throw new Error(
                        `${key}: no assistant content rendered (start=${marks?.start ?? 0}, first=${marks?.first ?? 0})${alerts.length ? `\n${alerts.join('\n')}` : ''}`
                    );
                }
                record(key, 'ui', run, marks.first - marks.start);
            });

            await test.step('ext-import', () => {
                const result = runWorker('ext-import', key);
                record(key, 'ext-import', run, result.firstContentMs);
            });

            await test.step('raw', () => {
                const result = runWorker('raw', key);
                record(key, 'raw', run, result.firstContentMs);
                if (result.headersMs !== undefined) {
                    record(key, 'raw-headers', run, result.headersMs);
                }
            });
        });
    }
}

test.afterAll(() => {
    const results = readMeasurements();
    const width = RUNS === 1 ? 14 : 24;
    const header = [
        'provider'.padEnd(width),
        ...COLUMNS.map((c) => c.padStart(width)),
        'ui-raw'.padStart(width),
    ].join('');
    const rows = PROVIDERS.map((provider) => {
        const row = results.get(provider) ?? {};
        return [
            provider.padEnd(width),
            ...COLUMNS.map((c) => formatCell(row[c]).padStart(width)),
            formatUiMinusRaw(row).padStart(width),
        ].join('');
    });
    const runsNote = RUNS > 1 ? `, min/median/max of ${RUNS} runs` : '';
    console.log(
        `\nTTFT (ms, first text or reasoning delta${runsNote}; ui-raw = median of per-run ui minus raw)\n${header}\n${rows.join('\n')}\n`
    );
});
