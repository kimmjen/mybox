import os
import re
import sys
import glob
from PIL import Image
Image.init()

def sanitize_filename(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', name)
    return name.strip() or 'mybox_document'

def compile_pdf():
    print("[INFO] Starting PDF compilation...")

    # Get output directory from args, default to current dir
    output_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    doc_title = sys.argv[2] if len(sys.argv) > 2 else ''
    screenshots_dir = os.path.join(output_dir, "naver_mybox_temp_screenshots")
    
    # Get all page_*.png files
    search_path = os.path.join(screenshots_dir, "page_*.png")
    image_paths = glob.glob(search_path)
    
    if not image_paths:
        print(f"ERROR: No screenshots found in {screenshots_dir} directory.")
        sys.exit(1)
        
    # Sort them by filename to ensure correct page order
    image_paths.sort()
    print(f"[INFO] Found {len(image_paths)} pages to compile.")
    
    images = []
    for path in image_paths:
        try:
            img = Image.open(path)
            # Convert to RGB mode
            rgb_img = img.convert('RGB')
            images.append(rgb_img)
        except Exception as e:
            print(f"ERROR: Loading page {path} failed: {e}")
            sys.exit(1)
            
    if not images:
        print("ERROR: No images were loaded successfully.")
        sys.exit(1)
        
    output_filename = sanitize_filename(doc_title) + '.pdf'
    output_path = os.path.join(output_dir, output_filename)
    
    print(f"[INFO] Saving combined PDF to {output_filename}...")
    try:
        # Save as PDF
        images[0].save(
            output_path, 
            save_all=True, 
            append_images=images[1:], 
            resolution=100.0, 
            quality=95
        )
        print(f"[SUCCESS] Compiled PDF saved successfully to {output_path}")
        
        # Clean up screenshots directory
        print("[INFO] Cleaning up temporary screenshots...")
        for path in image_paths:
            try:
                os.remove(path)
            except:
                pass
        try:
            os.rmdir(screenshots_dir)
        except:
            pass
            
    except Exception as e:
        print(f"ERROR: Saving PDF failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    compile_pdf()
