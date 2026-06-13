import puppeteer from 'puppeteer';

(async () => {
    console.log("Launching browser...");
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

    console.log("Navigating to http://localhost:3000 ...");
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });

    console.log("Waiting for btn-quick-play...");
    await page.waitForSelector('#btn-quick-play');
    
    console.log("Clicking btn-quick-play...");
    await page.click('#btn-quick-play');

    console.log("Waiting 5 seconds for match to start and WebGL to render...");
    await new Promise(r => setTimeout(r, 5000));

    console.log("Closing browser...");
    await browser.close();
})();
