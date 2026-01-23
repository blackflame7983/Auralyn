const SCALE = 1;

/**
 * Generate BMP images for NSIS installer
 * - Header: 150x57 px
 * - Sidebar: 164x314 px
 * 
 * Uses 'sharp' for high-quality resizing and compositing,
 * and 'jimp' for reliable BMP output.
 */
import sharp from 'sharp';
import { Jimp } from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, '../src-tauri/icons');

async function generateNsisBitmaps() {
    const sourceIcon = path.join(ICONS_DIR, 'icon.png');

    console.log(`Generating NSIS bitmaps with scale factor: ${SCALE}x`);

    // ==========================================
    // Header image (150x57 base) -> Extended to 188x57 (1.25x width)
    // ==========================================
    const headerWidth = 188 * SCALE;
    const headerHeight = 57 * SCALE;
    const headerIconSize = 48 * SCALE;

    const headerIcon = await sharp(sourceIcon)
        .resize(headerIconSize, headerIconSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .toBuffer();

    const headerImageBuffer = await sharp({
        create: {
            width: headerWidth,
            height: headerHeight,
            channels: 3,
            background: { r: 255, g: 255, b: 255 }
        }
    })
        .composite([
            {
                input: headerIcon,
                // Keep icon on the right side
                left: headerWidth - headerIconSize - (4 * SCALE),
                top: Math.floor((headerHeight - headerIconSize) / 2)
            }
        ])
        .removeAlpha()
        .png()
        .toBuffer();

    // Convert to BMP using Jimp
    const headerJimp = await Jimp.read(headerImageBuffer);
    await headerJimp.write(path.join(ICONS_DIR, 'nsis-header.bmp'));
    console.log(`✓ Generated nsis-header.bmp (${headerWidth}x${headerHeight})`);

    // ==========================================
    // Sidebar image (164x314 base) -> Extended to 205x314 (1.25x width)
    // ==========================================
    const sidebarWidth = 205 * SCALE;
    const sidebarHeight = 314 * SCALE;
    const sidebarIconSize = 100 * SCALE;

    const sidebarIcon = await sharp(sourceIcon)
        .resize(sidebarIconSize, sidebarIconSize, { fit: 'contain', background: { r: 30, g: 41, b: 59, alpha: 1 } })
        .flatten({ background: { r: 30, g: 41, b: 59 } })
        .toBuffer();

    // Create gradient background using SVG
    const gradientSvg = `
    <svg width="${sidebarWidth}" height="${sidebarHeight}">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style="stop-color:rgb(30,41,59);stop-opacity:1" />
          <stop offset="100%" style="stop-color:rgb(51,65,85);stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="${sidebarWidth}" height="${sidebarHeight}" fill="url(#grad)"/>
    </svg>`;

    const sidebarImageBuffer = await sharp(Buffer.from(gradientSvg))
        .composite([
            {
                input: sidebarIcon,
                left: Math.floor((sidebarWidth - sidebarIconSize) / 2),
                top: 40 * SCALE
            }
        ])
        .removeAlpha()
        .png()
        .toBuffer();

    // Convert to BMP using Jimp
    const sidebarJimp = await Jimp.read(sidebarImageBuffer);
    await sidebarJimp.write(path.join(ICONS_DIR, 'nsis-sidebar.bmp'));
    console.log(`✓ Generated nsis-sidebar.bmp (${sidebarWidth}x${sidebarHeight})`);
}

generateNsisBitmaps().catch(console.error);
