import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = 'C:/Users/black/.gemini/antigravity/brain/4614fc7e-ffda-4429-8ff2-6d733b025bfb';
const SOURCE_IMAGE = path.join(ARTIFACTS_DIR, 'icon_proposal_minimalist_v2_3_1768995304032.png');
const TARGET_ICON = path.join(__dirname, '../src-tauri/icons/icon.png');

async function recreateIcon() {
    console.log('Reading source image:', SOURCE_IMAGE);

    // 1. Get Metadata
    const metadata = await sharp(SOURCE_IMAGE).metadata();
    const fullWidth = metadata.width;
    const quadrantSize = Math.floor(fullWidth / 2); // 512

    // 2. Parameters (Finalized by User)
    // Position: Center (0, 0) relative to the geometrical center of the quadrant (768, 768)
    const centerX = 768 + 0;
    const centerY = 768 + 0;

    // Zoom: 1.29 (Bottom Left option in preview)
    const zoom = 1.29;

    // 3. Perform Crop & Resize
    const boxSize = Math.floor(quadrantSize / zoom);
    const left = Math.floor(centerX - (boxSize / 2));
    const top = Math.floor(centerY - (boxSize / 2));

    console.log(`Final Parameters: Zoom ${zoom}, Offset (0,0)`);
    console.log(`Cropping ${boxSize}x${boxSize} at (${left}, ${top})...`);

    // Create the circle mask for the final 512x512 output
    const mask = Buffer.from(
        `<svg><circle cx="${quadrantSize / 2}" cy="${quadrantSize / 2}" r="${quadrantSize / 2}" fill="black"/></svg>`
    );

    await sharp(SOURCE_IMAGE)
        .extract({ left: left, top: top, width: boxSize, height: boxSize })
        .resize(quadrantSize, quadrantSize) // Scale back up to 512
        .composite([{
            input: mask,
            blend: 'dest-in'
        }])
        .png()
        .toFile(TARGET_ICON);

    console.log('✓ Recreated high-quality icon.png at:', TARGET_ICON);
}

recreateIcon().catch(console.error);
