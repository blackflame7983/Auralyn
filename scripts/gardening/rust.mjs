import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, reconcile } from './baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
export function rustFindings() {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'src-tauri/src'], { cwd: root, encoding: 'utf8' }).split('\0').filter(file => file.endsWith('.rs'));
    const result = [];
    for (const file of [...new Set(files)]) {
        if (!fs.existsSync(path.join(root, file))) continue;
        const source = fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
        const suppressions = [...source.matchAll(/#\s*!?\[\s*(?:allow|expect)\b[\s\S]*?\]/g)];
        if (suppressions.length) result.push({ file, rule: 'rust/suppression', hash: digest(source), count: suppressions.length, line: 1, message: 'Rustの新規allow/expectは承認が必要です。対象の警告を修正し、既存例外は理由を維持してください。' });
    }
    return result;
}

export function checkRust() {
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'config/gardening-rust-baseline.json'), 'utf8'));
    const errors = reconcile(rustFindings(), baseline.entries);
    const rtGuard = '#![cfg_attr(not(test), deny(clippy::disallowed_methods, clippy::disallowed_types))]';
    for (const file of ['gain_ramp.rs', 'comparison.rs']) {
        if (!fs.readFileSync(path.join(root, 'src-tauri/src/audio_engine', file), 'utf8').includes(rtGuard)) errors.push(`${file}: RT用の禁止API/型検査を削除しないでください。`);
    }
    const native = fs.readFileSync(path.join(root, 'src-tauri/src/audio_engine/core/native_stream.rs'), 'utf8').replaceAll('\r\n', '\n');
    for (const callback of ['input_samples', 'output_samples']) if (!native.includes(`#[deny(clippy::disallowed_methods, clippy::disallowed_types)]\nfn ${callback}`)) errors.push(`${callback}: RT境界のClippy検査がありません。`);
    if (!fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8').includes('#![deny(clippy::await_holding_lock)]')) errors.push('Rustのawait_holding_lock検査を維持してください。');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Rust policy PASS (抑制・RT検査の適用範囲。コンパイルは--rustで実行)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { checkRust(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
