import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const COUNTER_FILE = join(root, 'build-counter.json');
const VERSION_FILE = join(root, 'VERSION');
const VERSION_NAME_FILE = join(root, 'VERSION_NAME');
const VERSION_JSON = join(root, 'version.json');

const { major, minor } = JSON.parse(readFileSync(VERSION_JSON, 'utf-8')) as {
    major: number;
    minor: number;
};
const majorMinor = `${major}.${minor}`;

const isOfficial = process.env.OFFICIAL_BUILD === '1';

let version: string;
let versionName: string;

if (isOfficial) {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const startOfYear = new Date(now.getFullYear(), 0, 0);
    const doy = Math.floor((now.getTime() - startOfYear.getTime()) / 86_400_000);
    const ddd = String(doy).padStart(3, '0');
    const dateCode = `${yy}${ddd}`;

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
    version = `${majorMinor}.${dateCode}.${counter.num}`;
    versionName = version;
} else {
    version = `${majorMinor}.0.0`;
    versionName = `${version}-local`;
}

writeFileSync(VERSION_FILE, version);
writeFileSync(VERSION_NAME_FILE, versionName);

console.log(`Version: ${versionName}${isOfficial ? '' : ' (local)'}`);
