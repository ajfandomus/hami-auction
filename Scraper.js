const { google } = require('googleapis');
const dotenv = require('dotenv');
const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');

dotenv.config();

// ---------- LOAD TARGET URLS ----------
let TARGET_PAGES = [];
try {
    TARGET_PAGES = JSON.parse(process.env.FLORIDAY_TARGET_PAGES || '[]');
} catch {
    console.error('❌ FLORIDAY_TARGET_PAGES is invalid JSON');
    process.exit(1);
}

if (!Array.isArray(TARGET_PAGES) || TARGET_PAGES.length === 0) {
    console.error('❌ No target URLs provided');
    process.exit(1);
}

// ---------- UAE TIME ----------
function getUaeTimeFormatted() {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Dubai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    })
        .format(new Date())
        .replace(',', '');
}

function formatRuntime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m === 0 ? `${s}s` : `${m}m ${s % 60}s`;
}

(async () => {
    const startTime = Date.now();

    const EMAIL = process.env.FLORIDAY_EMAIL;
    const PASSWORD = process.env.FLORIDAY_PASSWORD;

    if (!EMAIL || !PASSWORD) {
        console.error('❌ Missing Floriday credentials');
        process.exit(1);
    }

    // ---------- GOOGLE SHEETS ----------
    // const serviceAccountPath =
    //     process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'service-account.json';
    // const serviceAccount = JSON.parse(
    //     fs.readFileSync(path.resolve(__dirname, serviceAccountPath), 'utf8')
    // );

    // const auth = new google.auth.GoogleAuth({
    //     credentials: serviceAccount,
    //     scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    // });
const serviceAccount = JSON.parse(process.env.FLRIDAY_SERVICE_ACCOUNT);

const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
    const sheets = google.sheets({ version: 'v4', auth });
    const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
    const TARGET_SHEET_NAME = 'Hami-auction';

    let browser;

    try {
        browser = await firefox.launch({ headless: true, slowMo: 100 });
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
        });
        const page = await context.newPage();
        page.setDefaultTimeout(120000);

        // ---------- LOGIN ----------
        await page.goto('https://shop.floriday.io/', { waitUntil: 'load' });
        await page.fill('input#identifier', EMAIL);
        await page.click('button:has-text("Next")');
        await page.fill('input[name="credentials.passcode"]', PASSWORD);
        await page.click('button:has-text("Verify")');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(5000);

        const remindBtn = await page.$('button[data-se="skip"]');
        if (remindBtn) {
            await remindBtn.click();
            await page.waitForTimeout(6000);
        }

        // ---------- SCRAPING ----------
        const allProducts = [];

        for (const target of TARGET_PAGES) {
            console.log(`🚀 Navigating to: ${target.url}`);
            await page.goto(target.url, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(10000);

            try {
                const gotItBtn = await page.$(
                    'div.MuiDialogActions-root button:has-text("Got it")'
                );
                if (gotItBtn && (await gotItBtn.isVisible())) {
                    await gotItBtn.click();
                    await page.waitForTimeout(5000);
                }
            } catch { }


            // --- set page size to 96 ---
            const pageSizeSelect = await page.$('select.css-hh3ke9-pageSizeDropDownList');
            if (pageSizeSelect) {
                await page.selectOption('select.css-hh3ke9-pageSizeDropDownList', '96');
                await page.waitForTimeout(2000);
            }



            let pageNum = 1;

            while (true) {
            console.log(`⏳ Scraping page ${pageNum}...`);
            await page.waitForSelector('div.css-8jxzx-gridContainer',{ timeout: 60000 });

            const products = await page.$$(
                'div.css-8jxzx-gridContainer > div:not([data-test])'
            );
console.log('🧪 Products found:', products.length);
            for (const product of products) {
                const img = await product
                    .$eval('.css-16275sc-imageContainer img', el => el.src)
                    .catch(() => '');

                const details = await product
                    .$eval('.css-dcgd6i-itemDetails', el => el.innerText.trim())
                    .catch(() => '');

                const lines = details.split('\n').map(l => l.trim());
                const name = lines[0] || '';
               
                const code = await product
                    .$eval('div.css-1l9y2wl-itemCode', el => el.textContent?.trim() || '')
                    .catch(() => '');

                  const variety =  'N/a';
                const packingCode = await product
                    .$eval(
                        'div[style*="white-space: nowrap"] > div',
                        el => el.textContent.split(' - ')[0]
                    )
                    .catch(() => '');

                // // Quantity & Price
                // let Quantity = '';
                // try {
                //     const containerText = await product.$eval('div.MuiStack-root.css-8gnj0l', el => el.innerText?.trim() || '');
                //     const packagesMatch = containerText.match(/(\d+)\s*packages/i);
                //     const qty = packagesMatch ? packagesMatch[1] : '';

                //     const price = await product.$eval('div.MuiStack-root.css-8gnj0l b', el => el.innerText?.trim() || '');
                //     const priceOnly = price.replace('€', '').trim();

                //     if (priceOnly) Quantity = qty ? `${qty} * €${priceOnly}` : `€${priceOnly}`;
                // } catch { }

let price = '';
let Quantity = '';

try {
    const container = await product.$('div.MuiStack-root.css-8gnj0l');

    if (container) {
        // Get price from <b>
        const priceRaw = await container.$eval('b', el => el.innerText.trim());
        price = priceRaw.replace('€', '').trim();

        // Check if quantity exists in <span>
        const qtyRaw = await container.$eval('span', el => el.innerText.trim()).catch(() => null);

        if (qtyRaw) {
            // Extract just the number from "12 packages"
            const qtyNumber = qtyRaw.match(/\d+/)?.[0] || '1';
            Quantity = `${qtyNumber} * €${price}`;
        } else {
            Quantity = `€${price}`;
        }
    }
} catch {
    price = '';
    Quantity = '';
}

      
                const farmName = await product
                    .$eval(
                        'div.MuiStack-root.css-173yoy4 img',
                        el => el.alt || ''
                    )
                    .catch(() => '');

                const characteristics = [];
                try {
                    const spans = await product.$$(
                        'div.css-1cvv3s4-characteristics span'
                    );
                    for (const s of spans) {
                        characteristics.push(
                            await s.evaluate(el => el.textContent.trim())
                        );
                    }
                } catch { }

                let helper = 'N/A';

                try {
                    helper = await product.$eval(
                        'select.MuiNativeSelect-select',
                        select => {
                            const selectedOption = select.options[select.selectedIndex];
                            return selectedOption ? selectedOption.textContent.trim() : 'N/A';
                        }
                    );
                } catch {
                    // dropdown not present for this product
                    helper = 'N/A';
                }

                allProducts.push([
                    name,
                    variety,
                    code,
                    packingCode,
                    price,
                    img,
                    Quantity,
                    farmName,
                    characteristics.join(' | '),
                    helper,
                    getUaeTimeFormatted(),
                ]);
            }

                const nextBtn = await page.$(
                    'button[aria-label="Go to next page"]'
                );
                if (!nextBtn || (await nextBtn.getAttribute('disabled')) !== null)
                    break;

                await nextBtn.click();
                await page.waitForTimeout(4000);
                pageNum++;
            }
        }

        // ---------- WRITE SHEET ----------
        await sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: TARGET_SHEET_NAME,
        });

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${TARGET_SHEET_NAME}!A1`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [
                    [
                        'Name',
                        'Variety',
                        'Code',
                        'Packing Code',
                        'Price',
                        'Image',
                        'Quantity',
                        'Farm Name',
                        'Characteristics',
                        'Helper',
                        'Time',
                    ],
                    ...allProducts,
                ],
            },
        });

        console.log(`🏁 Done in ${formatRuntime(Date.now() - startTime)}`);
    } catch (err) {
        console.error('❌ Scraping failed:', err);
    } finally {
        if (browser) await browser.close();
    }
})();

