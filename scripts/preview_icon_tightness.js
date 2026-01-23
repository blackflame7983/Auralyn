import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = 'C:/Users/black/.gemini/antigravity/brain/4614fc7e-ffda-4429-8ff2-6d733b025bfb';
const SOURCE_IMAGE = path.join(ARTIFACTS_DIR, 'icon_proposal_minimalist_v2_3_1768995304032.png');
const OUTPUT_PREVIEW = path.join(ARTIFACTS_DIR, 'icon_tight_preview.png');

async function generateTightPreviews() {
    console.log('Reading source image:', SOURCE_IMAGE);

    // 1. Extract the Bottom-Right Quadrant
    const metadata = await sharp(SOURCE_IMAGE).metadata();
    const qSize = Math.floor(metadata.width / 2);

    const quadrantBuffer = await sharp(SOURCE_IMAGE)
        .extract({ left: qSize, top: qSize, width: qSize, height: qSize })
        .toBuffer();

    // Fixed Offset chosen by user
    const offsetX = -20;
    const offsetY = -20;

    // 2. Create crop
    async function createTightCrop(scale) {
        const size = qSize;
        const radius = (size / 2) * scale;

        const cx = (size / 2) + offsetX;
        const cy = (size / 2) + offsetY;

        const mask = Buffer.from(
            `<svg><circle cx="${cx}" cy="${cy}" r="${radius}" fill="black"/></svg>`
        );

        return sharp(quadrantBuffer)
            .composite([{ input: mask, blend: 'dest-in' }])
            // Trim transparent pixels to actually show the "tightness" if we were to resize, 
            // but here we just show the masked result on a background.
            // Actually, if we just mask, the image size remains 512x512.
            // But visually the circle gets smaller.
            .png()
            .toBuffer();
    }

    // 3. Generate Variations
    // Current was 0.92. User wants TIGHTER (less margin), so we need SMALLER radius.
    // Let's go aggressive.
    const scales = [0.90, 0.86, 0.82, 0.78, 0.74, 0.70];
    const composites = [];

    const blankCanvas = await sharp({
        create: {
            width: qSize * 3,
            height: qSize * 2,
            channels: 4,
            background: { r: 50, g: 50, b: 50, alpha: 1 }
        }
    });

    const compositionList = [];

    for (let i = 0; i < scales.length; i++) {
        const crop = await createTightCrop(scales[i]);
        const col = i % 3;
        const row = Math.floor(i / 3);

        compositionList.push({
            input: crop,
            left: col * qSize,
            top: row * qSize
        });
    }

    await blankCanvas
        .composite(compositionList)
        .png()
        .toFile(OUTPUT_PREVIEW);

    console.log(`Created tight preview at: ${OUTPUT_PREVIEW}`);
    console.log('Scales used:', scales);
}

generateTightPreviews().catch(console.error);
