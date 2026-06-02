// Generates THIRD_PARTY_LICENSES at the repo root from the runtime
// dependencies actually bundled into the shipped web app + extension. Walks
// the `dependencies` (not devDependencies) of courierai_web + courierai_ext,
// drops the workspace package (@courierai/shared - that's us), reads each
// installed package's license + copyright from its package.json + LICENSE
// file, and emits one attribution block per package followed by the full text
// of every distinct license referenced.
//
// For Apache-2.0 packages that ship a NOTICE file, its contents are reproduced
// in the package's block (required by Apache-2.0 Section 4(d)). For packages
// offered under an SPDX "X OR Y" choice, we elect a single license (see
// LICENSE_ELECTIONS) so the attribution states the terms we actually rely on.
//
//   bun scripts/gen-third-party-licenses.ts            # dry run (prints)
//   bun scripts/gen-third-party-licenses.ts --write    # write the file

import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const OUT = resolve(ROOT, 'THIRD_PARTY_LICENSES');
const WRITE = process.argv.includes('--write');

// Packages whose `dependencies` get bundled into a shipped artifact.
const BUNDLED_PACKAGES = ['courierai_web', 'courierai_ext'];

// For dual/multi-licensed packages (SPDX "X OR Y"), the licensee picks which
// terms to comply with. We record our choice here so the attribution states a
// single, unambiguous license instead of the raw disjunction. Keyed by the
// exact SPDX string from package.json.
const LICENSE_ELECTIONS: Record<string, string> = {
    '(MPL-2.0 OR Apache-2.0)': 'Apache-2.0',
};

interface PkgJson {
    name?: string;
    version?: string;
    license?: string;
    author?: string | { name?: string };
    dependencies?: Record<string, string>;
}

interface Attribution {
    name: string;
    license: string;
    copyright: string;
    licenseText: string;
    notice: string | null;
}

async function readJson<T>(path: string): Promise<T | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return JSON.parse(await file.text()) as T;
}

// Collect the union of runtime dependency names across the bundled packages,
// excluding our own workspace package.
async function collectDepNames(): Promise<string[]> {
    const names = new Set<string>();
    for (const pkg of BUNDLED_PACKAGES) {
        const json = await readJson<PkgJson>(
            resolve(ROOT, 'packages', pkg, 'package.json')
        );
        for (const dep of Object.keys(json?.dependencies ?? {})) {
            if (dep.startsWith('@courierai/')) continue;
            names.add(dep);
        }
    }
    return [...names].sort();
}

// Resolve a package's installed directory. Workspaces hoist to the root
// node_modules; fall back to the package-local one.
async function findPackageDir(name: string): Promise<string | null> {
    for (const base of [
        resolve(ROOT, 'node_modules'),
        ...BUNDLED_PACKAGES.map((p) =>
            resolve(ROOT, 'packages', p, 'node_modules')
        ),
    ]) {
        const dir = resolve(base, name);
        if (await Bun.file(resolve(dir, 'package.json')).exists()) return dir;
    }
    return null;
}

async function readLicenseText(dir: string): Promise<string | null> {
    for (const candidate of [
        'LICENSE',
        'LICENSE.md',
        'LICENSE.txt',
        'license',
        'License',
        'LICENSE-MIT',
    ]) {
        const file = Bun.file(resolve(dir, candidate));
        if (await file.exists()) return (await file.text()).trim();
    }
    return null;
}

// Apache-2.0 Section 4(d) requires reproducing a shipped NOTICE file's
// attribution text. We read it for every package (harmless when absent or
// under another license) and surface it in that package's block.
async function readNoticeText(dir: string): Promise<string | null> {
    for (const candidate of ['NOTICE', 'NOTICE.txt', 'NOTICE.md', 'notice']) {
        const file = Bun.file(resolve(dir, candidate));
        if (await file.exists()) {
            const text = (await file.text()).trim();
            if (text) return text;
        }
    }
    return null;
}

function authorName(author: PkgJson['author']): string | undefined {
    if (!author) return undefined;
    return typeof author === 'string' ? author : author.name;
}

// Best-effort copyright line: prefer a real "Copyright (c) YYYY ..." line
// lifted from the license file, else synthesize one from the package author.
// The year/(c) guard avoids matching prose lines in a bare license body (e.g.
// Apache's "...copyright notice that is included in or attached to the work").
function deriveCopyright(licenseText: string | null, author?: string): string {
    if (licenseText) {
        const line = licenseText
            .split('\n')
            .map((l) => l.trim())
            .find((l) => /^copyright\s+(\(c\)|©|\d)/i.test(l));
        if (line) return line.replace(/\.$/, '');
    }
    if (author) return `Copyright ${author}`;
    return 'Copyright held by the package author(s).';
}

async function buildAttribution(name: string): Promise<Attribution> {
    const dir = await findPackageDir(name);
    if (!dir) {
        throw new Error(
            `Package "${name}" not found in node_modules - run bun install first.`
        );
    }
    const json = (await readJson<PkgJson>(resolve(dir, 'package.json')))!;
    const licenseText = await readLicenseText(dir);
    const declared = json.license ?? 'UNKNOWN';
    return {
        name,
        license: LICENSE_ELECTIONS[declared] ?? declared,
        copyright: deriveCopyright(licenseText, authorName(json.author)),
        licenseText:
            licenseText ?? '(no LICENSE file shipped with this package)',
        notice: await readNoticeText(dir),
    };
}

function render(attributions: Attribution[]): string {
    const lines: string[] = [];
    lines.push('CourierAI Third-Party Licenses');
    lines.push('==============================');
    lines.push('');
    lines.push(
        'CourierAI bundles the following third-party software at runtime. Each'
    );
    lines.push(
        'entry lists the package, its copyright owner, and the license it ships'
    );
    lines.push(
        'under. The full text of each distinct license follows at the bottom.'
    );
    lines.push('');
    lines.push(
        'This file is generated by scripts/gen-third-party-licenses.ts - do not'
    );
    lines.push('edit by hand.');
    lines.push('');

    for (const a of attributions) {
        lines.push('');
        lines.push(a.name);
        lines.push('-'.repeat(a.name.length));
        lines.push(a.copyright);
        lines.push(`Licensed under: ${a.license}`);
        if (a.notice) {
            lines.push('');
            lines.push('NOTICE:');
            lines.push(a.notice);
        }
    }

    // One copy of each distinct license's full text, listed by the packages
    // that use it.
    const byLicense = new Map<string, Attribution[]>();
    for (const a of attributions) {
        const arr = byLicense.get(a.licenseText) ?? [];
        arr.push(a);
        byLicense.set(a.licenseText, arr);
    }

    for (const [text, pkgs] of byLicense) {
        lines.push('');
        lines.push('');
        lines.push('='.repeat(70));
        lines.push(`License text for: ${pkgs.map((p) => p.name).join(', ')}`);
        lines.push('='.repeat(70));
        lines.push('');
        lines.push(text);
    }

    return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
    const names = await collectDepNames();
    const attributions = await Promise.all(names.map(buildAttribution));

    console.log(`Resolved ${attributions.length} runtime dependencies:`);
    for (const a of attributions) {
        console.log(`  ${a.name} - ${a.license}`);
    }

    const content = render(attributions);
    if (WRITE) {
        await Bun.write(OUT, content);
        console.log(`\nWrote ${content.length} bytes to ${OUT}`);
    } else {
        console.log(
            '\n(dry run - pass --write to update THIRD_PARTY_LICENSES)'
        );
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
