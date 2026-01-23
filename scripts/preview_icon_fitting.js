import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = 'C:/Users/black/.gemini/antigravity/brain/4614fc7e-ffda-4429-8ff2-6d733b025bfb';
const SOURCE_IMAGE = path.join(ARTIFACTS_DIR, 'icon_proposal_minimalist_v2_3_1768995304032.png');
const OUT_POS = path.join(ARTIFACTS_DIR, 'icon_fit_pos.png');
const OUT_ZOOM = path.join(ARTIFACTS_DIR, 'icon_fit_zoom.png');

async function generatePreviews() {
    console.log('Reading source image:', SOURCE_IMAGE);
    const metadata = await sharp(SOURCE_IMAGE).metadata();
    const fullWidth = metadata.width; // 1024
    const qSize = Math.floor(fullWidth / 2); // 512
    const centerBaseX = 768; // 512 + 256
    const centerBaseY = 768;

    // Helper to create cropped icon
    async function createIcon(offX, offY, zoom) {
        const cx = centerBaseX + offX;
        const cy = centerBaseY + offY;
        const boxSize = Math.floor(qSize / zoom);
        const left = Math.floor(cx - (boxSize / 2));
        const top = Math.floor(cy - (boxSize / 2));

        return sharp(SOURCE_IMAGE)
            .extract({ left: left, top: top, width: boxSize, height: boxSize })
            .resize(qSize, qSize)
            .composite([{
                input: Buffer.from(`<svg><circle cx="${qSize / 2}" cy="${qSize / 2}" r="${qSize / 2}" fill="black"/></svg>`),
                blend: 'dest-in'
            }])
            .png()
            .toBuffer();
    }

    // 1. Position Grid (Continuing from -12, -12 towards +4, +4)
    // Grid: -12, -4, +4
    console.log('Generating Position Grid...');
    const posOffsets = [-12, -4, 4];
    const fixedZoom = 1.25;

    const posCanvas = await sharp({
        create: { width: qSize * 3, height: qSize * 3, channels: 4, background: { r: 50, g: 50, b: 50, alpha: 1 } }
    });

    const posComposites = [];
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            const ox = posOffsets[c];
            const oy = posOffsets[r];
            const icon = await createIcon(ox, oy, fixedZoom);
            posComposites.push({ input: icon, left: c * qSize, top: r * qSize });
        }
    }
    await posCanvas.composite(posComposites).png().toFile(OUT_POS);
    console.log('Saved:', OUT_POS);

    // 2. Zoom Grid (Fixed at center -4, -4)
    console.log('Generating Zoom Grid...');
    const refX = -4;
    const refY = -4;
    const zooms = [1.20, 1.23, 1.26, 1.29, 1.32, 1.35];

    const zoomCanvas = await sharp({
        create: { width: qSize * 3, height: qSize * 2, channels: 4, background: { r: 50, g: 50, b: 50, alpha: 1 } }
    });

    const zoomComposites = [];
    for (let i = 0; i < zooms.length; i++) {
        const z = zooms[i];
        const icon = await createIcon(refX, refY, z);
        const col = i % 3;
        const row = Math.floor(i / 3);
        zoomComposites.push({ input: icon, left: col * qSize, top: row * qSize });
    }
    await zoomCanvas.composite(zoomComposites).png().toFile(OUT_ZOOM);
    console.log('Saved:', OUT_ZOOM);
}

generatePreviews().catch(console.error);
