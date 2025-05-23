import fs from "fs";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import axios from "axios";
import { EventEmitter } from "events";
import path from "path";

puppeteer.use(StealthPlugin());

// Event emitter for real-time updates
export const ticketEmitter = new EventEmitter();

// Cache for browser instances
const browserCache = new Map();

// Cache for network data
const networkDataCache = new Map();

// Create screenshots directory if it doesn't exist
const SCREENSHOTS_DIR = "./screenshots";
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Function to capture and save screenshot
async function captureScreenshot(page, name) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${name}_${timestamp}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);

  try {
    await page.screenshot({
      path: filepath,
      fullPage: true,
    });
    console.log(`📸 Screenshot saved: ${filepath}`);
    return filepath;
  } catch (err) {
    console.error("❌ Failed to capture screenshot:", err.message);
    return null;
  }
}

// Function to log network requests
async function logNetworkRequests(page) {
  const requests = [];

  page.on("request", (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      timestamp: new Date().toISOString(),
    });
  });

  page.on("response", async (response) => {
    const request = response.request();
    const requestData = requests.find((r) => r.url === request.url());

    if (requestData) {
      try {
        const contentType = response.headers()["content-type"];
        if (contentType && contentType.includes("application/json")) {
          const responseData = await response.json();
          requestData.response = {
            status: response.status(),
            contentType,
            data: responseData,
          };
        }
      } catch (e) {
        // Ignore non-JSON responses
      }
    }
  });

  return requests;
}

async function getBrowser() {
  console.log("🔍 Checking for existing browser instance...");
  if (browserCache.has("default")) {
    console.log("✅ Using existing browser instance");
    return browserCache.get("default");
  }

  console.log("🔄 Launching new browser instance...");
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1024,768",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-site-isolation-trials",
      "--disable-webgl",
      "--disable-gpu-sandbox",
      "--disable-gpu-sandbox-allow-signaling",
      "--disable-webrtc",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--disable-features=WebRtcAllowLegacyTLSProtocols",
      "--disable-features=WebRtcAllowMultipleRoutes",
      "--disable-features=WebRtcAllowLoopbackPeerConnections",
    ],
    userDataDir: "./tmp/puppeteer",
  });

  console.log("✅ Browser launched successfully");
  browserCache.set("default", browser);
  return browser;
}

async function getIP(page) {
  try {
    console.log("🌐 Checking IP address...");
    const ipPage = await page.browser().newPage();
    await ipPage.goto("https://api.ipify.org?format=json");
    const ip = await ipPage.evaluate(() => document.body.innerText);
    await ipPage.close();
    console.log(`✅ Current IP: ${ip}`);
    return ip;
  } catch (err) {
    console.error("❌ Failed to get IP:", err.message);
    return null;
  }
}

async function extractStadiumData(page) {
  console.log("🏟️ Starting stadium data extraction...");
  try {
    // Wait for page to be fully loaded
    console.log("⏳ Waiting for page to load...");
    await page.waitForSelector("body", { timeout: 30000 });

    // Try multiple selectors for stadium data
    const selectors = [
      'svg[data-bdd="venue-map"]',
      'div[data-bdd="venue-map"]',
      'div[class*="venue-map"]',
      'div[class*="stadium"]',
    ];

    let stadiumImage = null;
    let layoutData = null;

    // Try each selector
    console.log("🔍 Searching for stadium map...");
    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        stadiumImage = await page.$eval(selector, (el) => el.outerHTML);
        console.log(`✅ Found stadium map using selector: ${selector}`);
        break;
      } catch (e) {
        console.log(`⚠️ Selector not found: ${selector}`);
        continue;
      }
    }

    // Extract layout data if we found the stadium image
    if (stadiumImage) {
      console.log("📊 Extracting stadium layout data...");
      layoutData = await page.evaluate(() => {
        const sections = Array.from(
          document.querySelectorAll('[data-bdd*="section"], [class*="section"]')
        );
        return sections.map((section) => ({
          id: section.getAttribute("data-section-id") || section.id,
          name:
            section.getAttribute("data-section-name") ||
            section.textContent.trim(),
          coordinates: section.getAttribute("data-coordinates") || null,
        }));
      });
      console.log(`✅ Extracted ${layoutData.length} sections`);
    }

    return { stadiumImage, layoutData };
  } catch (err) {
    console.error("❌ Failed to extract stadium data:", err);
    return null;
  }
}

async function fetchNetworkData(page, eventId) {
  console.log("🌐 Starting network data collection...");
  return new Promise((resolve) => {
    let networkData = null;
    let timeoutId = null;

    const responseHandler = async (response) => {
      const url = response.url();
      if (
        url.includes(eventId) &&
        response.request().resourceType() === "xhr"
      ) {
        try {
          const json = await response.json();
          if (json && typeof json === "object") {
            networkData = json;
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            console.log("✅ Network data collected successfully");
            resolve(networkData);
          }
        } catch (e) {
          // Ignore non-JSON responses
        }
      }
    };

    page.on("response", responseHandler);

    timeoutId = setTimeout(() => {
      page.off("response", responseHandler);
      console.log("⚠️ Network data collection timed out");
      resolve(null);
    }, 10000);
  });
}

export async function fetchAvailableTickets(url) {
  console.log("\n🚀 Starting ticket fetch process...");
  console.log(`📌 URL: ${url}`);

  const eventIdMatch = url.match(/event\/([A-Z0-9]+)/i);
  const eventId = eventIdMatch ? eventIdMatch[1] : null;

  if (!eventId) {
    console.error("❌ Invalid Ticketmaster URL: Could not extract event ID");
    throw new Error("Invalid Ticketmaster URL: Could not extract event ID");
  }
  console.log(`🎫 Event ID: ${eventId}`);

  // Check cache first
  if (networkDataCache.has(eventId)) {
    const cachedData = networkDataCache.get(eventId);
    if (Date.now() - cachedData.timestamp < 5000) {
      console.log("✅ Using cached data");
      return cachedData.data;
    }
  }

  console.log("🔄 Getting browser instance...");
  const browser = await getBrowser();
  let page = await browser.newPage();
  console.log("✅ New page created");

  try {
    // Set viewport size
    await page.setViewport({ width: 860, height: 480 });

    // Close all tabs except this one after navigation
    async function closeOtherTabs(currentPage) {
      const pages = await browser.pages();
      for (const p of pages) {
        if (p !== currentPage) {
          await p.close();
        }
      }
    }

    console.log("👤 Setting user agent...");
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Navigate to page with retry
    let retryCount = 0;
    const maxRetries = 3;
    let navigationSuccess = false;
    let lastError = null;
    while (retryCount < maxRetries && !navigationSuccess) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        console.log("✅ [Page] Ticketmaster event page opened.");
        await closeOtherTabs(page);
        // Extra wait for slow networks
        console.log("⏳ Waiting extra 12 seconds for slow network...");
        await sleep(12000);
        navigationSuccess = true;
      } catch (err) {
        lastError = err;
        retryCount++;
        console.log(
          `⚠️ Navigation attempt ${retryCount} failed: ${err.message}`
        );
        await captureScreenshot(
          page,
          `navigation_failed_attempt_${retryCount}`
        );
        if (retryCount === maxRetries) {
          console.log("❌ All navigation attempts failed. Giving up.");
          throw err;
        }
        await sleep(2000);
      }
    }

    // --- SMART BOT CHECK & BLOCK PAGE HANDLING ---
    let passed = false;
    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts && !passed) {
      attempt++;
      // Wait for full page load (no 'Loading...')
      console.log(
        `⏳ [Wait] Waiting for full page load (attempt ${attempt})...`
      );
      await page.waitForFunction(
        () => !document.body.innerText.includes("Loading..."),
        { timeout: 120000 }
      );
      await sleep(2000); // Human-like gap
      await captureScreenshot(page, `after_full_load_attempt_${attempt}`);

      // 1. Check for bot check page
      const checkboxSelector = "button.checkbox-container#captcha-checkbox";
      const checkbox = await page.$(checkboxSelector);
      if (checkbox) {
        console.log("🤖 [Bot Check] Detected. Clicking...");
        await checkbox.click();
        await sleep(4000);
        await captureScreenshot(
          page,
          `after_bot_checkbox_click_attempt_${attempt}`
        );
        continue; // Re-check after bot check
      }

      // 2. Check for error/block page
      const pageText = await page.evaluate(() => document.body.innerText);
      if (pageText.includes("Your Browsing Activity Has Been Paused")) {
        console.log("❌ [Block] Detected. Reloading (F5)...");
        await page.keyboard.press("F5");
        await sleep(4000);
        await captureScreenshot(page, `after_block_reload_attempt_${attempt}`);
        continue; // Re-check after reload
      }

      // 3. If neither, proceed
      passed = true;
    }

    if (!passed) {
      console.log(
        "❌ [Status] Could not pass bot check or block page after multiple attempts."
      );
      await captureScreenshot(page, "final_failed_status");
      return {
        eventId,
        tickets: [],
        stadiumData: null,
        networkData: null,
        status: "failed",
        reason: "Bot check or block page not passed",
      };
    }

    // Now wait for Accept & Continue button
    const acceptSelector = 'button[data-bdd="accept-modal-accept-button"]';
    console.log("⏳ [Accept] Waiting for Accept & Continue button...");
    await page.waitForSelector(acceptSelector, { timeout: 120000 });
    console.log("🔍 [Accept] Accept & Continue button found. Clicking...");
    await captureScreenshot(page, "accept_and_continue_modal");
    await page.click(acceptSelector);

    // Wait for FULL page load after clicking Accept
    console.log("⏳ [Load] Waiting for Loading... text to disappear...");
    await page.waitForFunction(
      () => {
        const pageText = document.body.innerText;
        return !pageText.includes("Loading...");
      },
      { timeout: 120000 }
    );
    console.log("✅ [Load] Page fully loaded (Loading... text disappeared).");
    await captureScreenshot(page, "full_page_loaded_after_accept");

    // Now fetch the data
    console.log("🎫 [Fetch] Starting data extraction...");

    // --- PAGE VALIDATION & BOT CHECK HANDLING ---
    let currentUrl = page.url();
    let realEventPage =
      currentUrl.includes(`/event/${eventId}`) &&
      !/verify you are human|extra protections|recaptcha|your browsing activity has been unusual/i.test(
        pageContent
      );

    if (!realEventPage) {
      console.log(
        "⚠️ Not on real event page after first load. Taking screenshot and reloading..."
      );
      await captureScreenshot(page, "not_real_event_first_load");
      await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
      await sleep(7000);
      currentUrl = page.url();
      pageContent = await page.content();
      realEventPage =
        currentUrl.includes(`/event/${eventId}`) &&
        !/verify you are human|extra protections|recaptcha|your browsing activity has been unusual/i.test(
          pageContent
        );
    }

    if (!realEventPage) {
      console.log(
        "⚠️ Still not on real event page after reload. Checking for bot check and trying to click checkbox if present."
      );
      await captureScreenshot(page, "not_real_event_after_reload");
      // Try to click the reCAPTCHA checkbox if present
      try {
        const checkboxSelector = "button.checkbox-container#captcha-checkbox";
        const checkbox = await page.$(checkboxSelector);
        if (checkbox) {
          console.log("🤖 [Bot Check] Detected bot checkbox.");
          await checkbox.click();
          console.log(
            "✅ [Bot Check] Bot checkbox clicked! Waiting for page to reload..."
          );
          await sleep(4000);
          await captureScreenshot(page, "after_bot_checkbox_click");

          // Wait for Loading... to disappear after checkbox click
          console.log(
            "⏳ [Load] Waiting for Loading... text to disappear after bot check..."
          );
          await page.waitForFunction(
            () => {
              const pageText = document.body.innerText;
              return !pageText.includes("Loading...");
            },
            { timeout: 120000 }
          );
          console.log("✅ [Load] Page fully loaded after bot check.");
          await captureScreenshot(page, "full_page_loaded_after_bot_check");
        } else {
          console.log("ℹ️ [Bot Check] No bot checkbox found.");
        }
      } catch (e) {
        console.log(
          "⚠️ [Bot Check] Error while trying to click bot checkbox:",
          e.message
        );
      }
    }

    if (!realEventPage) {
      console.log(
        "❌ [Bot Check] Unable to reach real event page after all attempts. Returning empty JSON."
      );
      const emptyResult = {
        eventId,
        tickets: [],
        stadiumData: null,
        networkData: null,
        botCheck: true,
      };
      console.log(JSON.stringify(emptyResult, null, 2));
      return emptyResult;
    }

    // --- DATA EXTRACTION ---
    // Extract stadium data with retry
    let stadiumData = null;
    retryCount = 0;
    while (retryCount < maxRetries && !stadiumData) {
      stadiumData = await extractStadiumData(page);
      if (!stadiumData) {
        retryCount++;
        console.log(`⚠️ Stadium data extraction attempt ${retryCount} failed`);
        await sleep(2000);
      }
    }

    // Wait for network data
    console.log("⏳ Waiting for network data...");
    const networkData = await fetchNetworkData(page, eventId);

    // Extract ticket data from DOM
    console.log("🎫 Extracting ticket data from DOM...");
    const tickets = await page.$$eval(
      'li[data-bdd="quick-picks-list-item-resale"]',
      (nodes) =>
        nodes.map((el) => ({
          sectionRow:
            el
              .querySelector('span[data-bdd="quick-pick-item-desc"]')
              ?.innerText.trim() || "",
          price:
            el
              .querySelector('button[data-bdd="quick-pick-price-button"]')
              ?.innerText.trim() || "",
          type:
            el
              .querySelector('span[data-bdd="quick-picks-resale-branding"]')
              ?.innerText.trim() || "",
          timestamp: new Date().toISOString(),
        }))
    );

    // If no stadium or ticket data, output empty JSON
    if (
      !stadiumData ||
      !stadiumData.layoutData ||
      stadiumData.layoutData.length === 0 ||
      !tickets ||
      tickets.length === 0
    ) {
      console.log("❌ [Response] No stadium or ticket data found.");
      const emptyResult = {
        eventId,
        tickets: [],
        stadiumData: null,
        networkData: null,
      };
      console.log(JSON.stringify(emptyResult, null, 2));
      return emptyResult;
    }

    // Cache the network data
    if (networkData) {
      networkDataCache.set(eventId, {
        data: networkData,
        timestamp: Date.now(),
      });
    }

    // Prepare result
    const result = {
      eventId,
      tickets,
      stadiumData,
      networkData,
    };

    // Save result as JSON file
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonFile = `./screenshots/ticketmaster_${eventId}_${timestamp}.json`;
    fs.writeFileSync(jsonFile, JSON.stringify(result, null, 2));
    console.log(`✅ Data found and saved to ${jsonFile}`);
    console.log(JSON.stringify(result, null, 2));

    // Emit real-time update
    result.timestamp = new Date();
    ticketEmitter.emit("ticketUpdate", result);

    console.log("✅ Ticket fetch process completed successfully\n");

    console.log("--- SUMMARY ---");
    console.log(`JSON: ${jsonFile ? "Created" : "Not created"}`);
    console.log(`Stadium image: ${stadiumData ? "Extracted" : "Not found"}`);
    console.log(`Screenshots: Check ./screenshots/ for PNG files`);

    await page.goto('https://api.ipify.org');
    const ip = await page.evaluate(() => document.body.innerText);
    console.log('Puppeteer IP:', ip);

    return result;
  } catch (err) {
    console.error("❌ Puppeteer scraping failed:", err.message);
    throw err;
  } finally {
    console.log(
      "🧹 Skipping page/browser close to keep browser open for user inspection."
    );
  }
}

// Cleanup function for browser instances
export async function cleanup() {
  console.log("🧹 Starting cleanup process...");
  for (const browser of browserCache.values()) {
    console.log("🔄 Closing browser instance...");
    await browser.close();
  }
  browserCache.clear();
  networkDataCache.clear();
  console.log("✅ Cleanup completed");
}

// For direct testing:
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const url =
    "https://www.ticketmaster.com/denver-broncos-vs-tennessee-titans-denver-colorado-09-07-2025/event/1E00625CD153457B";
  fetchAvailableTickets(url);
}
