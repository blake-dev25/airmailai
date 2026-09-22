import type { Page } from '@playwright/test';
import type { ExtensionStreamEvent } from '../../packages/shared/src/messages';
import { PROVIDER_ENV } from './env';
import { FAKE_REPLY_TEXT, fakeProviderStream } from './fake-provider';
import {
    expect,
    PROVIDER_MODELS,
    type ProviderKey,
    QUICK_TIMEOUT,
    test,
} from './fixtures';
import { createLatencyLog, parseRuns, shuffled } from './latency-report';

const PROVIDERS: ProviderKey[] = [
    'anthropic',
    'openai',
    'google',
    'openrouter',
];

type Column =
    | 'click-request'
    | 'bytes-port'
    | 'port-dom'
    | 'dom-paint'
    | 'bytes-paint'
    | 'app-total';
const COLUMNS: Column[] = [
    'click-request',
    'bytes-port',
    'port-dom',
    'dom-paint',
    'bytes-paint',
    'app-total',
];

const PROMPT = 'test';
const FIRST_BYTE_DELAY_MS = 250;
const RUNS = parseRuns('PIPELINE_RUNS');
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE ?? '1');
if (!Number.isFinite(CPU_THROTTLE) || CPU_THROTTLE < 1) {
    throw new Error(
        `CPU_THROTTLE must be a finite number >= 1, got "${process.env.CPU_THROTTLE}"`
    );
}
const log = createLatencyLog('pipeline-latency', COLUMNS, RUNS);

interface PipelineMarks {
    click: number;
    portChunk: number;
    domMutation: number;
    paint: number;
}

declare global {
    interface Window {
        airmailaiPipeline?: PipelineMarks;
    }
}

async function armPipelineTimers(page: Page): Promise<void> {
    await page.evaluate(() => {
        const now = () => performance.timeOrigin + performance.now();
        const marks: PipelineMarks = {
            click: 0,
            portChunk: 0,
            domMutation: 0,
            paint: 0,
        };
        window.airmailaiPipeline = marks;

        document.addEventListener(
            'click',
            (e) => {
                if (marks.click) return;
                const target = e.target as Element;
                if (target.closest('button[aria-label="Send message"]')) {
                    marks.click = now();
                }
            },
            true
        );

        const originalConnect = chrome.runtime.connect;
        chrome.runtime.connect = ((
            ...args: Parameters<typeof chrome.runtime.connect>
        ) => {
            const port = originalConnect.apply(chrome.runtime, args);
            port.onMessage.addListener((event: ExtensionStreamEvent) => {
                if (marks.portChunk || event.type !== 'chunk') return;
                const chunk = event.chunk;
                if (
                    (chunk.type === 'text-delta' ||
                        chunk.type === 'reasoning-delta') &&
                    chunk.delta
                ) {
                    marks.portChunk = now();
                }
            });
            return port;
        }) as typeof chrome.runtime.connect;

        const observer = new MutationObserver(() => {
            const assistants = document.querySelectorAll(
                '[data-msg-role="assistant"]'
            );
            const last = assistants[assistants.length - 1];
            if (!last?.textContent?.trim()) return;
            marks.domMutation = now();
            observer.disconnect();
            requestAnimationFrame(() => {
                setTimeout(() => {
                    marks.paint = now();
                }, 0);
            });
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    });
}

for (let run = 1; run <= RUNS; run++) {
    for (const key of shuffled(PROVIDERS)) {
        const { label, chat, chatName } = PROVIDER_MODELS[key];
        const title = `${label} pipeline latency: fake provider -> painted${RUNS > 1 ? ` (run ${run}/${RUNS})` : ''}`;

        test(title, async ({ airmailai }) => {
            if (!process.env[PROVIDER_ENV[key]]) {
                throw new Error(`${PROVIDER_ENV[key]} missing from .env`);
            }

            if (CPU_THROTTLE > 1) {
                const session = await airmailai.page
                    .context()
                    .newCDPSession(airmailai.page);
                await session.send('Emulation.setCPUThrottlingRate', {
                    rate: CPU_THROTTLE,
                });
            }

            await airmailai.goto();
            await airmailai.setProvider(label);
            if (key === 'openrouter') {
                await airmailai.waitForOpenRouterCatalog();
                await airmailai.setModelById(chat);
            }
            await expect(airmailai.modelTrigger()).toContainText(chatName);

            await airmailai.installFakeProvider(
                fakeProviderStream(key, chat),
                FIRST_BYTE_DELAY_MS
            );
            await armPipelineTimers(airmailai.page);
            await airmailai.compose(PROMPT);
            await expect(airmailai.stopButton()).toBeHidden({
                timeout: QUICK_TIMEOUT,
            });
            await expect(airmailai.assistantMessages().last()).toContainText(
                FAKE_REPLY_TEXT
            );

            const page = await airmailai.page.evaluate(
                () => window.airmailaiPipeline
            );
            const sw = await airmailai.readFakeProviderMarks();
            const marks = {
                click: page?.click ?? 0,
                request: sw.requestAt,
                'first byte': sw.firstByteAt,
                port: page?.portChunk ?? 0,
                dom: page?.domMutation ?? 0,
                paint: page?.paint ?? 0,
            };
            const missing = Object.entries(marks)
                .filter(([, value]) => !value)
                .map(([name]) => name);
            if (missing.length) {
                const alerts = await airmailai.appError().allTextContents();
                throw new Error(
                    `${key}: pipeline marks missing: ${missing.join(', ')} (fake fetch url: ${sw.url || 'never called'})${alerts.length ? `\n${alerts.join('\n')}` : ''}`
                );
            }

            const clickRequest = marks.request - marks.click;
            const bytesPaint = marks.paint - marks['first byte'];
            log.record(key, 'click-request', run, clickRequest);
            log.record(
                key,
                'bytes-port',
                run,
                marks.port - marks['first byte']
            );
            log.record(key, 'port-dom', run, marks.dom - marks.port);
            log.record(key, 'dom-paint', run, marks.paint - marks.dom);
            log.record(key, 'bytes-paint', run, bytesPaint);
            log.record(key, 'app-total', run, clickRequest + bytesPaint);
        });
    }
}

test.afterAll(() => {
    log.printTable(
        PROVIDERS,
        `Pipeline latency (ms, no provider call, page CPU slowdown ${CPU_THROTTLE}x${log.runsNote}; click-request = send click -> provider request; bytes-port = first content bytes in ext -> page port; port-dom = -> assistant text in DOM; dom-paint = -> next frame; bytes-paint = first content bytes in ext -> painted; app-total = click-request + bytes-paint, excluding provider wait)`
    );
});
