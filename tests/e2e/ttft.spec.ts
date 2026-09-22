import { spawnSync } from 'node:child_process';
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
    createLatencyLog,
    median,
    parseRuns,
    type Samples,
    shuffled,
} from './latency-report';
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

const RUNS = parseRuns('TTFT_RUNS');
const log = createLatencyLog('ttft', COLUMNS, RUNS);

function formatUiMinusRaw(row: Samples<Column>): string {
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
                log.record(key, 'ui', run, marks.first - marks.start);
            });

            await test.step('ext-import', () => {
                const result = runWorker('ext-import', key);
                log.record(key, 'ext-import', run, result.firstContentMs);
            });

            await test.step('raw', () => {
                const result = runWorker('raw', key);
                log.record(key, 'raw', run, result.firstContentMs);
                if (result.headersMs !== undefined) {
                    log.record(key, 'raw-headers', run, result.headersMs);
                }
            });
        });
    }
}

test.afterAll(() => {
    log.printTable(
        PROVIDERS,
        `TTFT (ms, first text or reasoning delta${log.runsNote}; ui-raw = median of per-run ui minus raw)`,
        { header: 'ui-raw', cell: formatUiMinusRaw }
    );
});
