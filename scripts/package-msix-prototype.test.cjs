const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const script = path.join(__dirname, 'package-msix-prototype.ps1');
const binaries = ['AuralynHost.exe', 'audio_engine.exe', 'plugin_scanner.exe'];

function fixture(t, machine = 0x8664) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auralyn-msix-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtime = path.join(root, 'runtime');
    fs.mkdirSync(runtime);
    const pe = Buffer.alloc(256);
    pe.writeUInt16LE(0x5a4d, 0);
    pe.writeUInt32LE(128, 0x3c);
    pe.writeUInt32LE(0x4550, 128);
    pe.writeUInt16LE(machine, 132);
    for (const name of binaries) fs.writeFileSync(path.join(runtime, name), pe);
    return { root, runtime, output: path.join(root, 'output') };
}

function quote(value) {
    return `'${value.replaceAll("'", "''")}'`;
}

function runCode(shell, code) {
    // 5.1でも日本語エラーをUTF-8で取得し、構文エラーとの取り違えを防ぐ。
    return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command',
        `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${code}`],
    { encoding: 'utf8' });
}

function run(shell, f, version) {
    const versionArg = version ? ` -PackageVersion ${quote(version)}` : '';
    return runCode(shell, `& ${quote(script)} -RuntimeDirectory ${quote(f.runtime)} -OutputDirectory ${quote(f.output)}${versionArg}`);
}

const windowsOnly = { skip: process.platform !== 'win32' };

for (const shell of ['powershell.exe', 'pwsh']) {
    test(`${shell}: MSIX作成スクリプトを構文解析できる`, windowsOnly, () => {
        const result = runCode(shell, `$tokens = $null; $parseErrors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$parseErrors); if ($parseErrors.Count) { $parseErrors | Out-String | Write-Error; exit 1 }`);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
    });

    test(`${shell}: MSIX作成は既存の出力先を変更しない`, windowsOnly, t => {
        const f = fixture(t);
        fs.mkdirSync(f.output);
        const marker = path.join(f.output, 'existing.txt');
        fs.writeFileSync(marker, 'preserve');
        const result = run(shell, f);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /既存の試験結果は上書きしません/);
        assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve');
        assert.deepEqual(fs.readdirSync(f.output), ['existing.txt']);
    });

    test(`${shell}: MSIX作成は欠損したサイドカーを配置前に拒否する`, windowsOnly, t => {
        const f = fixture(t);
        fs.unlinkSync(path.join(f.runtime, 'audio_engine.exe'));
        const result = run(shell, f);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /release実行ファイルが不足/);
        assert.equal(fs.existsSync(f.output), false);
    });

    test(`${shell}: MSIX作成はx86実行ファイルをx64として梱包しない`, windowsOnly, t => {
        const f = fixture(t, 0x14c);
        const result = run(shell, f);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Windows x64実行ファイルではありません/);
        assert.equal(fs.existsSync(f.output), false);
    });

    test(`${shell}: MSIX作成は不正なPEオフセットを配置前に拒否する`, windowsOnly, t => {
        const f = fixture(t);
        const file = path.join(f.runtime, 'plugin_scanner.exe');
        const pe = fs.readFileSync(file);
        pe.writeUInt32LE(0xffffffff, 0x3c);
        fs.writeFileSync(file, pe);
        const result = run(shell, f);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /PEヘッダーが不正/);
        assert.equal(fs.existsSync(f.output), false);
    });

    test(`${shell}: MSIX作成は範囲外のバージョンを配置前に拒否する`, windowsOnly, t => {
        const f = fixture(t);
        const result = run(shell, f, '1.65536.0.0');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /65535以下/);
        assert.equal(fs.existsSync(f.output), false);
    });
}
