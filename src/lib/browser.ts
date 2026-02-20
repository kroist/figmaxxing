import { EventEmitter } from 'events';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { CaptureConfig } from '../types.js';
import { setupRpcProxy } from './rpc-proxy.js';
import { setupFigmaProxy, interceptFigmaPopups } from './capture.js';

export type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

/**
 * Launch a headed Playwright Chromium browser with wallet injection and RPC proxy.
 */
export async function launchBrowser(
  config: CaptureConfig,
  events: EventEmitter,
): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // Setup exposed functions before any page loads
  await setupRpcProxy(context, config, events);
  await setupFigmaProxy(context, config.captureId, events);
  interceptFigmaPopups(context, events);
  await injectWalletProvider(context, config.wallet.address, config.chain.hexId, config.chain.id);

  const page = await context.newPage();
  await page.goto(config.url, { waitUntil: 'domcontentloaded' });

  return { browser, context, page };
}

/**
 * Inject the EIP-1193 / EIP-6963 wallet provider via addInitScript.
 */
async function injectWalletProvider(
  context: BrowserContext,
  address: string,
  chainHex: string,
  chainId: number,
): Promise<void> {
  await context.addInitScript(`
    const listeners = {};
    const ADDRESS = '${address}';
    const CHAIN_HEX = '${chainHex}';
    const NET_VER = '${chainId}';

    const provider = {
      isMetaMask: true,
      isConnected: () => true,
      chainId: CHAIN_HEX,
      networkVersion: NET_VER,
      selectedAddress: ADDRESS,

      on(event, fn) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
        return provider;
      },
      once(event, fn) {
        const w = (...a) => { provider.removeListener(event, w); fn(...a); };
        return provider.on(event, w);
      },
      removeListener(event, fn) {
        if (listeners[event]) listeners[event] = listeners[event].filter(f => f !== fn);
        return provider;
      },
      removeAllListeners(event) {
        if (event) delete listeners[event];
        else Object.keys(listeners).forEach(k => delete listeners[k]);
        return provider;
      },
      emit(event, ...args) {
        (listeners[event] || []).forEach(fn => {
          try { fn(...args); } catch(e) { console.error(e); }
        });
      },
      listenerCount(event) { return (listeners[event] || []).length; },
      listeners(event) { return [...(listeners[event] || [])]; },

      async request({ method, params }) {
        return await window.__rpcProxy(method, params || []);
      },
      sendAsync(payload, cb) {
        provider.request({ method: payload.method, params: payload.params })
          .then(result => cb(null, { id: payload.id, jsonrpc: '2.0', result }))
          .catch(error => cb(error));
      },
      send(m, p) {
        if (typeof m === 'string') return provider.request({ method: m, params: p });
        return provider.sendAsync(m, p);
      },
      enable() {
        return provider.request({ method: 'eth_requestAccounts' });
      },
    };

    window.ethereum = provider;

    // EIP-6963 provider announcement
    const info = {
      uuid: 'figmaxxing-injected-wallet',
      name: 'MetaMask',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="%23F6851B"/></svg>',
      rdns: 'io.metamask',
    };

    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }));
    });
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }));
    }, 0);
  `);
}
