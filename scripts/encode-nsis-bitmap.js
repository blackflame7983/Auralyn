import sharp from 'sharp';
import { encode } from 'bmp-ts';

// 生成済みの不透明PNGだけを、NSIS用の24bit BMPへ変換する。
export async function encodeNsisBitmap(png) {
    const { data, info } = await sharp(png)
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    if (info.channels !== 4 || data.length !== info.width * info.height * 4) {
        throw new Error('NSIS画像のピクセル形式を確認できませんでした。');
    }
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 255) {
            throw new Error('NSIS画像には不透明なPNGを使用してください。');
        }
    }

    // bmp-tsはABGRを受け取る。RGBAを4バイト単位で反転し、既存のエンコーダーへ渡す。
    return encode({ data: data.swap32(), width: info.width, height: info.height, bitPP: 24 }).data;
}
