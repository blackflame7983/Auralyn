import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, '../src-tauri/icons');

async function checkRes(filename) {
    try {
        const metadata = await sharp(path.join(ICONS_DIR, filename)).metadata();
        console.log(`${filename}: ${metadata.width}x${metadata.height}`);
    } catch (e) {
        console.log(`${filename}: Not found or error`);
    }
}

checkRes('icon.png');
checkRes('128x128@2x.png');
checkRes('Square310x310Logo.png');
