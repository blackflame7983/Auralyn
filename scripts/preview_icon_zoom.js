import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = 'C:/Users/black/.gemini/antigravity/brain/4614fc7e-ffda-4429-8ff2-6d733b025bfb';
const SOURCE_IMAGE = path.join(ARTIFACTS_DIR, 'icon_proposal_minimalist_v2_3_1768995304032.png');
const OUTPUT_PREVIEW = path.join(ARTIFACTS_DIR, 'icon_zoom_preview.png');

async function generateZoomPreviews() {
    console.log('Reading source image:', SOURCE_IMAGE);

    // 1. Get Metadata
    const metadata = await sharp(SOURCE_IMAGE).metadata();
    const fullWidth = metadata.width;
    const quadrantSize = Math.floor(fullWidth / 2); // 512

    // Center of the Bottom-Right Quadrant
    // X range: [512, 1024], Y range: [512, 1024]
    // Center is (512 + 256, 512 + 256) = (768, 768)
    // Applying User Offset (-20, -20)
    const centerX = 768 - 20;
    const centerY = 768 - 20;

    // 2. Create Zoomed Icon Function
    async function createZoomedIcon(zoom) {
        // Size of the box to crop
        const boxSize = Math.floor(quadrantSize / zoom);

        // Top-Left of the crop box
        const left = Math.floor(centerX - (boxSize / 2));
        const top = Math.floor(centerY - (boxSize / 2));

        console.log(`Zoom ${zoom}: Cropping ${boxSize}x${boxSize} at (${left}, ${top})`);

        return sharp(SOURCE_IMAGE)
            .extract({ left: left, top: top, width: boxSize, height: boxSize })
            .resize(quadrantSize, quadrantSize) // Scale back up to 512
            .composite([{
                input: Buffer.from(`<svg><circle cx="${quadrantSize / 2}" cy="${quadrantSize / 2}" r="${quadrantSize / 2}" fill="black"/></svg>`),
                blend: 'dest-in'
            }])
            .png()
            .toBuffer();
    }

    // 3. Generate Variations
    // User wants "Thin circle to fill the icon". 
    // This implies cropping out the thick outer ring.
    // Testing a range that likely captures this expansion.
    const zooms = [1.15, 1.20, 1.25, 1.30, 1.35, 1.40];

    const blankCanvas = await sharp({
        create: {
            width: quadrantSize * 3,
            height: quadrantSize * 2,
            channels: 4,
            background: { r: 50, g: 50, b: 50, alpha: 1 }
        }
    });

    const compositionList = [];

    for (let i = 0; i < zooms.length; i++) {
        const icon = await createZoomedIcon(zooms[i]);
        const col = i % 3;
        const row = Math.floor(i / 3);

        compositionList.push({
            input: icon,
            left: col * quadrantSize,
            top: row * quadrantSize
        });
    }

    await blankCanvas
        .composite(compositionList)
        .png()
        .toFile(OUTPUT_PREVIEW);

    console.log(`Created zoom preview at: ${OUTPUT_PREVIEW}`);
    console.log('Zooms used:', zooms);
}

generateZoomPreviews().catch(console.error);
