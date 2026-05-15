import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const COUNTER_FILE = join(root, 'build-counter.json');
const VERSION_FILE = join(root, 'VERSION');
const VERSION_NAME_FILE = join(root, 'VERSION_NAME');

const isOfficial = process.env.OFFICIAL_BUILD === '1';

const now = new Date();
const yy = now.getFullYear() % 100;
const m = now.getMonth() + 1;
const d = now.getDate();
const dateCode = `${yy}.${m}.${d}`;

let version: string;
let versionName: string;

if (isOfficial) {
    let counter: { date: string; num: number } = { date: '', num: 0 };
    try {
        counter = JSON.parse(readFileSync(COUNTER_FILE, 'utf-8'));
    } catch {}

    if (counter.date === dateCode) {
        counter.num++;
    } else {
        counter.date = dateCode;
        counter.num = 1;
    }

    writeFileSync(COUNTER_FILE, JSON.stringify(counter, null, 2) + '\n');
    version = `${dateCode}.${counter.num}`;
    versionName = `${version}-beta`;
} else {
    version = `${dateCode}.0`;
    versionName = `${version}-local${localGitSuffix()}`;
}

function localGitSuffix(): string {
    try {
        execSync('git rev-parse --is-inside-work-tree', {
            cwd: root,
            stdio: 'pipe',
        });
        const status = execSync('git status --porcelain', {
            cwd: root,
            stdio: 'pipe',
        })
            .toString()
            .trim();
        if (status) return '.modified';
        const sha = execSync('git rev-parse --short HEAD', {
            cwd: root,
            stdio: 'pipe',
        })
            .toString()
            .trim();
        return `.${sha}`;
    } catch {
        return '';
    }
}

writeFileSync(VERSION_FILE, version);
writeFileSync(VERSION_NAME_FILE, versionName);

console.log(`Version: ${versionName}${isOfficial ? '' : ' (local)'}`);
