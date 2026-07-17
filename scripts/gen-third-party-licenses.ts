// *** Generates the third-party license notices from the runtime dependencies
// actually bundled into the shipped web app + extension, writing identical
// copies to the repo root (THIRD_PARTY_LICENSES), the website
// (static/legal/third-party-licenses.txt), and the extension package
// (public/third-party-licenses.txt). Walks
// the `dependencies` (not devDependencies) of courierai_web + courierai_ext,
// drops the workspace package (@courierai/shared), reads each
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
const OUTPUTS = [
    resolve(ROOT, 'THIRD_PARTY_LICENSES'),
    resolve(
        ROOT,
        'packages/courierai_web/static/legal/third-party-licenses.txt'
    ),
    resolve(ROOT, 'packages/courierai_ext/public/third-party-licenses.txt'),
];
const WRITE = process.argv.includes('--write');

const BUNDLED_PACKAGES = ['courierai_web', 'courierai_ext'];

// *** For dual/multi-licensed packages (SPDX "X OR Y"), the licensee picks which
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

// *** Canonical SPDX license bodies, substituted when a package declares a
// license in package.json but ships no LICENSE file in its npm tarball. The
// package's copyright line is preserved in its attribution block above the
// texts.
const KNOWN_LICENSE_TEXTS: Record<string, string> = {
    MIT: [
        'MIT License',
        '',
        'Permission is hereby granted, free of charge, to any person obtaining a copy',
        'of this software and associated documentation files (the "Software"), to deal',
        'in the Software without restriction, including without limitation the rights',
        'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
        'copies of the Software, and to permit persons to whom the Software is',
        'furnished to do so, subject to the following conditions:',
        '',
        'The above copyright notice and this permission notice shall be included in',
        'all copies or substantial portions of the Software.',
        '',
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
        'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
        'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
        'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
        'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
        'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
        'SOFTWARE.',
    ].join('\n'),
};

// *** Attributions for third-party works vendored directly into the source
// (not installed via npm), so the node_modules walk can't discover them.
const VENDORED_ATTRIBUTIONS: Attribution[] = [
    {
        name: 'Solarized (color palette)',
        license: 'MIT',
        copyright: 'Copyright (c) 2011 Ethan Schoonover',
        licenseText: [
            'Copyright (c) 2011 Ethan Schoonover',
            '',
            'Permission is hereby granted, free of charge, to any person obtaining a copy',
            'of this software and associated documentation files (the "Software"), to deal',
            'in the Software without restriction, including without limitation the rights',
            'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
            'copies of the Software, and to permit persons to whom the Software is',
            'furnished to do so, subject to the following conditions:',
            '',
            'The above copyright notice and this permission notice shall be included in',
            'all copies or substantial portions of the Software.',
            '',
            'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
            'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
            'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
            'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
            'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
            'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN',
            'THE SOFTWARE.',
        ].join('\n'),
        notice: null,
    },
];

async function readJson<T>(path: string): Promise<T | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return JSON.parse(await file.text()) as T;
}

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
    const license = LICENSE_ELECTIONS[declared] ?? declared;
    const resolvedText = licenseText ?? KNOWN_LICENSE_TEXTS[license];
    if (!resolvedText) {
        throw new Error(
            `Package "${name}" ships no LICENSE file and declares "${declared}", which has no entry in KNOWN_LICENSE_TEXTS.`
        );
    }
    return {
        name,
        license,
        copyright: deriveCopyright(licenseText, authorName(json.author)),
        licenseText: resolvedText,
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
    const attributions = [
        ...(await Promise.all(names.map(buildAttribution))),
        ...VENDORED_ATTRIBUTIONS,
    ].sort((a, b) => a.name.localeCompare(b.name));

    console.log(`Resolved ${attributions.length} attributions:`);
    for (const a of attributions) {
        console.log(`  ${a.name} - ${a.license}`);
    }

    const content = render(attributions);
    if (WRITE) {
        for (const out of OUTPUTS) {
            await Bun.write(out, content);
            console.log(`Wrote ${content.length} bytes to ${out}`);
        }
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
