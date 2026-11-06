import { execSync } from 'node:child_process';

export default function globalSetup(): void {
    if (process.env.AIRMAILAI_EXT_PATH) {
        console.log(
            `Using prebuilt extension at ${process.env.AIRMAILAI_EXT_PATH}`
        );
        return;
    }
    execSync('bun run --filter airmailai_ext build', { stdio: 'inherit' });
}
