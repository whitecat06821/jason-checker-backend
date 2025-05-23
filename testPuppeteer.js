import puppeteer from "puppeteer";

(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto("https://www.google.com", { waitUntil: "networkidle2", timeout: 120000 });
  await new Promise(res => setTimeout(res, 5000));
  await browser.close();
})();

