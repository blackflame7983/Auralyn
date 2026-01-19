from PIL import Image, ImageDraw, ImageOps

def make_circular_transparent(input_path, output_path):
    print(f"Processing {input_path}...")
    img = Image.open(input_path).convert("RGBA")
    
    # 1. Trim whitespace (based on white background with higher threshold)
    gray = img.convert("L")
    # Threshold: higher (250) to catch elusive white reflections
    bw = gray.point(lambda x: 0 if x > 250 else 255, '1')
    bbox = bw.getbbox()
    
    if bbox:
        # INSET the bbox to shave off edge artifacts/white fringe
        # instead of padding
        shave = 20
        left, top, right, bottom = bbox
        bbox = (
            min(right-1, left + shave),
            min(bottom-1, top + shave),
            max(left+1, right - shave),
            max(top+1, bottom - shave)
        )
        img = img.crop(bbox)
        print(f"Cropped and shaved to content: {bbox}")
    
    # 2. Make square (Center Crop to fill the circle)
    size = min(img.size)
    
    left = int((img.width - size) / 2)
    top = int((img.height - size) / 2)
    right = left + size
    bottom = top + size
    
    img = img.crop((left, top, right, bottom))
    print(f"Center cropped to size: {size}x{size}")
    
    # 3. Apply Circular Mask
    # Create a high-res mask for anti-aliasing
    mask_scale = 4
    mask = Image.new("L", (size * mask_scale, size * mask_scale), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size * mask_scale, size * mask_scale), fill=255)
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    
    # Apply mask
    output = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    output.paste(img, (0, 0), mask=mask)
    
    output.save(output_path, "PNG")
    print(f"Saved circular transparent image to {output_path}")

if __name__ == "__main__":
    from PIL import ImageChops # Import here for the function
    
    # Refresh source from original again
    input_file = r"d:\Programming\App\VSTHost\vst-host\src-tauri\icons\icon.png"
    output_file = r"d:\Programming\App\VSTHost\vst-host\src-tauri\icons\icon.png"
    output_public = r"d:\Programming\App\VSTHost\vst-host\public\auralyn_icon.png"
    
    make_circular_transparent(input_file, output_file)
    make_circular_transparent(input_file, output_public)
