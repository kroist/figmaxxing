import type { BrowserContext, Page } from 'playwright';
import { EventEmitter } from 'events';
import { log, logError } from './logger.js';

export type CaptureResult = {
  success: boolean;
  error?: string;
};

/**
 * Expose the __submitCapture function on the browser context.
 * This proxies fetch calls from capture.js to mcp.figma.com through Node.js
 * (bypassing any CSP restrictions in the page).
 *
 * Emits 'capture:submitted' on the events emitter whenever a submission goes through.
 */
export async function setupFigmaProxy(
  context: BrowserContext,
  _captureId: string,
  events?: EventEmitter,
): Promise<void> {
  await context.exposeFunction('__submitCapture', async (targetUrl: string, dataStr: string) => {
    log(`Capture submit → ${targetUrl}`);
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: dataStr,
    });
    const text = await response.text();
    log(`Capture response: ${response.status}`);
    log(`Capture response body: ${text.slice(0, 500)}`);

    // Parse structured response from Figma capture API
    try {
      const data = JSON.parse(text);
      if (data.claimUrl) {
        log(`Claim URL: ${data.claimUrl}`);
        events?.emit('capture:claimUrl', data.claimUrl);
      }
      if (data.nextCaptureId) {
        log(`Next capture ID: ${data.nextCaptureId}`);
        events?.emit('capture:nextId', data.nextCaptureId);
      }
    } catch {
      // Not JSON — try regex fallback for any Figma URL
      const figmaUrl = text.match(/https?:\/\/(?:www\.)?figma\.com\/[^\s"'<>]+/);
      if (figmaUrl) {
        log(`Figma URL found in response: ${figmaUrl[0]}`);
        events?.emit('capture:claimUrl', figmaUrl[0]);
      }
    }

    events?.emit('capture:submitted', text);
    return text;
  });
}

/**
 * Inject the Figma capture toolbar into the page:
 * 1. Fetch capture.js from mcp.figma.com
 * 2. Inject into page via evaluate (bypasses CSP)
 * 3. Monkey-patch fetch to route mcp.figma.com calls through __submitCapture
 *
 * The Figma toolbar handles the actual capture — the user clicks "capture" in the browser.
 */
export async function injectCaptureToolbar(
  page: Page,
  context: BrowserContext,
  captureId: string,
): Promise<CaptureResult> {
  // 1. Fetch the capture script
  log('Fetching Figma capture script...');
  let scriptText: string;
  try {
    const resp = await context.request.get('https://mcp.figma.com/mcp/html-to-design/capture.js');
    scriptText = await resp.text();
    log(`Capture script fetched (${scriptText.length} bytes)`);
  } catch (err: any) {
    logError('Fetch capture script', err);
    return {
      success: false,
      error: `Could not fetch Figma capture script from mcp.figma.com. Check your internet connection. ${err.message}`,
    };
  }

  // 2. Inject the script
  await page.evaluate(scriptText);
  await page.waitForTimeout(1000);

  // 3. Monkey-patch fetch so the toolbar's submissions go through our Node.js proxy
  // 4. Fire off captureForDesign (this shows the toolbar) — don't await it
  await page.evaluate((cid: string) => {
    if (!(window as any).__fetchPatched) {
      const originalFetch = window.fetch;
      window.fetch = async (url: any, opts: any) => {
        if (typeof url === 'string' && url.includes('mcp.figma.com')) {
          const responseText = await (window as any).__submitCapture(url, opts?.body);
          return new Response(responseText, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(url, opts);
      };
      (window as any).__fetchPatched = true;
    }

    // Fire-and-forget: captureForDesign shows the toolbar, captures are
    // handled by the fetch monkey-patch + __submitCapture proxy
    (window as any).figma?.captureForDesign({
      captureId: cid,
      endpoint: `https://mcp.figma.com/mcp/capture/${cid}/submit`,
      selector: 'body',
    }).catch(() => {});
  }, captureId);

  return { success: true };
}

/**
 * Intercept popups (new tabs) from the capture widget that navigate to figma.com.
 * When the widget's "link" button opens the Figma file, Playwright creates a new page.
 * We catch it, extract the URL, emit it, and close the popup.
 */
export function interceptFigmaPopups(
  context: BrowserContext,
  events?: EventEmitter,
): void {
  context.on('page', async (popup) => {
    const url = popup.url();
    log(`Popup opened: ${url}`);
    if (url.includes('figma.com')) {
      events?.emit('capture:figmaUrl', url);
    }
    // Also listen if the popup navigates after opening (about:blank → figma URL)
    popup.on('framenavigated', (frame) => {
      if (frame === popup.mainFrame()) {
        const navUrl = frame.url();
        if (navUrl.includes('figma.com') && navUrl !== 'about:blank') {
          log(`Popup navigated to: ${navUrl}`);
          events?.emit('capture:figmaUrl', navUrl);
        }
      }
    });
  });
}

