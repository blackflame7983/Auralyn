const SCALE = 3;

/**
 * Generate BMP images for NSIS installer
 * - Header: 150x57 px (Base) -> 450x171 px (Scaled)
 * - Sidebar: 164x314 px (Base) -> 492x942 px (Scaled)
 * 
 * High-DPI screens will stretch standard images, causing blurriness.
 * Providing a larger image allows NSIS/Windows to scale it down (or display 1:1 on high DPI),
 * resulting in a much sharper look.
 * 
 * Sharp doesn't support BMP output directly, so we'll create PNG files
 * and convert them using raw pixel data to BMP format manually.
 */
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, '../src-tauri/icons');

/**
 * Create a BMP file from raw RGB pixel data
 * BMP format: 24-bit BGR, bottom-up row order
 */
function createBmp(width, height, rgbBuffer) {
    const rowSize = Math.ceil((width * 3) / 4) * 4; // Row size must be multiple of 4
    const pixelDataSize = rowSize * height;
    const fileSize = 54 + pixelDataSize; // 14 (file header) + 40 (info header) + pixel data

    const buffer = Buffer.alloc(fileSize);
    let offset = 0;

    // BMP File Header (14 bytes)
    buffer.write('BM', offset); offset += 2;  // Signature
    buffer.writeUInt32LE(fileSize, offset); offset += 4;  // File size
    buffer.writeUInt16LE(0, offset); offset += 2;  // Reserved
    buffer.writeUInt16LE(0, offset); offset += 2;  // Reserved
    buffer.writeUInt32LE(54, offset); offset += 4;  // Pixel data offset

    // BMP Info Header (40 bytes)
    buffer.writeUInt32LE(40, offset); offset += 4;  // Info header size
    buffer.writeInt32LE(width, offset); offset += 4;  // Width
    buffer.writeInt32LE(height, offset); offset += 4;  // Height (positive = bottom-up)
    buffer.writeUInt16LE(1, offset); offset += 2;  // Planes
    buffer.writeUInt16LE(24, offset); offset += 2;  // Bits per pixel
    buffer.writeUInt32LE(0, offset); offset += 4;  // Compression (none)
    buffer.writeUInt32LE(pixelDataSize, offset); offset += 4;  // Image size
    buffer.writeInt32LE(0, offset); offset += 4;  // X pixels per meter (0 = unspecified/default)
    buffer.writeInt32LE(0, offset); offset += 4;  // Y pixels per meter
    buffer.writeUInt32LE(0, offset); offset += 4;  // Colors in color table
    buffer.writeUInt32LE(0, offset); offset += 4;  // Important colors

    // Pixel data (bottom-up, BGR order)
    for (let y = height - 1; y >= 0; y--) {
        for (let x = 0; x < width; x++) {
            const srcOffset = (y * width + x) * 3;
            const dstOffset = 54 + (height - 1 - y) * rowSize + x * 3;
            // RGB to BGR
            buffer[dstOffset] = rgbBuffer[srcOffset + 2];     // B
            buffer[dstOffset + 1] = rgbBuffer[srcOffset + 1]; // G
            buffer[dstOffset + 2] = rgbBuffer[srcOffset];     // R
        }
    }

    return buffer;
}

async function generateNsisBitmaps() {
    const sourceIcon = path.join(ICONS_DIR, '128x128@2x.png');

    console.log(`Generating NSIS bitmaps with scale factor: ${SCALE}x`);

    // ==========================================
    // Header image (150x57 base)
    // ==========================================
    const headerWidth = 150 * SCALE;
    const headerHeight = 57 * SCALE;
    const headerIconSize = 48 * SCALE;

    const headerIcon = await sharp(sourceIcon)
        .resize(headerIconSize, headerIconSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .toBuffer();

    const headerImage = await sharp({
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
                left: headerWidth - headerIconSize - (4 * SCALE),
                top: Math.floor((headerHeight - headerIconSize) / 2)
            }
        ])
        .removeAlpha()
        .raw()
        .toBuffer();

    const headerBmp = createBmp(headerWidth, headerHeight, headerImage);
    fs.writeFileSync(path.join(ICONS_DIR, 'nsis-header.bmp'), headerBmp);
    console.log(`✓ Generated nsis-header.bmp (${headerWidth}x${headerHeight})`);

    // ==========================================
    // Sidebar image (164x314 base)
    // ==========================================
    const sidebarWidth = 164 * SCALE;
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

    const sidebarImage = await sharp(Buffer.from(gradientSvg))
        .composite([
            {
                input: sidebarIcon,
                left: Math.floor((sidebarWidth - sidebarIconSize) / 2),
                top: 40 * SCALE
            }
        ])
        .removeAlpha()
        .raw()
        .toBuffer();

    const sidebarBmp = createBmp(sidebarWidth, sidebarHeight, sidebarImage);
    fs.writeFileSync(path.join(ICONS_DIR, 'nsis-sidebar.bmp'), sidebarBmp);
    console.log(`✓ Generated nsis-sidebar.bmp (${sidebarWidth}x${sidebarHeight})`);
}

generateNsisBitmaps().catch(console.error);
