import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = 'C:/Users/black/.gemini/antigravity/brain/4614fc7e-ffda-4429-8ff2-6d733b025bfb';
const SOURCE_IMAGE = path.join(ARTIFACTS_DIR, 'icon_proposal_minimalist_v2_3_1768995304032.png');
const OUTPUT_PREVIEW = path.join(ARTIFACTS_DIR, 'icon_finetune_preview.png');

async function generateFineTune() {
    console.log('Reading source image:', SOURCE_IMAGE);

    // 1. Get Metadata
    const metadata = await sharp(SOURCE_IMAGE).metadata();
    const fullWidth = metadata.width;
    const quadrantSize = Math.floor(fullWidth / 2); // 512

    // Base Center (from previous step: 748, 748 which is 768-20)
    // We want to explore around (-20, -20)
    // Let's define the grid relative to (-20, -20)

    // Base Offsets
    const baseOffsetX = -20;
    const baseOffsetY = -20;

    const step = 8; // 8 pixels shift

    // Offsets to try: -8, 0, +8 relative to Base
    const shifts = [-step, 0, step];

    // Fixed Zoom
    const zoom = 1.25;
    const boxSize = Math.floor(quadrantSize / zoom);

    // 2. Create Icon Function
    async function createIcon(offX, offY) {
        // Absolute Center for this crop
        // 768 is the center of the quadrant (512 + 256)
        const cx = 768 + (baseOffsetX + offX);
        const cy = 768 + (baseOffsetY + offY);

        // Top-Left of the crop box
        const left = Math.floor(cx - (boxSize / 2));
        const top = Math.floor(cy - (boxSize / 2));

        console.log(`Offset (${baseOffsetX + offX}, ${baseOffsetY + offY}): Cropping at (${left}, ${top})`);

        return sharp(SOURCE_IMAGE)
            .extract({ left: left, top: top, width: boxSize, height: boxSize })
            .resize(quadrantSize, quadrantSize)
            .composite([{
                input: Buffer.from(`<svg><circle cx="${quadrantSize / 2}" cy="${quadrantSize / 2}" r="${quadrantSize / 2}" fill="black"/></svg>`),
                blend: 'dest-in'
            }])
            .png()
            .toBuffer();
    }

    // 3. Generate 3x3 Grid

    const blankCanvas = await sharp({
        create: {
            width: quadrantSize * 3,
            height: quadrantSize * 3,
            channels: 4,
            background: { r: 50, g: 50, b: 50, alpha: 1 }
        }
    });

    const compositionList = [];

    let idx = 0;
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            const shiftX = shifts[c];
            const shiftY = shifts[r];

            const icon = await createIcon(shiftX, shiftY);

            compositionList.push({
                input: icon,
                left: c * quadrantSize,
                top: r * quadrantSize
            });
            idx++;
        }
    }

    await blankCanvas
        .composite(compositionList)
        .png()
        .toFile(OUTPUT_PREVIEW);

    console.log(`Created finetune preview at: ${OUTPUT_PREVIEW}`);
}

generateFineTune().catch(console.error);
