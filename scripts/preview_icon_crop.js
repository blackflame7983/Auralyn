import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = 'C:/Users/black/.gemini/antigravity/brain/4614fc7e-ffda-4429-8ff2-6d733b025bfb';
const SOURCE_IMAGE = path.join(ARTIFACTS_DIR, 'icon_proposal_minimalist_v2_3_1768995304032.png');
const OUTPUT_PREVIEW = path.join(ARTIFACTS_DIR, 'icon_crop_preview.png');

async function generatePreviews() {
    console.log('Reading source image:', SOURCE_IMAGE);

    // 1. Extract the Bottom-Right Quadrant
    const metadata = await sharp(SOURCE_IMAGE).metadata();
    const qSize = Math.floor(metadata.width / 2);

    // Buffer of the raw quadrant
    const quadrantBuffer = await sharp(SOURCE_IMAGE)
        .extract({ left: qSize, top: qSize, width: qSize, height: qSize })
        .toBuffer();

    // 2. Function to create a circular crop at a specific scale percentage
    async function createCircularCrop(scale) {
        const size = qSize;
        const radius = (size / 2) * scale;
        const cx = size / 2;
        const cy = size / 2;

        const mask = Buffer.from(
            `<svg><circle cx="${cx}" cy="${cy}" r="${radius}" fill="black"/></svg>`
        );

        return sharp(quadrantBuffer)
            .composite([{ input: mask, blend: 'dest-in' }])
            .png()
            .toBuffer();
    }

    // 3. Generate Variations
    const scales = [1.0, 0.95, 0.90, 0.85, 0.80, 0.75];
    const composites = [];

    // Create a 3x2 grid for preview
    // Cell size: qSize
    // Final Image: qSize * 3 width, qSize * 2 height

    const blankCanvas = await sharp({
        create: {
            width: qSize * 3,
            height: qSize * 2,
            channels: 4,
            background: { r: 50, g: 50, b: 50, alpha: 1 } // Dark background to see transparency
        }
    });

    const compositionList = [];

    for (let i = 0; i < scales.length; i++) {
        const crop = await createCircularCrop(scales[i]);
        const col = i % 3;
        const row = Math.floor(i / 3);

        compositionList.push({
            input: crop,
            left: col * qSize,
            top: row * qSize
        });

        // Add label? (Hard with sharp without font config, skipping for now, will describe in text)
    }

    await blankCanvas
        .composite(compositionList)
        .png()
        .toFile(OUTPUT_PREVIEW);

    console.log(`Created preview at: ${OUTPUT_PREVIEW}`);
    console.log('Scales used:', scales);
}

generatePreviews().catch(console.error);
