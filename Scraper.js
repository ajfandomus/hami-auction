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

function getTomorrowDateUAE() {
    const now = new Date();
    const uaeNow = new Date(
        now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' })
    );

    uaeNow.setDate(uaeNow.getDate() + 1);

    const year = uaeNow.getFullYear();
    const month = String(uaeNow.getMonth() + 1).padStart(2, '0');
    const day = String(uaeNow.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

async function openCalendarIfNeeded(page) {
    const visibleCalendar = page.locator('table.rdp-month_grid:visible').first();

    if (await visibleCalendar.count()) return true;

    const exactOpeners = [
        'div.MuiPickersInputBase-root button.MuiIconButton-root',
        'div.MuiPickersInputBase-root .MuiInputAdornment-positionEnd button',
        'div[role="group"].MuiPickersInputBase-root button[type="button"]',
    ];

    for (const selector of exactOpeners) {
        try {
            const btn = page.locator(selector).first();
            if (await btn.count()) {
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ force: true });
                await page.waitForTimeout(1500);

                if (await visibleCalendar.count()) return true;
            }
        } catch {}
    }

    try {
        const pickerRoot = page.locator('div.MuiPickersInputBase-root').first();
        if (await pickerRoot.count()) {
            await pickerRoot.scrollIntoViewIfNeeded().catch(() => {});
            await pickerRoot.click({ force: true });
            await page.waitForTimeout(1500);

            if (await visibleCalendar.count()) return true;
        }
    } catch {}

    return false;
}

async function waitForGridRefresh(page, previousText = '') {
    await page.waitForFunction(
        ({ selector, previousText }) => {
            const el = document.querySelector(selector);
            if (!el) return false;
            const txt = (el.textContent || '').trim();
            if (!previousText) return txt.length > 0;
            return txt !== previousText.trim();
        },
        {
            selector: 'div.css-8jxzx-gridContainer > div:not([data-test])',
            previousText,
        },
        { timeout: 20000 }
    ).catch(async () => {
        await page.waitForTimeout(5000);
    });
}

async function selectTomorrowOrNextAvailable(page) {
    const opened = await openCalendarIfNeeded(page);
    if (!opened) {
        throw new Error('❌ Could not open visible calendar');
    }

    const calendar = page.locator('table.rdp-month_grid:visible').first();
    await calendar.waitFor({ state: 'visible', timeout: 15000 });

    const tomorrow = getTomorrowDateUAE();
    console.log(`📅 Tomorrow target (UAE): ${tomorrow}`);

    const nextAvailable = await calendar
        .locator('td.rdp-day:not(.rdp-disabled):not(.rdp-hidden):not(.rdp-outside) button')
        .evaluateAll((buttons, tomorrowDate) => {
            const dates = buttons
                .map(btn => btn.closest('td'))
                .filter(Boolean)
                .map(td => td.getAttribute('data-day'))
                .filter(Boolean)
                .sort();

            return dates.find(d => d >= tomorrowDate) || null;
        }, tomorrow);

    if (!nextAvailable) {
        throw new Error('❌ No available future dates found');
    }

    console.log(`✅ Picking date: ${nextAvailable}`);

    const firstCardBefore = await page
        .locator('div.css-8jxzx-gridContainer > div:not([data-test])')
        .first()
        .textContent()
        .catch(() => '');

    const targetBtn = calendar.locator(
        `td.rdp-day[data-day="${nextAvailable}"]:not(.rdp-disabled):not(.rdp-hidden):not(.rdp-outside) button`
    ).first();

    await targetBtn.waitFor({ state: 'visible', timeout: 10000 });
    await targetBtn.scrollIntoViewIfNeeded().catch(() => {});
    await targetBtn.click({ force: true });

    await waitForGridRefresh(page, firstCardBefore);
    await page.waitForTimeout(2000);

    return nextAvailable;
}

async function goToNextPage(page) {
    const nextBtn = page.locator('button[aria-label="Go to next page"]').first();

    if (!(await nextBtn.count())) {
        return false;
    }

    const isDisabled =
        (await nextBtn.getAttribute('disabled')) !== null ||
        (await nextBtn.getAttribute('aria-disabled')) === 'true' ||
        ((await nextBtn.getAttribute('class')) || '').includes('Mui-disabled');

    if (isDisabled) {
        return false;
    }

    const firstCardBefore = await page
        .locator('div.css-8jxzx-gridContainer > div:not([data-test])')
        .first()
        .textContent()
        .catch(() => '');

    await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
    await nextBtn.click({ force: true });

    await waitForGridRefresh(page, firstCardBefore);
    await page.waitForTimeout(2000);

    return true;
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

    const serviceAccount = JSON.parse(process.env.FLORIDAY_SERVICE_ACCOUNT);

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
            } catch {}

            // ---------- DATE SELECTION ----------
            let selectedDate = null;

            try {
                selectedDate = await selectTomorrowOrNextAvailable(page);
                console.log(`📌 Date selected successfully: ${selectedDate}`);
            } catch (err) {
                console.log(`⚠️ Date selection failed: ${err.message}`);
                console.log('⏭️ Skipping this target because no date was selected.');
                continue;
            }

            // only scrape after date selection succeeded
            await page.waitForSelector('div.css-8jxzx-gridContainer', { timeout: 60000 });
            await page.waitForTimeout(2000);

            // --- set page size to 96 ---
            const pageSizeSelect = await page.$('select.css-hh3ke9-pageSizeDropDownList');
            if (pageSizeSelect) {
                await page.selectOption('select.css-hh3ke9-pageSizeDropDownList', '96');
                await page.waitForTimeout(3000);
            }

            let currentPage = 1;

            while (true) {
                console.log(`⏳ Scraping page ${currentPage}...`);
                await page.waitForSelector('div.css-8jxzx-gridContainer', { timeout: 60000 });
                await page.waitForTimeout(3000);

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

                    const variety = 'N/a';

                    const packingCode = await product
                        .$eval(
                            'div[style*="white-space: nowrap"] > div',
                            el => el.textContent.split(' - ')[0]
                        )
                        .catch(() => '');

                    let price = '';
                    let Quantity = '';

                    try {
                        const container = await product.$('div.MuiStack-root.css-8gnj0l');

                        if (container) {
                            const priceRaw = await container.$eval('b', el => el.innerText.trim());
                            price = priceRaw.replace('€', '').trim();

                            const qtyRaw = await container
                                .$eval('span', el => el.innerText.trim())
                                .catch(() => null);

                            if (qtyRaw) {
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
                    } catch {}

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

                const moved = await goToNextPage(page);

                if (!moved) {
                    console.log('✅ Last page reached.');
                    break;
                }

                currentPage++;
                console.log(`➡️ Moving to next page ${currentPage}...`);
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
