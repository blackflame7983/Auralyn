const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
    console.error('Please provide a version number (e.g., 0.4.0)');
    process.exit(1);
}

// Update package.json
const packageJsonPath = path.resolve(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
packageJson.version = version;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`Updated package.json to version ${version}`);

// Update tauri.conf.json
const tauriConfPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = version;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
console.log(`Updated tauri.conf.json to version ${version}`);
