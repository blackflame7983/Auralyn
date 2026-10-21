const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const script = path.join(__dirname, 'measure-release-trial.ps1');
const quote = value => `'${value.replaceAll("'", "''")}'`;

for (const shell of ['powershell.exe', 'pwsh']) {
    test(`${shell}: 長時間測定スクリプトを構文解析できる`, { skip: process.platform !== 'win32' }, () => {
        const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
            `$tokens=$null; $errors=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$errors); if($errors.Count){exit 1}`], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    });
    test(`${shell}: ホスト以外のPIDでは測定せず出力先も作成しない`, { skip: process.platform !== 'win32' }, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auralyn-trial-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const output = path.join(root, 'samples');
        const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command',
            `& ${quote(script)} -HostProcessId ${process.pid} -OutputDirectory ${quote(output)} -DurationSeconds 1`], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.equal(fs.existsSync(output), false);
    });
}
