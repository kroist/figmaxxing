import type { BrowserContext, Page } from 'playwright';

export type CaptureResult = {
  success: boolean;
  error?: string;
};

/**
 * Expose the __submitCapture function on the browser context.
 * This proxies fetch calls from capture.js to mcp.figma.com through Node.js
 * (bypassing any CSP restrictions in the page).
 */
export async function setupFigmaProxy(
  context: BrowserContext,
  captureId: string,
): Promise<void> {
  const endpoint = `https://mcp.figma.com/mcp/capture/${captureId}/submit`;

  await context.exposeFunction('__submitCapture', async (dataStr: string) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: dataStr,
    });
    return await response.text();
  });
}

/**
 * Execute the Figma capture:
 * 1. Fetch capture.js from mcp.figma.com
 * 2. Inject into page via evaluate (bypasses CSP)
 * 3. Monkey-patch fetch to route mcp.figma.com calls through __submitCapture
 * 4. Call captureForDesign()
 */
export async function executeCapture(
  page: Page,
  context: BrowserContext,
  captureId: string,
): Promise<CaptureResult> {
  // 1. Fetch the capture script
  let scriptText: string;
  try {
    const resp = await context.request.get('https://mcp.figma.com/mcp/html-to-design/capture.js');
    scriptText = await resp.text();
  } catch (err: any) {
    return {
      success: false,
      error: `Could not fetch Figma capture script from mcp.figma.com. Check your internet connection. ${err.message}`,
    };
  }

  // 2. Inject the script
  await page.evaluate(scriptText);
  await page.waitForTimeout(1000);

  // 3. Verify it loaded
  const hasFigma = await page.evaluate(() => typeof (window as any).figma?.captureForDesign === 'function');
  if (!hasFigma) {
    return { success: false, error: 'Capture script failed to load. captureForDesign function not found.' };
  }

  // 4. Run capture with fetch monkey-patch
  const result = await page.evaluate(async (cid: string) => {
    try {
      const originalFetch = window.fetch;
      window.fetch = async (url: any, opts: any) => {
        if (typeof url === 'string' && url.includes('mcp.figma.com')) {
          const responseText = await (window as any).__submitCapture(opts.body);
          return new Response(responseText, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(url, opts);
      };

      return await (window as any).figma.captureForDesign({
        captureId: cid,
        endpoint: `https://mcp.figma.com/mcp/capture/${cid}/submit`,
        selector: 'body',
      });
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }, captureId);

  if (result && typeof result === 'object' && 'error' in result && result.error) {
    return { success: false, error: `Capture failed: ${result.error}` };
  }

  return { success: true };
}
