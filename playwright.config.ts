import { defineConfig } from '@playwright/test';
import { BASE_URL } from './tests/e2e/env';

export default defineConfig({
    testDir: './tests/e2e',
    globalSetup: './tests/e2e/global-setup.ts',
    // *** Real provider calls against a single shared extension profile - keep serial.
    fullyParallel: false,
    workers: 1,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: [
        ['list'],
        ['html', { open: 'never' }],
        ['./tests/e2e/strip-error-context-reporter.ts'],
        ['./tests/e2e/redact-api-keys-reporter.ts'],
    ],
    use: {
        baseURL: BASE_URL,
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'bun run --filter airmailai_web dev',
        url: `${BASE_URL}/app/`,
        reuseExistingServer: true,
        timeout: 120_000,
    },
});
