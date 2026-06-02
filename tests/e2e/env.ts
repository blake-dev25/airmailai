import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Playwright's CLI runs under Node, which (unlike bun) doesn't auto-load .env.
// Parse the repo-root .env ourselves so provider API keys are in process.env
// for the seeding fixture. Existing process.env values win.
const ROOT = path.resolve(__dirname, '../..');
const ENV_PATH = path.join(ROOT, '.env');

if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
