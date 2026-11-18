import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertKnownFlags } from './cli-flags';

const ROOT = resolve(import.meta.dir, '..');
const OUTPUTS = [
    resolve(ROOT, 'THIRD_PARTY_LICENSES'),
    resolve(
        ROOT,
        'packages/airmailai_web/static/legal/third-party-licenses.txt'
    ),
    resolve(ROOT, 'packages/airmailai_ext/public/third-party-licenses.txt'),
];
const args = process.argv.slice(2);
const WRITE = args.includes('--write');

const BUNDLED_PACKAGES = ['airmailai_web', 'airmailai_ext'];
const WORKSPACE_SCOPE = '@airmailai/';
const LICENSE_FILE = /^(licen[sc]e|copying)([-.].*)?$/i;
const NOTICE_FILE = /^notice([-.].*)?$/i;

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
    license?: unknown;
    licenses?: unknown;
    author?: string | { name?: string };
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

interface Attribution {
    name: string;
    version: string | null;
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
        version: null,
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

function findInstalledDir(name: string, fromDir: string): string | null {
    let dir = fromDir;
    for (;;) {
        const candidate = resolve(dir, 'node_modules', name);
        if (existsSync(resolve(candidate, 'package.json'))) {
            return realpathSync(candidate);
        }
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

async function collectPackageDirs(): Promise<string[]> {
    const queue = BUNDLED_PACKAGES.map((pkg) =>
        realpathSync(resolve(ROOT, 'packages', pkg))
    );
    const seen = new Set(queue);
    const thirdParty: string[] = [];
    for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
        const json = await readJson<PkgJson>(resolve(dir, 'package.json'));
        if (!json?.name) throw new Error(`No package name in ${dir}`);
        const isOurs =
            BUNDLED_PACKAGES.includes(json.name) ||
            json.name.startsWith(WORKSPACE_SCOPE);
        if (!isOurs) thirdParty.push(dir);
        const edges = [
            { deps: json.dependencies, optional: false },
            { deps: json.optionalDependencies, optional: true },
        ];
        for (const { deps, optional } of edges) {
            for (const dep of Object.keys(deps ?? {})) {
                const depDir = findInstalledDir(dep, dir);
                if (!depDir) {
                    if (optional) continue;
                    throw new Error(
                        `Package "${dep}" (required by ${json.name}) not found in node_modules - run bun install first.`
                    );
                }
                if (seen.has(depDir)) continue;
                seen.add(depDir);
                queue.push(depDir);
            }
        }
    }
    return thirdParty;
}

async function readMatchingFiles(
    dir: string,
    pattern: RegExp
): Promise<string | null> {
    const names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && pattern.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    const texts: string[] = [];
    for (const name of names) {
        const text = (await Bun.file(resolve(dir, name)).text()).trim();
        if (text) texts.push(names.length > 1 ? `[${name}]\n\n${text}` : text);
    }
    return texts.length > 0 ? texts.join('\n\n') : null;
}

function declaredLicense(json: PkgJson): string | null {
    const typeOf = (value: unknown): string | null => {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object' && 'type' in value) {
            return typeof value.type === 'string' ? value.type : null;
        }
        return null;
    };
    const single = typeOf(json.license);
    if (single) return single;
    if (!Array.isArray(json.licenses)) return null;
    const types = json.licenses.flatMap((entry) => typeOf(entry) ?? []);
    if (types.length === 0) return null;
    return types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
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

async function buildAttribution(dir: string): Promise<Attribution> {
    const json = (await readJson<PkgJson>(resolve(dir, 'package.json')))!;
    const name = json.name!;
    const licenseText = await readMatchingFiles(dir, LICENSE_FILE);
    const declared = declaredLicense(json);
    if (!declared) {
        throw new Error(
            `Package "${name}" declares no license in its package.json.`
        );
    }
    const license = LICENSE_ELECTIONS[declared] ?? declared;
    if (/\sOR\s/.test(license)) {
        throw new Error(
            `Package "${name}" is offered under "${declared}" - record the license we rely on in LICENSE_ELECTIONS.`
        );
    }
    const resolvedText = licenseText ?? KNOWN_LICENSE_TEXTS[license];
    if (!resolvedText) {
        throw new Error(
            `Package "${name}" ships no LICENSE file and declares "${declared}", which has no entry in KNOWN_LICENSE_TEXTS.`
        );
    }
    return {
        name,
        version: json.version ?? null,
        license,
        copyright: deriveCopyright(licenseText, authorName(json.author)),
        licenseText: resolvedText,
        notice: await readMatchingFiles(dir, NOTICE_FILE),
    };
}

function mergeVersions(attributions: Attribution[]): Attribution[] {
    const byName = new Map<string, Map<string, Attribution>>();
    for (const a of attributions) {
        const terms = JSON.stringify([
            a.license,
            a.copyright,
            a.licenseText,
            a.notice,
        ]);
        const distinct = byName.get(a.name) ?? new Map<string, Attribution>();
        if (!distinct.has(terms)) distinct.set(terms, a);
        byName.set(a.name, distinct);
    }
    return [...byName.values()].flatMap((distinct) =>
        distinct.size === 1
            ? [...distinct.values()]
            : [...distinct.values()].map((a) => ({
                  ...a,
                  name: `${a.name} ${a.version}`,
              }))
    );
}

function render(attributions: Attribution[]): string {
    const lines: string[] = [];
    lines.push('AirmailAI Third-Party Licenses');
    lines.push('==============================');
    lines.push('');
    lines.push(
        'AirmailAI is built from the following third-party software: its runtime'
    );
    lines.push(
        'dependencies and everything they depend on in turn. Each entry lists the'
    );
    lines.push(
        'package, its copyright owner, and the license it ships under. The full'
    );
    lines.push('text of each distinct license follows at the bottom.');
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
    assertKnownFlags(args, ['--write']);
    const dirs = await collectPackageDirs();
    const attributions = [
        ...mergeVersions(await Promise.all(dirs.map(buildAttribution))),
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
