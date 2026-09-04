import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './packages/airmailai_web/svelte.config.js';

export default defineConfig(
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/dist-ssr/**',
            '**/.output/**',
            '**/.wxt/**',
            '**/.deploy-tmp/**',
            '**/.tmp/**',
            '**/test-results/**',
            '**/playwright-report/**',
            '**/blob-report/**',
            '**/playwright/.cache/**',
            '**/*.zip',
            '**/VERSION',
            '**/VERSION_NAME',
            '**/logs/**',
            '**/*.log*',
        ],
    },
    js.configs.recommended,
    ts.configs.recommended,
    svelte.configs.recommended,
    svelte.configs.prettier,
    {
        files: ['**/*.{js,mjs,cjs,ts,svelte}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.webextensions,
                ...globals.node,
                __APP_VERSION__: 'readonly',
                __LEGAL_VERSION__: 'readonly',
            },
        },
    },
    {
        files: ['**/*.svelte', '**/*.svelte.{js,ts}'],
        languageOptions: {
            parserOptions: {
                parser: ts.parser,
                extraFileExtensions: ['.svelte'],
                svelteConfig,
            },
        },
    },
    {
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
            'no-empty': ['error', { allowEmptyCatch: true }],
            // *** Off: the rule flags any mutated Map/Set syntactically and
            // can't tell private handle registries or transient builders
            // inside $derived from UI-driving collections. We use
            // SvelteMap/SvelteSet only where reads must trigger re-renders.
            'svelte/prefer-svelte-reactivity': 'off',
        },
    },
    {
        files: ['**/*.svelte', '**/*.svelte.{js,ts}'],
        rules: {
            // *** Off: Svelte 5 tracks dependencies by observing reads, so a
            // reactive value referenced on its own line inside $effect or
            // $derived.by is a deliberate "re-run when this changes" signal,
            // not dead code. The rule can't tell that read from an unused
            // expression, and there is no other idiomatic way to declare a
            // dependency whose value the effect body doesn't otherwise need.
            '@typescript-eslint/no-unused-expressions': 'off',
        },
    }
);
