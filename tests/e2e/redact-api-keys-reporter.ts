import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { unzipSync, zipSync } from 'fflate';
import { readFileSync, writeFileSync } from 'node:fs';
import { PROVIDER_ENV } from './env';

const REDACTED = '[REDACTED]';

function apiKeyNeedles(): string[] {
    return Object.values(PROVIDER_ENV)
        .map((envVar) => process.env[envVar])
        .filter((value): value is string => !!value)
        .map((value) => Buffer.from(value, 'utf-8').toString('latin1'));
}

function redactBytes(
    bytes: Uint8Array,
    needles: string[]
): Uint8Array<ArrayBuffer> | null {
    const text = Buffer.from(bytes).toString('latin1');
    if (!needles.some((needle) => text.includes(needle))) return null;
    return Buffer.from(
        needles.reduce(
            (redacted, needle) => redacted.replaceAll(needle, REDACTED),
            text
        ),
        'latin1'
    );
}

function redactZip(bytes: Uint8Array, needles: string[]): Uint8Array | null {
    const entries = unzipSync(bytes);
    let changed = false;
    for (const [name, content] of Object.entries(entries)) {
        const redacted = redactBytes(content, needles);
        if (!redacted) continue;
        entries[name] = redacted;
        changed = true;
    }
    return changed ? zipSync(entries) : null;
}

export default class RedactApiKeys implements Reporter {
    private readonly needles = apiKeyNeedles();

    onTestEnd(_test: TestCase, result: TestResult): void {
        if (!this.needles.length) return;
        for (const { path } of result.attachments) {
            if (!path) continue;
            const original = readFileSync(path);
            const redacted = path.endsWith('.zip')
                ? redactZip(original, this.needles)
                : redactBytes(original, this.needles);
            if (redacted) writeFileSync(path, redacted);
        }
    }

    printsToStdio(): boolean {
        return false;
    }
}
