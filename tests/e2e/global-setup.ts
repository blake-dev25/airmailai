import { execSync } from 'node:child_process';
import { BASE_URL } from './env';

export default function globalSetup(): void {
    if (process.env.AIRMAILAI_EXT_PATH) {
        console.log(
            `Using prebuilt extension at ${process.env.AIRMAILAI_EXT_PATH}`
        );
        return;
    }
    const allowLocalhost = new URL(BASE_URL).hostname === 'localhost';
    execSync('bun run --filter airmailai_ext build', {
        stdio: 'inherit',
        env: {
            ...process.env,
            ...(allowLocalhost ? { WXT_ALLOW_LOCALHOST: 'true' } : {}),
        },
    });
}
