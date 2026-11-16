import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import gardening from './scripts/gardening/eslint-plugin.mjs';

export default [{
    ignores: ['node_modules/**', 'dist/**', 'target/**', 'src-tauri/**', 'third_party/**', 'test-results/**'],
}, {
    files: ['src/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    languageOptions: {
        parser: tseslint.parser,
        parserOptions: { project: ['./tsconfig.json', './tsconfig.e2e.json'], tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks, auralyn: gardening },
    rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/ban-ts-comment': ['error', {
            'ts-ignore': true, 'ts-nocheck': true,
            'ts-expect-error': { descriptionFormat: '^: TS\\d+ .{10,}$' },
        }],
        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/no-unsafe-argument': 'error',
        '@typescript-eslint/no-unsafe-call': 'error',
        '@typescript-eslint/no-unsafe-member-access': 'error',
        '@typescript-eslint/no-unsafe-return': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/no-require-imports': 'error',
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'error',
        'auralyn/owned-effects': 'error',
        'auralyn/owned-timers': 'error',
        'auralyn/architecture': 'error',
        'auralyn/no-double-assertion': 'error',
        'auralyn/no-suppression': 'error',
        'auralyn/no-comment-workaround': 'error',
        'auralyn/no-literal-color': 'error',
    },
}, {
    files: ['e2e/**/*.ts'],
    rules: { 'react-hooks/rules-of-hooks': 'off', 'react-hooks/exhaustive-deps': 'off' },
}];
