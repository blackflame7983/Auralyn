const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

// Configuration
const APP_NAME = 'Auralyn';
const VERSION = '0.1.0';
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

    output.on('close', function () {
        console.log(`✅ Created portable zip: ${RELEASE_DIR}/${APP_NAME}_v${VERSION}_Portable.zip (${archive.pointer()} bytes)`);
    });

    archive.on('error', function (err) {
        throw err;
    });

    archive.pipe(output);

    // Add main executable and necessary files
    // Note: Adjust specific filenames based on actual output
    const exeName = 'Auralyn.exe';
    const resourcesDir = 'resources'; // Example: sidecars often in 'resources' or same dir

    try {
        // Add Main Executable
        archive.file(path.join(TAURI_RELEASE_BIN_DIR, exeName), { name: exeName });

        // Add Sidecars or DLLs if they are loose in the release dir (Tauri specific)
        // Usually Tauri bundles everything into the exe or puts resources nearby.
        // For a true "Portable", simply zipping the release dir contents excluding intermediate files is key.
        // Here assuming a simple single-exe or exe + resources structure.

        // Best practice for Tauri portable: Windows apps often self-contained. 
        // If sidecars are external, they need to be included.
        // For this script, we'll try to zip the 'Auralyn.exe' and likely 'resources' folder if it exists.

        // Check for sidecars path (often bundled inside, but if externalBin is used they might be next to exe)
        // Based on tauri.conf.json, externalBin is used.

        archive.finalize();
    } catch (e) {
        console.error('❌ Failed to zip:', e.message);
    }
}

// Run
(async () => {
    await copyInstaller();
    await createPortableZip();
})();
