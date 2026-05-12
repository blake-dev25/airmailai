import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './packages/courierai_web/svelte.config.js';

export default defineConfig(
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/dist-ssr/**',
            '**/.output/**',
            '**/.wxt/**',
            '**/.deploy-tmp/**',
            '**/*.zip',
            '**/VERSION',
            '**/VERSION_NAME',
            '**/build-counter.json',
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
                ...(globals.webextensions ?? {}),
                ...globals.node,
                ...(globals.bun ?? {}),
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
            'svelte/prefer-svelte-reactivity': 'off',
        },
    },
    {
        files: ['**/*.svelte'],
        rules: {
            '@typescript-eslint/no-unused-expressions': 'off',
        },
    }
);
