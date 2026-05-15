// DO NOT replace these explicit imports with the auto-bundle (`from 'shiki'`).
// The auto-bundle dynamic-imports every theme + language Shiki ships, which
// Vite emits as 300+ chunks (~11 MB) into dist/assets even though we only use
// github-dark + 19 langs. Stay on shiki/core + explicit subpath imports.
// Any byte change to this file invalidates the chunk hash (~2 MB re-download
// for all users), so prefer not to touch unless the lang/theme change is
// worth that cost.
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
// JS regex engine over Oniguruma (wasm): smaller, no wasm fetch, sufficient.
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import bash from 'shiki/langs/bash.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import css from 'shiki/langs/css.mjs';
import go from 'shiki/langs/go.mjs';
import html from 'shiki/langs/html.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import python from 'shiki/langs/python.mjs';
import rust from 'shiki/langs/rust.mjs';
import sh from 'shiki/langs/sh.mjs';
import sql from 'shiki/langs/sql.mjs';
import toml from 'shiki/langs/toml.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import githubDark from 'shiki/themes/github-dark.mjs';

export function createMarkdownHighlighter(): Promise<HighlighterCore> {
    return createHighlighterCore({
        themes: [githubDark],
        langs: [
            bash,
            c,
            cpp,
            css,
            go,
            html,
            java,
            javascript,
            json,
            jsx,
            markdown,
            python,
            rust,
            sh,
            sql,
            toml,
            tsx,
            typescript,
            yaml,
        ],
        engine: createJavaScriptRegexEngine(),
    });
}
