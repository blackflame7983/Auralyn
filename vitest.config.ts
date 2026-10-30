import { defineConfig } from 'vitest/config';
import path from 'path';

// DOM・Storage・windowイベントを使わないテストだけをNodeへ分離する。
const nodeTests = [
    'src/__tests__/{bootstrapTheme,themeContrast}.test.ts',
    'src/lib/__tests__/{clientError,obsUiText,shortcutNotice,usageWindow}.test.ts',
    'src/api/__tests__/{audio,bundles,liveModes,obs,voiceCheckPreview}.test.ts',
    'src/i18n/__tests__/messageCatalog.test.ts',
    'src/components/layout/__tests__/recentCohort.test.ts',
    'src/components/features/SetupWizard/__tests__/wizardModel.test.ts',
];

export default defineConfig({
    test: {
        // CPU数による過剰な同時起動を避ける。CLIの--maxWorkersで変更できる。
        maxWorkers: 4,
        projects: [
            { extends: true, test: {
                name: 'unit', environment: 'node', globals: true,
                include: nodeTests, setupFiles: ['src/__tests__/setupTauri.ts'],
            } },
            { extends: true, test: {
                name: 'dom', environment: 'jsdom', globals: true,
                include: ['src/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
                exclude: nodeTests, setupFiles: ['src/__tests__/setup.ts'],
            } },
        ],
    },
    resolve: {
        alias: {
            '@': path.resolve(import.meta.dirname, './src'),
        },
    },
});
