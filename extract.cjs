const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Arguments: url, password, output_dir
const targetUrl = process.argv[2];
const password = process.argv[3];
const outputDir = process.argv[4] || __dirname;

if (!targetUrl || !password) {
  console.error('ERROR: Missing required arguments (url, password)');
  process.exit(1);
}

const screenshotsDir = path.join(outputDir, 'naver_mybox_temp_screenshots');

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1024 }
    });
    const page = await context.newPage();

    console.log('[INFO] Navigating to verification page...');
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    console.log('[INFO] Entering password...');
    const passwordInputSelector = 'input[type="password"]';
    
    // Check if password input is present
    const hasPasswordInput = await page.$(passwordInputSelector);
    if (!hasPasswordInput) {
      console.error('ERROR: Could not find password input field. The link may have expired or is incorrect.');
      await browser.close();
      process.exit(1);
    }

    await page.fill(passwordInputSelector, password);
    await page.press(passwordInputSelector, 'Enter');

    console.log('[INFO] Waiting for document viewer to load...');
    await page.waitForTimeout(6000);

    const docFrame = page.frames().find(f => f.url().includes('docviewer.naver.com'));
    if (!docFrame) {
      console.error('ERROR: Verification failed. Please check your password.');
      await browser.close();
      process.exit(1);
    }

    // Create temp screenshots directory
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    // Query elements
    const pageItems = await docFrame.$$('.document_list > li.item');
    const totalPages = pageItems.length;
    console.log(`[INFO] Total pages detected: ${totalPages}`);

    // Emit document title for the PDF filename
    let docTitle = (await page.title()).replace(/\s*[-|]\s*(NAVER|네이버).*$/i, '').trim();
    if (!docTitle) docTitle = 'mybox_document';
    console.log(`[TITLE] ${docTitle}`);

    if (totalPages === 0) {
      console.error('ERROR: No page items found in document viewer.');
      await browser.close();
      process.exit(1);
    }

    // Loop through pages
    for (let i = 0; i < totalPages; i++) {
      const pageNum = i + 1;
      
      try {
        const liSelector = `#item_${pageNum}`;
        const liHandle = await docFrame.$(liSelector);
        if (!liHandle) {
          throw new Error(`Container ${liSelector} not found`);
        }

        // Scroll page into view
        await liHandle.scrollIntoViewIfNeeded();

        // Extra scroll trigger
        await docFrame.evaluate((num) => {
          const scrollArea = document.querySelector('._mainRef');
          if (scrollArea) {
            const target = document.querySelector(`#item_${num}`);
            if (target) {
              scrollArea.scrollTop = target.offsetTop - 50;
            }
          }
        }, pageNum);

        // Wait for page image element with alt="page"
        const imgSelector = `${liSelector} img[alt="page"]`;
        const imgHandle = await docFrame.waitForSelector(imgSelector, { timeout: 15000 });
        
        const imgSrc = await imgHandle.getAttribute('src');

        // Resolve relative URL
        let absoluteSrc = imgSrc;
        if (imgSrc.startsWith('/')) {
          absoluteSrc = 'https://docviewer.naver.com' + imgSrc;
        }

        // Fetch image bytes
        const fetchResult = await docFrame.evaluate(async (src) => {
          try {
            const res = await fetch(src);
            if (!res.ok) return { success: false, status: res.status };
            const blob = await res.blob();
            
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                resolve({ success: true, type: blob.type, data: reader.result });
              };
              reader.readAsDataURL(blob);
            });
          } catch (e) {
            return { success: false, error: e.message };
          }
        }, absoluteSrc);

        if (fetchResult.success) {
          const base64Data = fetchResult.data.split(',')[1];
          const buffer = Buffer.from(base64Data, 'base64');
          const filename = `page_${String(pageNum).padStart(3, '0')}.png`;
          const outputPath = path.join(screenshotsDir, filename);
          fs.writeFileSync(outputPath, buffer);
          console.log(`[PROGRESS] ${pageNum}/${totalPages} - Saved original page image`);
        } else {
          // Fallback screenshot
          const filename = `page_${String(pageNum).padStart(3, '0')}.png`;
          const outputPath = path.join(screenshotsDir, filename);
          await imgHandle.screenshot({ path: outputPath });
          console.log(`[PROGRESS] ${pageNum}/${totalPages} - Saved screenshot (fallback)`);
        }

      } catch (err) {
        // Double fallback
        try {
          const liSelector = `#item_${pageNum}`;
          const liHandle = await docFrame.$(liSelector);
          if (liHandle) {
            await liHandle.scrollIntoViewIfNeeded();
            await page.waitForTimeout(1000);
            const filename = `page_${String(pageNum).padStart(3, '0')}.png`;
            const outputPath = path.join(screenshotsDir, filename);
            await liHandle.screenshot({ path: outputPath });
            console.log(`[PROGRESS] ${pageNum}/${totalPages} - Saved viewport screenshot (fallback)`);
          } else {
            console.log(`[PROGRESS] ${pageNum}/${totalPages} - FAILED (Element not found)`);
          }
        } catch (innerErr) {
          console.log(`[PROGRESS] ${pageNum}/${totalPages} - FAILED (${innerErr.message})`);
        }
      }
    }

    console.log('[INFO] All pages successfully extracted.');
    await browser.close();
    process.exit(0);

  } catch (err) {
    console.error(`ERROR: Extraction failed: ${err.message}`);
    if (browser) await browser.close();
    process.exit(1);
  }
})();
