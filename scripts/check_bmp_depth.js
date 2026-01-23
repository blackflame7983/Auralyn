import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, '../src-tauri/icons');

function checkBitDepth(filename) {
    const file = path.join(ICONS_DIR, filename);
    if (!fs.existsSync(file)) {
        console.log(`${filename}: Not found`);
        return;
    }

    const buffer = fs.readFileSync(file);
    // BMP Offset 0x1C (28) contains the bit count (2 bytes)
    const bitDepth = buffer.readUInt16LE(0x1C);
    console.log(`${filename}: ${bitDepth}-bit`);
}

checkBitDepth('nsis-header.bmp');
checkBitDepth('nsis-sidebar.bmp');
