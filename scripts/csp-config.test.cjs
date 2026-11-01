const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));

test('製品CSPはIPCとローカル資産を許可し、外部接続や動的なスクリプト実行を許可しない', () => {
    assert.equal(config.app.withGlobalTauri, false);
    const csp = config.app.security.csp;
    assert.equal(csp['default-src'], "'self'");
    assert.equal(csp['script-src'], "'self'");
    assert.equal(csp['style-src-attr'], "'unsafe-inline'");
    assert.equal(csp['img-src'], "'self' data:");
    assert.deepEqual(csp['connect-src'].split(' '), ["'self'", 'ipc:', 'http://ipc.localhost']);
    assert.equal(csp['object-src'], "'none'");
    assert.equal(csp['base-uri'], "'none'");
    assert.equal(csp['frame-src'], "'none'");
    assert.notEqual(config.app.security.dangerousDisableAssetCspModification, true);
    const dev = config.app.security.devCsp;
    assert.equal(dev['script-src'], csp['script-src']);
    assert.deepEqual(dev['connect-src'].split(' '), [...csp['connect-src'].split(' '), 'ws://localhost:1420', 'ws://127.0.0.1:1427']);
});

test('製品エントリは検証専用のグローバルAPIに依存しない', () => {
    function scan(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '__tests__') continue;
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) scan(file);
            else if (/\.(?:[cm]?[jt]sx?|html)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
                assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /(?:window|globalThis)\s*(?:\.\s*__TAURI__|\[\s*['"]__TAURI__['"]\s*\])/,
                    path.relative(root, file));
            }
        }
    }
    scan(path.join(root, 'src'));
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /__TAURI__/);
    const debug = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.debug-global.conf.json'), 'utf8'));
    assert.equal(debug.app.withGlobalTauri, true);
});
