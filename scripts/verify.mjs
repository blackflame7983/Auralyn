import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkPolicy } from './gardening/policy.mjs';
import { selectTests } from './gardening/selection.mjs';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const args = process.argv.slice(2);
const known = new Set(['--full', '--changed', '--static', '--feature', '--browser', '--rust']);
const featureIndex = args.indexOf('--feature');
const featureName = featureIndex >= 0 ? args[featureIndex + 1] : undefined;
const invalid = args.filter((arg, index) => !known.has(arg) && !(featureIndex >= 0 && index === featureIndex + 1));
if (invalid.length || (featureIndex >= 0 && (!featureName || featureName.startsWith('--')))) {
    console.error('使い方: npm run verify -- [--changed|--full|--static|--feature connection|home|vst|voice-check|restore] [--browser] [--rust]');
    process.exit(1);
}
const features = JSON.parse(fs.readFileSync('config/verification-features.json', 'utf8'));
if (featureName && !Object.hasOwn(features, featureName)) { console.error(`未知の機能です: ${featureName}`); process.exit(1); }
if (['--full', '--changed', '--static', '--feature'].filter(mode => args.includes(mode)).length > 1) { console.error('検証モードは1つだけ指定してください。'); process.exit(1); }
if (args.includes('--browser') && !featureName) { console.error('--browserは--featureと一緒に指定してください。'); process.exit(1); }
const changed = () => [...new Set([
    ...execFileSync('git', ['diff', 'HEAD', '--name-only', '--no-renames', '-z'], { encoding: 'utf8' }).split('\0'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', 'src', 'src-tauri/src', 'src-tauri/crates', 'e2e', 'scripts', 'config', 'docs', 'AGENTS.md', 'CLAUDE.md', 'eslint.config.mjs', 'ruff.toml', 'requirements-dev.txt'], { encoding: 'utf8' }).split('\0'),
])].filter(Boolean);
const files = changed();
const selection = featureName ? { full: false, tests: features[featureName].tests } : args.includes('--full') ? { full: true, tests: [] } : selectTests(files, features);
const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
const output = path.join(root, 'test-results/gardening', runId);
fs.mkdirSync(output, { recursive: true });
const steps = [];

function run(name, command, commandArgs, options = {}) {
    const log = path.join(output, `${steps.length + 1}-${name}.log`);
    const fd = fs.openSync(log, 'w');
    const started = Date.now();
    console.log(`RUN ${name}`);
    let result;
    try { result = spawnSync(command, commandArgs, { cwd: root, stdio: ['ignore', fd, fd], ...options }); }
    finally { fs.closeSync(fd); }
    const step = { name, status: result.status === 0 ? 'PASS' : 'FAIL', seconds: (Date.now() - started) / 1000, command: [command, ...commandArgs], log };
    steps.push(step);
    console.log(`${step.status} ${name} (${step.seconds.toFixed(1)}s)`);
    if (result.error || result.status !== 0) {
        console.error(result.error?.message ?? fs.readFileSync(log, 'utf8').split(/\r?\n/).slice(-45).join('\n'));
        throw new Error(`詳細: ${log}\n再実行: ${[command, ...commandArgs].map(value => JSON.stringify(value)).join(' ')}`);
    }
}

const node = (name, script, ...values) => run(name, process.execPath, [script, ...values]);
try {
    checkPolicy();
    node('lint', 'scripts/gardening/lint.mjs');
    node('python', 'scripts/gardening/python.mjs');
    node('rust-policy', 'scripts/gardening/rust.mjs');
    run('guard-tests', process.execPath, ['--test', ...fs.readdirSync('scripts/gardening').filter(file => file.endsWith('.test.mjs')).map(file => `scripts/gardening/${file}`)]);
    node('types', 'node_modules/typescript/bin/tsc', '--noEmit');
    node('browser-types', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.e2e.json');
    node('terms', 'scripts/check-ui-terms.cjs');
    node('dev-preview-urls', 'scripts/check-dev-preview-urls.cjs');
    const changedOnly = !args.includes('--full') && !args.includes('--static') && !featureName;
    node('control-chars', 'scripts/check-control-chars.cjs', ...(changedOnly ? ['--files', ...files] : []));
    if (!args.includes('--static')) {
        if (selection.full || selection.tests.length) node('vitest', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=dot', ...(selection.full ? [] : selection.tests));
        else console.log('SKIP tests: 文書のみ、または未コミットの変更なし。コミット済み変更は--feature/--fullで指定してください。');
        if (selection.full) {
            node('frontend-build', 'node_modules/vite/bin/vite.js', 'build');
            run('distribution-tests', process.execPath, ['--test', ...fs.readdirSync('scripts').filter(file => file.endsWith('.test.cjs')).map(file => `scripts/${file}`)]);
            node('release-policy', 'scripts/check-release-readiness.cjs');
        }
    }
    if (args.includes('--browser')) node('browser', 'node_modules/@playwright/test/cli.js', 'test', ...features[featureName].browser);
    if (args.includes('--rust')) {
        const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--no-deps', '--format-version', '1'], { encoding: 'utf8' }));
        const drive = path.parse(metadata.target_directory).root.match(/^([A-Za-z]):/)?.[1];
        if (!drive) throw new Error('WindowsのCargo保存先ドライブを特定できません。BUILD_GUIDE.mdに従って確認してください。');
        console.log(`Cargo target: ${metadata.target_directory}`);
        run('rust-capacity', 'powershell', ['-NoProfile', '-Command', '$d = Get-PSDrive -Name $env:AURALYN_BUILD_DRIVE; if ($d.Free -lt 12GB) { throw "Rust検証には保存先に12 GiB以上の空きが必要です" }; Get-Process cargo,rustc -ErrorAction SilentlyContinue | ForEach-Object { throw "別のRustビルドが実行中です" }; exit 0'], { env: { ...process.env, AURALYN_BUILD_DRIVE: drive } });
        run('rust-fmt', 'cargo', ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--all', '--', '--check']);
        run('rust-clippy', 'cargo', ['clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--workspace', '--all-targets', '--', '-D', 'warnings']);
        run('rust-core', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '-p', 'auralyn-core']);
        for (const filter of ['gain_ramp::', 'comparison::', 'native_stream::']) run(`rust-${filter.replaceAll(':', '')}`, 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--lib', filter]);
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
} finally {
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ selection, steps, success: !process.exitCode }, null, 2));
    console.log(`検証記録: ${output}`);
}
