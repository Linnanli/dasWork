import tseslint from '@electron-toolkit/eslint-config-ts';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/protocol/app-server-protocol/**'],
    },
    ...tseslint.configs.base,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {
            '@typescript-eslint': tseslint.plugin,
        },
        rules: {
            ...tseslint.plugin.configs['recommended-type-checked'].rules,

            // TypeScript handles undefined references; no-undef causes false positives
            // for TypeScript global types like NodeJS.Timeout
            'no-undef': 'off',

            'curly': 'warn',
            'eqeqeq': 'warn',
            'no-dupe-keys': 'error',

            '@typescript-eslint/no-explicit-any': 'error',

            '@typescript-eslint/consistent-type-imports': ['error', {
                prefer: 'type-imports',
                fixStyle: 'separate-type-imports',
            }],

            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],

            '@typescript-eslint/no-unused-expressions': ['error', {
                allowShortCircuit: true,
            }],

            '@typescript-eslint/naming-convention': ['warn', {
                selector: 'import',
                format: ['camelCase', 'PascalCase'],
            }],

            'max-lines': ['warn', { max: 2000, skipBlankLines: true, skipComments: true }],
        },
    },
);
