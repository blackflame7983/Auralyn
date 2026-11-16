import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reconcile } from './baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
export function pythonFindings() {
    const local = path.join(root, 'node_modules/.cache/auralyn-python');
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    if (fs.existsSync(path.join(local, 'ruff'))) env.PYTHONPATH = local;
    const result = spawnSync(process.env.AURALYN_PYTHON ?? 'python', ['scripts/gardening/python-check.py'], { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Python検査を実行できません。python -m pip install --target node_modules/.cache/auralyn-python -r requirements-dev.txt を実行してください。\n${result.error?.message ?? result.stderr}`);
    return JSON.parse(result.stdout);
}

export function checkPython() {
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'config/gardening-python-baseline.json'), 'utf8'));
    const errors = reconcile(pythonFindings(), baseline.entries);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Python PASS (Ruff・抑制検査)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { checkPython(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
