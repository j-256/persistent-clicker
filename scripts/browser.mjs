import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_ROOT = resolve(
  process.env.PERSISTENT_CLICKER_EXTENSION_ROOT || ROOT
);
const FIXTURE_ROOT = join(ROOT, "tests", "fixtures");
const SCREENSHOT_ROOT = join(ROOT, "docs", "screenshots");
const STORE_ASSET_ROOT = join(ROOT, "store-assets");
const BROWSER_OVERRIDE = process.env.PERSISTENT_CLICKER_BROWSER;
const SYSTEM_SCREENSHOT_PATH = "/usr/sbin/screencapture";
const SYSTEM_SCRIPT_PATH = "/usr/bin/osascript";
const EXTENSION_WORKER_PATH = "/src/background.js";
const EXTENSION_REINSTALL_MARKER = "__persistentClickerReinstallMarker";
const EXTENSION_CDP_METHOD = Object.freeze({
  INSTALL: "Extensions.loadUnpacked",
  UNINSTALL: "Extensions.uninstall"
});
const TARGET_SELECTOR = "#reload-page";
const TARGET_LABEL_SELECTOR = "#reload-page .button__label";
const PICK_HIGHLIGHT_SELECTOR = "#persistent-clicker-highlight";
const PICK_TOAST_SELECTOR = "#persistent-clicker-toast";
const SCREENSHOT_INTERVAL_SECONDS = "8";
const SECONDARY_CAPTURE_TIMERS = Object.freeze([
  Object.freeze({ intervalSeconds: "20", variant: "inventory" }),
  Object.freeze({ intervalSeconds: "45", variant: "report" })
]);
const DEFAULT_DEVICE_SCALE_FACTOR = 1;
const SCREENSHOT_DEVICE_SCALE_FACTOR = 2;
const BROWSER_VIEWPORT = Object.freeze({ width: 900, height: 560 });
const PICKER_RESIZE_VIEWPORT = Object.freeze({ width: 980, height: 620 });
const STORE_SCREENSHOT_VIEWPORT = Object.freeze({ width: 1_280, height: 800 });
const STORE_PROMO_VIEWPORT = Object.freeze({ width: 440, height: 280 });
const TEST_INTERVAL_SECONDS = "1";
const ERROR_PERSISTENCE_WAIT_MS = 1_600;
const CONTEXT_CAPTURE_SIZE = Object.freeze({ width: 760, height: 700 });
const CONTEXT_CAPTURE_BOTTOM_INSET = 100;
const SCREEN_BOUNDS_SCRIPT = [
  'ObjC.import("AppKit")',
  "const frame = $.NSScreen.mainScreen.frame",
  "[Number(frame.origin.x), Number(frame.origin.y), Number(frame.size.width), Number(frame.size.height)].join(',')"
].join("; ");
const FIXTURE_FILES = new Set(["navigation.html", "fixture.css", "fixture.js"]);
const mode = process.argv[2];
const execFileAsync = promisify(execFile);

assert(
  mode === "test" || mode === "screenshots",
  "Usage: node scripts/browser.mjs <test|screenshots>"
);

const CONTENT_TYPE = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
});

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBrowserLaunchOptions() {
  if (BROWSER_OVERRIDE) {
    assert(
      await pathExists(BROWSER_OVERRIDE),
      `PERSISTENT_CLICKER_BROWSER does not exist: ${BROWSER_OVERRIDE}`
    );
    return { executablePath: BROWSER_OVERRIDE };
  }

  assert(
    await pathExists(chromium.executablePath()),
    "Chrome for Testing is required. Run npm run browser:install"
  );
  return { channel: "chromium" };
}

async function settleVisual(page) {
  await page.evaluate(() => new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
  }));
}

async function waitForPickerHighlight(page) {
  await page.waitForFunction(
    ({ highlightSelector, targetSelector }) => {
      const highlight = document.querySelector(highlightSelector);
      const target = document.querySelector(targetSelector);

      if (!highlight || !target) {
        return false;
      }

      const highlightRect = highlight.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return Math.abs(highlightRect.left - targetRect.left) < 0.1
        && Math.abs(highlightRect.top - targetRect.top) < 0.1
        && Math.abs(highlightRect.width - targetRect.width) < 0.1
        && Math.abs(highlightRect.height - targetRect.height) < 0.1;
    },
    {
      highlightSelector: PICK_HIGHLIGHT_SELECTOR,
      targetSelector: TARGET_SELECTOR
    }
  );
}

async function poll(task, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const value = await task();

      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(100);
  }

  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");

      if (requestUrl.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      const filename = requestUrl.pathname === "/"
        ? "navigation.html"
        : requestUrl.pathname.slice(1);

      if (!FIXTURE_FILES.has(filename)) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      const content = await readFile(join(FIXTURE_ROOT, filename));
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": CONTENT_TYPE[extname(filename)] || "application/octet-stream"
      });
      response.end(content);
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = server.address();
  assert(address && typeof address === "object");

  return {
    server,
    url: `http://127.0.0.1:${address.port}/navigation.html?page=1`
  };
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function findExtensionWorker(context) {
  const existing = context.serviceWorkers().find(
    (worker) => worker.url().endsWith(EXTENSION_WORKER_PATH)
  );

  if (existing) {
    return existing;
  }

  return context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().endsWith(EXTENSION_WORKER_PATH),
    timeout: 20_000
  });
}

async function launchBrowser() {
  const browserLaunchOptions = await resolveBrowserLaunchOptions();
  const profilePath = await mkdtemp(join(tmpdir(), "persistent-clicker-"));

  try {
    const context = await chromium.launchPersistentContext(profilePath, {
      ...browserLaunchOptions,
      headless: mode === "test",
      ignoreDefaultArgs: ["--disable-extensions"],
      reducedMotion: "reduce",
      deviceScaleFactor: mode === "screenshots"
        ? SCREENSHOT_DEVICE_SCALE_FACTOR
        : DEFAULT_DEVICE_SCALE_FACTOR,
      viewport: BROWSER_VIEWPORT,
      args: [
        "--disable-component-update",
        "--enable-unsafe-extension-debugging",
        "--no-default-browser-check",
        "--no-first-run"
      ]
    });

    return { context, profilePath };
  } catch (error) {
    await rm(profilePath, { recursive: true, force: true });
    throw error;
  }
}

async function installExtension(context) {
  const browser = context.browser();
  assert(browser, "The persistent browser context must expose its browser");
  const browserSession = await browser.newBrowserCDPSession();

  try {
    const { id: extensionId } = await browserSession.send(
      EXTENSION_CDP_METHOD.INSTALL,
      { path: EXTENSION_ROOT }
    );
    const worker = await findExtensionWorker(context);
    return { browserSession, extensionId, worker };
  } catch (error) {
    await browserSession.detach();
    throw error;
  }
}

function collectPageErrors(page, errors) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
}

async function fixtureTabId(worker, fixturePage) {
  await fixturePage.bringToFront();

  return poll(async () => worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id || null;
  }), "Could not resolve the fixture tab ID");
}

async function openControlPage(context, extensionId, tabId, errors) {
  const controlPage = await context.newPage();
  const captureQuery = mode === "screenshots" ? "&capture=1" : "";
  collectPageErrors(controlPage, errors);

  try {
    await controlPage.goto(
      `chrome-extension://${extensionId}/popup/popup.html?tab=${tabId}${captureQuery}`
    );
    await controlPage.locator("#status-label").waitFor();
    return controlPage;
  } catch (error) {
    await controlPage.close().catch(() => undefined);
    throw error;
  }
}

async function waitForReinstalledExtensionWorker(context) {
  return poll(async () => {
    const candidates = context.serviceWorkers().filter(
      (worker) => worker.url().endsWith(EXTENSION_WORKER_PATH)
    );

    for (const candidate of candidates) {
      const retainsMarker = await candidate.evaluate((marker) => {
        return globalThis[marker] === true;
      }, EXTENSION_REINSTALL_MARKER).catch(() => true);

      if (!retainsMarker) {
        return candidate;
      }
    }

    return null;
  }, "The extension service worker did not restart", 20_000);
}

async function reinstallExtension(
  context,
  browserSession,
  extensionId,
  tabId,
  worker,
  controlPage,
  errors
) {
  await worker.evaluate((marker) => {
    globalThis[marker] = true;
  }, EXTENSION_REINSTALL_MARKER);
  await controlPage.close().catch(() => undefined);
  await browserSession.send(EXTENSION_CDP_METHOD.UNINSTALL, { id: extensionId });
  const installed = await browserSession.send(
    EXTENSION_CDP_METHOD.INSTALL,
    { path: EXTENSION_ROOT }
  );
  assert.equal(installed.id, extensionId, "Reinstalling must preserve the extension ID");
  const nextControlPage = await poll(
    () => openControlPage(context, extensionId, tabId, errors),
    "The extension popup did not reopen after reinstallation",
    20_000
  );
  const nextWorker = await waitForReinstalledExtensionWorker(context);
  return { controlPage: nextControlPage, worker: nextWorker };
}

async function verifyPickerRecovery(fixturePage, controlPage, lifecycle) {
  await fixturePage.bringToFront();
  await controlPage.bringToFront();
  await controlPage.locator("#pick-button").click();

  try {
    await fixturePage.locator("#persistent-clicker-prompt").waitFor({
      timeout: 3_000
    });
  } catch {
    const message = await controlPage.locator("#message").textContent();
    const response = await controlPage.evaluate(async () => {
      const params = new URLSearchParams(location.search);
      return chrome.runtime.sendMessage({
        type: "enter-pick-mode",
        tabId: Number(params.get("tab"))
      });
    });
    throw new Error(
      `Pick failed after extension ${lifecycle}: ${message || response?.error || "No error shown"}`
    );
  }

  await fixturePage.bringToFront();
  await fixturePage.locator(TARGET_LABEL_SELECTOR).hover();
  await fixturePage.locator(PICK_HIGHLIGHT_SELECTOR).waitFor();
  await waitForPickerHighlight(fixturePage);
  await fixturePage.setViewportSize(PICKER_RESIZE_VIEWPORT);
  await waitForPickerHighlight(fixturePage);
  await fixturePage.setViewportSize(BROWSER_VIEWPORT);
  await waitForPickerHighlight(fixturePage);
  await fixturePage.keyboard.press("Escape");
  await fixturePage.locator("#persistent-clicker-prompt").waitFor({
    state: "detached"
  });
  console.log(`Verified picker recovery on a tab left open across extension ${lifecycle}`);
}

async function verifyPickerErrorPersists(
  context,
  extensionId,
  worker,
  errors
) {
  const restrictedPage = await context.newPage();
  await restrictedPage.goto("chrome://version/");
  const tabId = await fixtureTabId(worker, restrictedPage);
  const controlPage = await openControlPage(
    context,
    extensionId,
    tabId,
    errors
  );
  await controlPage.locator("#pick-button").click();
  const message = await poll(async () => {
    const text = await controlPage.locator("#message").textContent();
    return text?.includes("Open a regular web page") ? text : null;
  }, "The popup did not explain the restricted page");
  await delay(ERROR_PERSISTENCE_WAIT_MS);
  assert.equal(await controlPage.locator("#message").textContent(), message);
  assert.equal(await controlPage.locator("#message").isVisible(), true);
  await controlPage.close();
  await restrictedPage.close();
  console.log("Verified picker errors remain visible across popup state polls");
}

async function openDashboardFromPopup(context, controlPage, errors) {
  await controlPage.bringToFront();
  const dashboardPromise = context.waitForEvent("page", { timeout: 10_000 });
  await controlPage.locator("#dashboard-button").click();
  const dashboardPage = await dashboardPromise;
  collectPageErrors(dashboardPage, errors);
  await dashboardPage.waitForURL(/\/dashboard\/dashboard\.html/);
  await dashboardPage.locator('html[data-ready="true"]').waitFor();
  return dashboardPage;
}

async function waitForDashboardTimer(dashboardPage, tabId) {
  const timer = dashboardPage.locator(`.timer[data-tab-id="${tabId}"]`);
  await timer.waitFor();
  return timer;
}

async function sendToContent(controlPage, tabId, message) {
  const response = await controlPage.evaluate(
    async ({ targetTabId, payload }) => chrome.tabs.sendMessage(targetTabId, payload),
    { targetTabId: tabId, payload: message }
  );
  assert(response?.ok, response?.error || "The content script did not respond");
  return response;
}

async function waitForSelectedTarget(controlPage) {
  await poll(async () => {
    const value = await controlPage.locator("#selector-input").inputValue();
    return value === TARGET_SELECTOR;
  }, "The selected target did not reach the popup");
}

async function chooseWithContextMenu(fixturePage, controlPage, tabId) {
  await fixturePage.bringToFront();
  await fixturePage.locator(TARGET_LABEL_SELECTOR).click({ button: "right" });
  await fixturePage.keyboard.press("Escape");
  await sendToContent(controlPage, tabId, { type: "select-context-target" });
  await waitForSelectedTarget(controlPage);
}

async function startFromPopup(controlPage, intervalSeconds) {
  await controlPage.bringToFront();
  await controlPage.locator("#interval-input").fill(intervalSeconds);
  await controlPage.locator("#start-button").click();
  await poll(async () => {
    return await controlPage.locator("#status-label").textContent() === "Running";
  }, "The popup did not enter its running state");
}

async function stopFromDashboard(
  dashboardPage,
  tabId,
  { expectEmpty = true } = {}
) {
  await dashboardPage.bringToFront();
  const timer = await waitForDashboardTimer(dashboardPage, tabId);
  await timer.locator('[data-action="stop"]').click();
  await timer.waitFor({ state: "detached" });

  if (expectEmpty) {
    await dashboardPage.locator("#empty-state").waitFor();
  }
}

async function primaryScreenBounds() {
  const { stdout } = await execFileAsync(SYSTEM_SCRIPT_PATH, [
    "-l",
    "JavaScript",
    "-e",
    SCREEN_BOUNDS_SCRIPT
  ]);
  const [left, top, width, height] = stdout
    .trim()
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10));
  assert(
    [left, top, width, height].every(Number.isFinite),
    "Could not resolve the primary screen bounds"
  );
  return { height, left, top, width };
}

async function captureContextMenu(fixturePage) {
  assert.equal(
    process.platform,
    "darwin",
    "Capturing the native right-click menu requires macOS"
  );
  await access(SYSTEM_SCREENSHOT_PATH, fsConstants.X_OK);
  await access(SYSTEM_SCRIPT_PATH, fsConstants.X_OK);
  const screenBounds = await primaryScreenBounds();
  await fixturePage.bringToFront();
  const browserSession = await fixturePage.context().newCDPSession(fixturePage);
  const { windowId } = await browserSession.send("Browser.getWindowForTarget");
  await browserSession.send("Browser.setWindowBounds", {
    bounds: { windowState: "maximized" },
    windowId
  });
  await delay(250);
  const captureRegion = await fixturePage.evaluate(
    ({ bottomInset, bounds, selector, size }) => {
      const target = document.querySelector(selector);
      assertTarget(target);
      const targetBounds = target.getBoundingClientRect();
      const targetCenterX = screenX
        + targetBounds.left + targetBounds.width / 2;
      const width = Math.min(size.width, bounds.width);
      const height = Math.min(size.height, bounds.height);
      const left = Math.min(
        Math.max(targetCenterX - 250, bounds.left),
        bounds.left + bounds.width - width
      );
      const top = bounds.top + bounds.height
        - bottomInset - height;

      return {
        height: Math.round(height),
        left: Math.round(left),
        top: Math.round(top),
        width: Math.round(width)
      };

      function assertTarget(value) {
        if (!(value instanceof HTMLElement)) {
          throw new Error(`Could not find ${selector} for the context-menu capture`);
        }
      }
    },
    {
      bottomInset: CONTEXT_CAPTURE_BOTTOM_INSET,
      bounds: screenBounds,
      selector: TARGET_SELECTOR,
      size: CONTEXT_CAPTURE_SIZE
    }
  );
  await fixturePage.locator(TARGET_SELECTOR).click({
    button: "right",
    position: { x: 130, y: 23 }
  });
  await delay(250);

  try {
    const region = [
      captureRegion.left,
      captureRegion.top,
      captureRegion.width,
      captureRegion.height
    ].join(",");
    await execFileAsync(SYSTEM_SCREENSHOT_PATH, [
      "-x",
      `-R${region}`,
      join(SCREENSHOT_ROOT, "right-click.png")
    ]);
  } finally {
    await fixturePage.keyboard.press("Escape");
    await browserSession.detach();
  }
}

async function captureStorePromo(context) {
  const promoPage = await context.newPage();
  const icon = await readFile(join(ROOT, "icons", "icon.svg"), "utf8");

  try {
    await promoPage.setViewportSize(STORE_PROMO_VIEWPORT);
    await promoPage.setContent(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <style>
            * { box-sizing: border-box; }
            html, body { width: 440px; height: 280px; margin: 0; overflow: hidden; }
            body {
              display: grid;
              place-items: center;
              background:
                radial-gradient(circle at 30% 20%, rgb(255 255 255 / 24%), transparent 34%),
                linear-gradient(135deg, #7668f0 0%, #5546cf 100%);
            }
            .orbit {
              position: absolute;
              width: 320px;
              height: 190px;
              border: 1px solid rgb(255 255 255 / 20%);
              border-radius: 50%;
              transform: rotate(-10deg);
            }
            .orbit::before, .orbit::after {
              position: absolute;
              width: 12px;
              height: 12px;
              border: 4px solid rgb(255 255 255 / 70%);
              border-radius: 50%;
              background: #6658e8;
              content: "";
            }
            .orbit::before { top: 24px; right: 30px; }
            .orbit::after { bottom: 18px; left: 42px; }
            .card {
              position: relative;
              display: grid;
              width: 164px;
              height: 164px;
              border: 1px solid rgb(255 255 255 / 55%);
              border-radius: 42px;
              background: rgb(255 255 255 / 94%);
              box-shadow: 0 28px 70px rgb(28 19 93 / 32%);
              place-items: center;
            }
            .card svg { width: 116px; height: 116px; filter: drop-shadow(0 12px 18px rgb(56 42 165 / 24%)); }
            .pulse {
              position: absolute;
              width: 202px;
              height: 202px;
              border: 2px solid rgb(255 255 255 / 30%);
              border-radius: 52px;
            }
          </style>
        </head>
        <body>
          <div class="orbit" aria-hidden="true"></div>
          <div class="pulse" aria-hidden="true"></div>
          <div class="card">${icon}</div>
        </body>
      </html>`);
    await settleVisual(promoPage);
    await promoPage.screenshot({
      path: join(STORE_ASSET_ROOT, "promo-small.png"),
      animations: "disabled",
      scale: "css"
    });
  } finally {
    await promoPage.close();
  }
}

async function createSecondaryCaptureTimer(
  context,
  worker,
  fixturePage,
  extensionId,
  errors,
  timer
) {
  const secondaryUrl = new URL(fixturePage.url());
  secondaryUrl.searchParams.set("demo", timer.variant);
  secondaryUrl.searchParams.set("page", "1");
  const fixture = await context.newPage();
  collectPageErrors(fixture, errors);
  await fixture.goto(secondaryUrl.href);
  await fixture.locator(TARGET_SELECTOR).waitFor();
  const tabId = await fixtureTabId(worker, fixture);
  const control = await openControlPage(context, extensionId, tabId, errors);
  await chooseWithContextMenu(fixture, control, tabId);
  await startFromPopup(control, timer.intervalSeconds);
  return { control, fixture, tabId };
}

async function captureScreenshots(
  context,
  worker,
  extensionId,
  fixturePage,
  controlPage,
  tabId,
  errors
) {
  await mkdir(SCREENSHOT_ROOT, { recursive: true });
  await mkdir(STORE_ASSET_ROOT, { recursive: true });
  await fixturePage.locator(PICK_TOAST_SELECTOR).waitFor({ state: "detached" });
  await captureContextMenu(fixturePage);
  await sendToContent(controlPage, tabId, { type: "enter-pick-mode" });
  await fixturePage.bringToFront();
  await fixturePage.locator(TARGET_LABEL_SELECTOR).hover();
  await fixturePage.locator(PICK_HIGHLIGHT_SELECTOR).waitFor();
  await waitForPickerHighlight(fixturePage);
  await settleVisual(fixturePage);
  await fixturePage.screenshot({
    path: join(SCREENSHOT_ROOT, "picker.png"),
    fullPage: true,
    animations: "disabled"
  });
  await fixturePage.setViewportSize(STORE_SCREENSHOT_VIEWPORT);
  await waitForPickerHighlight(fixturePage);
  await settleVisual(fixturePage);
  await fixturePage.screenshot({
    path: join(STORE_ASSET_ROOT, "screenshot-picker.png"),
    animations: "disabled",
    scale: "css"
  });
  await fixturePage.setViewportSize(BROWSER_VIEWPORT);
  await waitForPickerHighlight(fixturePage);

  await fixturePage.locator(TARGET_LABEL_SELECTOR).click();
  await fixturePage.locator(PICK_TOAST_SELECTOR).waitFor();
  await waitForSelectedTarget(controlPage);
  await startFromPopup(controlPage, SCREENSHOT_INTERVAL_SECONDS);
  await settleVisual(controlPage);
  await controlPage.locator(".app").screenshot({
    path: join(SCREENSHOT_ROOT, "popup.png"),
    animations: "disabled"
  });
  await controlPage.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await settleVisual(controlPage);
  await controlPage.locator(".app").screenshot({
    path: join(SCREENSHOT_ROOT, "popup-dark.png"),
    animations: "disabled"
  });
  const secondaryTimers = [];

  for (const timer of SECONDARY_CAPTURE_TIMERS) {
    secondaryTimers.push(await createSecondaryCaptureTimer(
      context,
      worker,
      fixturePage,
      extensionId,
      errors,
      timer
    ));
  }

  const dashboardPage = await openDashboardFromPopup(context, controlPage, errors);
  await waitForDashboardTimer(dashboardPage, tabId);

  for (const secondary of secondaryTimers) {
    await waitForDashboardTimer(dashboardPage, secondary.tabId);
  }

  assert.equal(
    await dashboardPage.locator(".timer").count(),
    SECONDARY_CAPTURE_TIMERS.length + 1
  );
  await dashboardPage.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await settleVisual(dashboardPage);
  await dashboardPage.screenshot({
    path: join(SCREENSHOT_ROOT, "dashboard.png"),
    fullPage: true,
    animations: "disabled"
  });
  await dashboardPage.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await settleVisual(dashboardPage);
  await dashboardPage.screenshot({
    path: join(SCREENSHOT_ROOT, "dashboard-dark.png"),
    fullPage: true,
    animations: "disabled"
  });
  await stopFromDashboard(dashboardPage, tabId, { expectEmpty: false });

  for (const [index, secondary] of secondaryTimers.entries()) {
    const isLast = index === secondaryTimers.length - 1;
    await stopFromDashboard(dashboardPage, secondary.tabId, {
      expectEmpty: isLast
    });
    await secondary.control.close();
    await secondary.fixture.close();
  }
  await captureStorePromo(context);
  console.log("Updated Chrome, interface, and store listing screenshots");
}

async function verifyNavigationPersistence(
  context,
  worker,
  fixturePage,
  controlPage,
  tabId,
  errors
) {
  await chooseWithContextMenu(fixturePage, controlPage, tabId);
  await startFromPopup(controlPage, TEST_INTERVAL_SECONDS);
  const dashboardPage = await openDashboardFromPopup(context, controlPage, errors);
  const timer = await waitForDashboardTimer(dashboardPage, tabId);
  assert.equal(await timer.locator("[data-status-label]").textContent(), "Running");
  await fixturePage.bringToFront();

  await poll(() => {
    return Number(new URL(fixturePage.url()).searchParams.get("page")) >= 2;
  }, "The first interval click did not navigate", 6_000);
  await poll(() => {
    return Number(new URL(fixturePage.url()).searchParams.get("page")) >= 3;
  }, "The second interval click did not navigate", 6_000);

  await dashboardPage.bringToFront();
  await timer.locator('[data-action="focus"]').click();
  await poll(async () => worker.evaluate(async (targetTabId) => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id === targetTabId;
  }, tabId), "The dashboard did not focus the target tab");

  await stopFromDashboard(dashboardPage, tabId);
  await fixturePage.bringToFront();
  const stoppedPage = new URL(fixturePage.url()).searchParams.get("page");
  await delay(1_300);
  assert.equal(new URL(fixturePage.url()).searchParams.get("page"), stoppedPage);

  const state = await controlPage.evaluate(
    async (targetTabId) => chrome.runtime.sendMessage({
      type: "get-state",
      tabId: targetTabId
    }),
    tabId
  );
  assert.equal(state.ok, true);
  assert.equal(state.state.running, false);
  assert.equal(state.state.target.selector, TARGET_SELECTOR);
  assert(state.state.clickCount >= 2);
  console.log("Verified rapid navigation and stopped its timer from the stable dashboard");
}

async function main() {
  const fixture = await startFixtureServer();
  const errors = [];
  let launched = null;

  try {
    launched = await launchBrowser();
    const fixturePage = await launched.context.newPage();
    collectPageErrors(fixturePage, errors);
    await fixturePage.goto(fixture.url);
    await fixturePage.locator(TARGET_SELECTOR).waitFor();
    Object.assign(launched, await installExtension(launched.context));
    const tabId = await fixtureTabId(launched.worker, fixturePage);
    let controlPage = await openControlPage(
      launched.context,
      launched.extensionId,
      tabId,
      errors
    );

    await verifyPickerRecovery(fixturePage, controlPage, "installation");

    if (mode === "screenshots") {
      await captureScreenshots(
        launched.context,
        launched.worker,
        launched.extensionId,
        fixturePage,
        controlPage,
        tabId,
        errors
      );
    } else {
      const reinstalled = await reinstallExtension(
        launched.context,
        launched.browserSession,
        launched.extensionId,
        tabId,
        launched.worker,
        controlPage,
        errors
      );
      controlPage = reinstalled.controlPage;
      launched.worker = reinstalled.worker;
      await verifyPickerRecovery(fixturePage, controlPage, "reinstallation");
      await verifyPickerErrorPersists(
        launched.context,
        launched.extensionId,
        launched.worker,
        errors
      );
      await verifyNavigationPersistence(
        launched.context,
        launched.worker,
        fixturePage,
        controlPage,
        tabId,
        errors
      );
    }

    assert.deepEqual(errors, [], `Browser console errors:\n${errors.join("\n")}`);
  } finally {
    if (launched) {
      await launched.browserSession?.detach().catch(() => undefined);
      await launched.context.close();
      await rm(launched.profilePath, { recursive: true, force: true });
    }

    await closeServer(fixture.server);
  }
}

await main();
