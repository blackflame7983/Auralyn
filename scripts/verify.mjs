import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkPolicy } from './gardening/policy.mjs';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const args = process.argv.slice(2);
const known = new Set(['--full', '--changed', '--static', '--rust']);
if (args.some(arg => !known.has(arg))) {
    console.error('使い方: npm run verify -- [--changed|--full|--static] [--rust]');
    process.exit(1);
}
if (['--full', '--changed', '--static'].filter(mode => args.includes(mode)).length > 1) { console.error('検証モードは1つだけ指定してください。'); process.exit(1); }
const changed = () => [...new Set([
    ...execFileSync('git', ['diff', 'HEAD', '--name-only', '--no-renames', '-z'], { encoding: 'utf8' }).split('\0'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', 'crates', 'src-gpui', 'scripts', 'config', 'docs', 'AGENTS.md', 'CLAUDE.md', 'ruff.toml', 'requirements-dev.txt'], { encoding: 'utf8' }).split('\0'),
])].filter(Boolean);
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
    node('python', 'scripts/gardening/python.mjs');
    node('rust-policy', 'scripts/gardening/rust.mjs');
    run('guard-tests', process.execPath, ['--test', ...fs.readdirSync('scripts/gardening').filter(file => file.endsWith('.test.mjs')).map(file => `scripts/gardening/${file}`)]);
    node('terms', 'scripts/check-ui-terms.cjs');
    const changedOnly = !args.includes('--full') && !args.includes('--static');
    node('control-chars', 'scripts/check-control-chars.cjs', ...(changedOnly ? ['--files', ...changed()] : []));
    if (args.includes('--full')) {
        run('distribution-tests', process.execPath, ['--test', ...fs.readdirSync('scripts').filter(file => file.endsWith('.test.cjs')).map(file => `scripts/${file}`)]);
    }
    if (args.includes('--rust')) {
        const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], { encoding: 'utf8' }));
        const drive = path.parse(metadata.target_directory).root.match(/^([A-Za-z]):/)?.[1];
        if (!drive) throw new Error('WindowsのCargo保存先ドライブを特定できません。BUILD_GUIDE.mdに従って確認してください。');
        console.log(`Cargo target: ${metadata.target_directory}`);
        run('rust-capacity', 'powershell', ['-NoProfile', '-Command', '$d = Get-PSDrive -Name $env:AURALYN_BUILD_DRIVE; if ($d.Free -lt 12GB) { throw "Rust検証には保存先に12 GiB以上の空きが必要です" }; Get-Process cargo,rustc -ErrorAction SilentlyContinue | ForEach-Object { throw "別のRustビルドが実行中です" }; exit 0'], { env: { ...process.env, AURALYN_BUILD_DRIVE: drive } });
        run('rust-fmt', 'cargo', ['fmt', '--all', '--', '--check']);
        run('rust-clippy', 'cargo', ['clippy', '--locked', '--workspace', '--all-targets', '--', '-D', 'warnings']);
        run('rust-core', 'cargo', ['test', '--locked', '-p', 'auralyn-core', '-p', 'auralyn-ui-model']);
        for (const filter of ['gain_ramp::', 'comparison::', 'native_stream::']) run(`rust-${filter.replaceAll(':', '')}`, 'cargo', ['test', '--locked', '-p', 'vst-host', '--lib', filter]);
        run('gpui-test', 'cargo', ['test', '--locked', '-p', 'auralyn-gpui']);
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
} finally {
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ steps, success: !process.exitCode }, null, 2));
    console.log(`検証記録: ${output}`);
}
