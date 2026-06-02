import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { readFileSync, writeFileSync } from 'node:fs';

// On failure Playwright writes an `error-context.md` (a "error-context"
// attachment) next to the trace, led by a hardcoded LLM prompt block
// ("# Instructions ... Following Playwright test failed ...") that has no
// opt-out (see playwright/lib/errorContext.js). The rest of the file - page
// snapshot, error details, test source - is useful, so as each failing test
// finishes we drop everything before the first "# Test info" heading (always
// the block right after the instructions). Per-test (not globalTeardown) so
// it still strips files from a run that's Ctrl+C'd partway.
export default class StripErrorContextPrompt implements Reporter {
    onTestEnd(_test: TestCase, result: TestResult): void {
        for (const attachment of result.attachments) {
            if (attachment.name !== 'error-context' || !attachment.path)
                continue;
            const content = readFileSync(attachment.path, 'utf8');
            const idx = content.indexOf('# Test info');
            // idx === 0 -> already stripped (idempotent); idx < 0 -> unexpected
            // shape, leave it untouched rather than mangle it.
            if (idx > 0) writeFileSync(attachment.path, content.slice(idx));
        }
    }

    printsToStdio(): boolean {
        return false;
    }
}
