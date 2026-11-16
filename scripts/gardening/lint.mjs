import { ESLint } from 'eslint';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupFindings, reconcile } from './baseline.mjs';

export const root = path.resolve(import.meta.dirname, '../..');
export async function findings() {
    const eslint = new ESLint({ cwd: root, allowInlineConfig: false, overrideConfigFile: path.join(root, 'eslint.config.mjs') });
    const results = await eslint.lintFiles(['src/**/*.{ts,tsx}', 'e2e/**/*.ts']);
    return groupFindings(results, file => fs.readFileSync(file, 'utf8'), file => path.relative(root, file).replaceAll('\\', '/'));
}

export async function lint() {
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'config/gardening-baseline.json'), 'utf8'));
    if (baseline.version !== 1) throw new Error('未対応のBaseline形式です');
    const actual = await findings();
    const errors = reconcile(actual, baseline.entries);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(`Lint PASS (${actual.reduce((count, entry) => count + entry.count, 0)}件の固定済み既存例外)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { await lint(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
