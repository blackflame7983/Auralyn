const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

// Configuration
const APP_NAME = 'Auralyn';
const VERSION = '0.2.0';
const RELEASE_DIR = path.join(__dirname, '../release_artifacts');
// Path to Tauri build output (MSI/Exe from "npm run tauri build")
const TAURI_TARGET_DIR = path.join(__dirname, '../src-tauri/target/release/bundle/nsis');
const TAURI_RELEASE_BIN_DIR = path.join(__dirname, '../src-tauri/target/release');

// Ensure release directory exists
if (!fs.existsSync(RELEASE_DIR)) {
    fs.mkdirSync(RELEASE_DIR, { recursive: true });
}

console.log(`📦 Starting packaging for ${APP_NAME} v${VERSION}...`);

async function copyInstaller() {
    console.log('-> Searching for installer...');
    try {
        const files = fs.readdirSync(TAURI_TARGET_DIR);
        const installer = files.find(f => f.endsWith('.exe'));

        if (installer) {
            fs.copyFileSync(
                path.join(TAURI_TARGET_DIR, installer),
                path.join(RELEASE_DIR, `${APP_NAME}_v${VERSION}_Setup.exe`)
            );
            console.log(`✅ Copied installer to: ${RELEASE_DIR}/${APP_NAME}_v${VERSION}_Setup.exe`);
        } else {
            console.warn('⚠️ No .exe installer found in target directory. Did you run "npm run tauri build"?');
        }
    } catch (e) {
        console.warn('⚠️ Could not copy installer:', e.message);
    }
}

async function createPortableZip() {
    console.log('-> Creating portable zip...');
    const output = fs.createWriteStream(path.join(RELEASE_DIR, `${APP_NAME}_v${VERSION}_Portable.zip`));
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise((resolve, reject) => {
        output.on('close', function () {
            console.log(`✅ Created portable zip: ${RELEASE_DIR}/${APP_NAME}_v${VERSION}_Portable.zip (${archive.pointer()} bytes)`);
            resolve();
        });

        archive.on('error', function (err) {
            reject(err);
        });

        archive.pipe(output);

        // Main executable (named AuralynHost.exe in Cargo.toml [[bin]])
        const exeName = 'AuralynHost.exe';
        const mainExePath = path.join(TAURI_RELEASE_BIN_DIR, exeName);
        if (fs.existsSync(mainExePath)) {
            // Rename to Auralyn.exe in the zip for user-friendliness
            archive.file(mainExePath, { name: 'Auralyn.exe' });
            console.log(`   + Auralyn.exe (from ${exeName})`);
        } else {
            console.warn(`⚠️ Main executable not found: ${mainExePath}`);
        }

        // Sidecars (from externalBin in tauri.conf.json)
        // Tauri names them with target triple suffix for release builds
        const sidecars = [
            { src: 'audio_engine.exe', dest: 'audio_engine-x86_64-pc-windows-msvc.exe' },
            { src: 'plugin_scanner.exe', dest: 'plugin_scanner-x86_64-pc-windows-msvc.exe' }
        ];

        for (const sidecar of sidecars) {
            const sidecarPath = path.join(TAURI_RELEASE_BIN_DIR, sidecar.src);
            if (fs.existsSync(sidecarPath)) {
                archive.file(sidecarPath, { name: sidecar.dest });
                console.log(`   + ${sidecar.dest}`);
            } else {
                console.warn(`⚠️ Sidecar not found: ${sidecarPath}`);
            }
        }

        archive.finalize();
    });
}

// Run
(async () => {
    await copyInstaller();
    await createPortableZip();
})();
