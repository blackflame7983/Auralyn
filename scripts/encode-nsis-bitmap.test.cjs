const test = require('node:test');
const assert = require('node:assert/strict');

test('NSIS BMPは奇数幅でもRGB・上下左右の配置・24bit形式を保つ', async () => {
    const sharp = require('sharp');
    const { encodeNsisBitmap } = await import('./encode-nsis-bitmap.js');
    for (const [width, height] of [[3, 2], [1, 3], [2, 1]]) {
        const rgb = Buffer.from(Array.from({ length: width * height * 3 }, (_, i) => (i * 67 + 13) % 256));
        const png = await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
        const bmp = await encodeNsisBitmap(png);

        assert.equal(bmp.toString('ascii', 0, 2), 'BM');
        assert.equal(bmp.readInt32LE(18), width);
        assert.equal(bmp.readInt32LE(22), height);
        assert.equal(bmp.readUInt16LE(28), 24);
        const offset = bmp.readUInt32LE(10);
        const stride = Math.ceil(width * 3 / 4) * 4;
        // BMPのbottom-up BGRを仕様どおり読み、エンコーダー自身のdecodeには依存しない。
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = offset + (height - 1 - y) * stride + x * 3;
                const source = (y * width + x) * 3;
                assert.deepEqual([bmp[p + 2], bmp[p + 1], bmp[p]], [...rgb.subarray(source, source + 3)]);
            }
        }
    }
});

test('NSIS BMP変換は透明ピクセルと壊れたPNGを拒否する', async () => {
    const sharp = require('sharp');
    const { encodeNsisBitmap } = await import('./encode-nsis-bitmap.js');
    const transparent = await sharp(Buffer.from([255, 0, 0, 128]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    await assert.rejects(encodeNsisBitmap(transparent), /不透明/);
    await assert.rejects(encodeNsisBitmap(Buffer.from('invalid PNG')));
});
