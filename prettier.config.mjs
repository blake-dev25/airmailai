export default {
    plugins: ['prettier-plugin-svelte'],
    tabWidth: 4,
    useTabs: false,
    singleQuote: true,
    trailingComma: 'es5',
    quoteProps: 'preserve',
    overrides: [
        {
            files: '*.svelte',
            options: {
                parser: 'svelte',
            },
        },
    ],
};
