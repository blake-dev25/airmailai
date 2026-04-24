import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAJOR_MINOR = '0.900';
const root = join(import.meta.dirname, '..');
const COUNTER_FILE = join(root, 'build-counter.json');
const VERSION_FILE = join(root, 'VERSION');

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

const version = `${MAJOR_MINOR}.${dateCode}.${counter.num}`;
writeFileSync(VERSION_FILE, version);

console.log(`Version: ${version}`);
