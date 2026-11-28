import fs from 'node:fs';
import path from 'node:path';
import { digest } from './baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
export const policyHash = value => digest(value.replaceAll('\r\n', '\n'));
export function policyContent(file) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('Cargo.toml')) {
        let lintSection = false;
        return source.split(/\r?\n/).filter(line => {
            if (/^\[/.test(line)) lintSection = /^\[lints(?:\.|\])/.test(line);
            return lintSection;
        }).join('\n');
    }
    if (file !== 'package.json') return source;
    const pkg = JSON.parse(source);
    return JSON.stringify({ scripts: pkg.scripts });
}
export function policyErrors(actual, expected) {
    const errors = [];
    for (const [file, hash] of Object.entries(expected)) if (actual[file] !== hash) errors.push(`${file}: ガード設定・例外台帳が承認済み指紋と異なります。通過のために設定を緩和せず、人間の承認と独立したレビューを得てください。`);
    for (const file of Object.keys(actual)) if (!(file in expected)) errors.push(`${file}: 未登録のガードファイルです。レビュー対象に加えてください。`);
    return errors;
}

export function policyFiles() {
    return [
        'package.json', 'ruff.toml', 'requirements-dev.txt',
        'src-tauri/Cargo.toml', 'src-tauri/crates/auralyn-core/Cargo.toml', 'src-tauri/crates/auralyn-ui-model/Cargo.toml', 'src-gpui/Cargo.toml', 'src-tauri/clippy.toml', 'config/gardening-python-baseline.json',
        'config/gardening-rust-baseline.json',
        '.github/workflows/frontend-quality.yml', '.github/workflows/rustsec-audit.yml', '.github/CODEOWNERS',
        'scripts/verify.mjs', ...fs.readdirSync(path.join(root, 'scripts/gardening')).filter(file => /\.(?:mjs|py)$/.test(file)).map(file => `scripts/gardening/${file}`),
    ];
}

export function checkPolicy() {
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'config/gardening-policy.json'), 'utf8')).files;
    const actual = Object.fromEntries(policyFiles().map(file => [file, fs.existsSync(path.join(root, file)) ? policyHash(policyContent(file)) : null]));
    const errors = policyErrors(actual, expected);
    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    if (agents.split(/\r?\n/).length > 150) errors.push('AGENTS.mdは150行以内にしてください。機械化した規則を重複掲載しないでください。');
    if (fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8').trim() !== '@AGENTS.md') errors.push('CLAUDE.mdは@AGENTS.mdだけを参照してください。');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Policy PASS (設定指紋・文書入口)');
}
