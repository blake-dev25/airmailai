import { execSync } from 'node:child_process';

// Build the extension so Playwright can load .output/chrome-mv3 unpacked.
export default function globalSetup(): void {
    execSync('bun run --filter courierai_ext build', { stdio: 'inherit' });
}
