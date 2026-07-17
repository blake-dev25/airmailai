import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const VERSION_FILE = join(root, 'VERSION');
const VERSION_NAME_FILE = join(root, 'VERSION_NAME');

const isOfficial = process.env.OFFICIAL_BUILD === '1';

function git(args: string): string {
    return execSync(`git ${args}`, { cwd: root, stdio: 'pipe' })
        .toString()
        .trim();
}

const commitDateIso = git('log -1 --format=%cI');
const [year, month, day] = commitDateIso.split('T')[0].split('-').map(Number);
const dateCode = `${year % 100}.${month}.${day}`;

const buildNum = process.env.BUILD_NUM ?? '1';
if (!/^[1-9]\d*$/.test(buildNum)) {
    throw new Error(`BUILD_NUM must be a positive integer, got "${buildNum}"`);
}

const version = `${dateCode}.${buildNum}`;

const dirty = git('status --porcelain') !== '';
if (isOfficial && dirty) {
    console.warn(
        `WARNING: official build from a dirty tree - version ${version} maps to HEAD but the tree has uncommitted changes`
    );
}

const versionName = isOfficial
    ? `${version}-beta`
    : `${version}-local${dirty ? '.modified' : `.${git('rev-parse --short HEAD')}`}`;

writeFileSync(VERSION_FILE, version);
writeFileSync(VERSION_NAME_FILE, versionName);

console.log(`Version: ${versionName}${isOfficial ? '' : ' (local)'}`);
