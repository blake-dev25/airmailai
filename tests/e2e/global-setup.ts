import { execSync } from 'node:child_process';

export default function globalSetup(): void {
    execSync('bun run --filter courierai_ext build', { stdio: 'inherit' });
}
