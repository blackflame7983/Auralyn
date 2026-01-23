import sharp from 'sharp';

async function testBmp() {
    try {
        const image = sharp({
            create: {
                width: 100,
                height: 100,
                channels: 3,
                background: { r: 255, g: 0, b: 0 }
            }
        });

        await image.toFormat('bmp').toFile('test.bmp');
        console.log('Success: Sharp supports BMP');
    } catch (error) {
        console.error('Error: Sharp does not support BMP', error);
    }
}

testBmp();
