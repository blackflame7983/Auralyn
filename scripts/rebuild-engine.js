import { spawn } from 'child_process';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(PROJECT_ROOT, 'src-tauri');
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
const BIN_DIR = path.join(SRC_TAURI, 'bin');

// Helper to run command
function runCommand(command, args, cwd) {
    return new Promise((resolve, reject) => {
        console.log(`Running: ${command} ${args.join(' ')}`);
        const proc = spawn(command, args, {
            cwd,
            stdio: 'inherit',
            shell: true
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });
    });
}

async function main() {
    console.log('🚧 Rebuilding Audio Engine & Plugin Scanner...');

    try {
        // 1. Build Audio Engine
        await runCommand('cargo', ['build', '--bin', 'audio_engine'], SRC_TAURI);

        // 2. Build Plugin Scanner
        await runCommand('cargo', ['build', '--bin', 'plugin_scanner'], SRC_TAURI);

        console.log('✅ Build successful. Updating sidecars...');

        // 3. Copy binaries (mimicking prepare-sidecar.js logic but for DEBUG build specifically)
        // We assume we want to update the dev environment, so we prefer debug builds here.
        const debugDir = path.join(SRC_TAURI, 'target', 'debug');

        if (!fs.existsSync(BIN_DIR)) {
            fs.mkdirSync(BIN_DIR, { recursive: true });
        }

        const binaries = ['audio_engine', 'plugin_scanner'];

        for (const bin of binaries) {
            const srcIdx = path.join(debugDir, `${bin}.exe`);
            if (!fs.existsSync(srcIdx)) {
                throw new Error(`Binary not found at ${srcIdx}`);
            }

            const targetName = `${bin}-${TARGET_TRIPLE}.exe`;
            const dest = path.join(BIN_DIR, targetName);

            console.log(`Copying ${bin}.exe -> ${targetName}`);
            fs.copyFileSync(srcIdx, dest);
        }

        console.log('🎉 Audio Engine updated successfully!');

    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
}

main();
