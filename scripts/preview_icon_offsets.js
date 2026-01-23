import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = 'C:/Users/black/.gemini/antigravity/brain/4614fc7e-ffda-4429-8ff2-6d733b025bfb';
const SOURCE_IMAGE = path.join(ARTIFACTS_DIR, 'icon_proposal_minimalist_v2_3_1768995304032.png');
const OUTPUT_PREVIEW = path.join(ARTIFACTS_DIR, 'icon_offset_preview.png');

async function generateOffsetPreviews() {
    console.log('Reading source image:', SOURCE_IMAGE);

    // 1. Extract the Bottom-Right Quadrant
    const metadata = await sharp(SOURCE_IMAGE).metadata();
    const qSize = Math.floor(metadata.width / 2);

    const quadrantBuffer = await sharp(SOURCE_IMAGE)
        .extract({ left: qSize, top: qSize, width: qSize, height: qSize })
        .toBuffer();

    // 2. Function to create a circular crop with OFFSET
    // scale is fixed to 0.92 to capture the ring clearly
    async function createOffsetCrop(offsetX, offsetY) {
        const size = qSize;
        const scale = 0.92;
        const radius = (size / 2) * scale;

        // The center of the MASK relative to the image
        const cx = (size / 2) + offsetX;
        const cy = (size / 2) + offsetY;

        const mask = Buffer.from(
            `<svg><circle cx="${cx}" cy="${cy}" r="${radius}" fill="black"/></svg>`
        );

        return sharp(quadrantBuffer)
            .composite([{ input: mask, blend: 'dest-in' }])
            .png()
            .toBuffer();
    }

    // 3. Generate Variations: 3x3 Grid
    // Offsets: -20, 0, +20
    const offsets = [-20, 0, 20];
    const composites = [];

    const blankCanvas = await sharp({
        create: {
            width: qSize * 3,
            height: qSize * 3,
            channels: 4,
            background: { r: 50, g: 50, b: 50, alpha: 1 }
        }
    });

    const compositionList = [];

    let idx = 0;
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
            const offX = offsets[col];
            const offY = offsets[row];

            console.log(`Generating crop ${idx}: X=${offX}, Y=${offY}`);

            const crop = await createOffsetCrop(offX, offY);

            compositionList.push({
                input: crop,
                left: col * qSize,
                top: row * qSize
            });
            idx++;
        }
    }

    await blankCanvas
        .composite(compositionList)
        .png()
        .toFile(OUTPUT_PREVIEW);

    console.log(`Created offset preview at: ${OUTPUT_PREVIEW}`);
}

generateOffsetPreviews().catch(console.error);
