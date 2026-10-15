import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Constants
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(PROJECT_ROOT, 'src-tauri');
const RELEASE_DIR_PATH = path.join(SRC_TAURI, 'target', 'release');
const BIN_DIR = path.join(SRC_TAURI, 'bin');

// Binaries to process
const BINARIES = [
    'audio_engine',
    'plugin_scanner'
];

function buildReleaseSidecars() {
    console.log('Building release sidecar binaries...');
    const result = spawnSync(
        'cargo',
        ['build', '--locked', '--release', '--bin', 'audio_engine', '--bin', 'plugin_scanner'],
        {
            cwd: SRC_TAURI,
            stdio: 'inherit'
        }
    );

    if (result.status !== 0) {
        throw new Error(`cargo build --release for sidecars failed with exit code ${result.status}`);
    }
}

async function main() {
    console.log('Preparing sidecar binaries...');
    buildReleaseSidecars();

    // 両方のrelease成果物を確認してからコピーし、古いdebug版の混入を防ぐ。
    for (const binName of BINARIES) {
        const sourcePath = path.join(RELEASE_DIR_PATH, `${binName}.exe`);
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Release binary not found: ${sourcePath}`);
        }
    }

    // Ensure bin directory exists
    if (!fs.existsSync(BIN_DIR)) {
        console.log(`Creating directory: ${BIN_DIR}`);
        fs.mkdirSync(BIN_DIR, { recursive: true });
    }

    for (const binName of BINARIES) {
        const sourcePath = path.join(RELEASE_DIR_PATH, `${binName}.exe`);

        const targetName = `${binName}-${TARGET_TRIPLE}.exe`;
        const targetPath = path.join(BIN_DIR, targetName);

        console.log(`Copying ${binName}.exe to ${targetName}...`);
        fs.copyFileSync(sourcePath, targetPath);
        console.log(`Successfully verified: ${targetPath}`);
    }

    console.log('Sidecar preparation complete.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
