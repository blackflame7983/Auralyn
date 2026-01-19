import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Constants
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(PROJECT_ROOT, 'src-tauri');
const RELEASE_DIR_PATH = path.join(SRC_TAURI, 'target', 'release');
const DEBUG_DIR_PATH = path.join(SRC_TAURI, 'target', 'debug');
const BIN_DIR = path.join(SRC_TAURI, 'bin');

// Binaries to process
const BINARIES = [
    'audio_engine',
    'plugin_scanner'
];

async function main() {
    console.log('Preparing sidecar binaries...');

    // Ensure bin directory exists
    if (!fs.existsSync(BIN_DIR)) {
        console.log(`Creating directory: ${BIN_DIR}`);
        fs.mkdirSync(BIN_DIR, { recursive: true });
    }

    for (const binName of BINARIES) {
        let sourcePath = path.join(RELEASE_DIR_PATH, `${binName}.exe`);

        // Check release first
        if (!fs.existsSync(sourcePath)) {
            // Fallback to debug
            const debugPath = path.join(DEBUG_DIR_PATH, `${binName}.exe`);
            if (fs.existsSync(debugPath)) {
                console.log(`Release binary not found, using DEBUG binary for ${binName}`);
                sourcePath = debugPath;
            } else {
                console.warn(`WARNING: Source binary not found at ${sourcePath} OR ${debugPath}`);
                console.warn('Make sure you have run `cargo build --release` (or `cargo build`) inside src-tauri before packaging.');
                process.exit(1);
            }
        } else {
            console.log(`Using RELEASE binary for ${binName}`);
        }

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
