import { EventEmitter } from 'events';
import type { BrowserContext } from 'playwright';
import { createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { CaptureConfig, TxRequest } from '../types.js';

let requestIdCounter = 0;

/**
 * Setup the __rpcProxy exposed function on the browser context.
 *
 * For non-signing methods: proxies directly to the RPC endpoint.
 * For signing methods: auto-signs in Stage 4. Stage 5 wires EventEmitter-based manual approval.
 */
export async function setupRpcProxy(
  context: BrowserContext,
  config: CaptureConfig,
  events: EventEmitter,
): Promise<void> {
  const account = privateKeyToAccount(config.wallet.privateKey as Hex);
  const chain = {
    id: config.chain.id,
    name: config.chain.name,
    nativeCurrency: { decimals: 18, name: 'ETH', symbol: 'ETH' },
    rpcUrls: { default: { http: [config.chain.rpc] } },
  };
  const walletClient = createWalletClient({ account, chain, transport: http(config.chain.rpc) });

  await context.exposeFunction('__rpcProxy', async (method: string, params: any[]) => {
    try {
      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [account.address];

        case 'eth_chainId':
          return config.chain.hexId;

        case 'net_version':
          return String(config.chain.id);

        case 'wallet_requestPermissions':
          return [{ parentCapability: 'eth_accounts' }];

        case 'wallet_getPermissions':
          return [{ parentCapability: 'eth_accounts' }];

        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null;

        case 'personal_sign': {
          const [message] = params;
          const sign = async () => account.signMessage({ message: { raw: message } });

          // Emit event for TUI approval (Stage 5 hooks this up)
          // For now, if no listeners, auto-sign
          if (events.listenerCount('tx:request') > 0) {
            return await new Promise((resolve, reject) => {
              const request: TxRequest = {
                id: ++requestIdCounter,
                method,
                params,
                display: { message: tryDecodeUtf8(message) },
                sign,
                resolve,
                reject,
              };
              events.emit('tx:request', request);
            });
          }
          return await sign();
        }

        case 'eth_signTypedData_v4': {
          const [, typedDataJson] = params;
          const parsed = JSON.parse(typedDataJson);
          const sign = async () => account.signTypedData(parsed);

          if (events.listenerCount('tx:request') > 0) {
            return await new Promise((resolve, reject) => {
              const request: TxRequest = {
                id: ++requestIdCounter,
                method,
                params,
                display: {
                  domain: parsed.domain?.name || 'Unknown',
                  primaryType: parsed.primaryType || 'Unknown',
                  data: JSON.stringify(parsed.message, null, 2),
                },
                sign,
                resolve,
                reject,
              };
              events.emit('tx:request', request);
            });
          }
          return await sign();
        }

        case 'eth_sendTransaction': {
          const [tx] = params;
          const sign = async () =>
            walletClient.sendTransaction({
              to: tx.to,
              data: tx.data,
              value: tx.value ? BigInt(tx.value) : undefined,
              gas: tx.gas ? BigInt(tx.gas) : undefined,
            });

          if (events.listenerCount('tx:request') > 0) {
            return await new Promise((resolve, reject) => {
              const dataBytes = tx.data
                ? Math.floor((tx.data.length - 2) / 2)
                : 0;
              const request: TxRequest = {
                id: ++requestIdCounter,
                method,
                params,
                display: {
                  to: tx.to || '(contract creation)',
                  value: formatWei(tx.value),
                  data: tx.data
                    ? `${tx.data.slice(0, 20)}...  (${dataBytes} bytes)`
                    : '(none)',
                  gas: tx.gas || 'auto',
                },
                sign,
                resolve,
                reject,
              };
              events.emit('tx:request', request);
            });
          }
          return await sign();
        }

        default: {
          const response = await fetch(config.chain.rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }),
          });
          const json = await response.json();
          if (json.error) throw new Error(JSON.stringify(json.error));
          return json.result;
        }
      }
    } catch (err: any) {
      throw new Error(err.message || String(err));
    }
  });
}

function tryDecodeUtf8(hex: string): string {
  try {
    if (hex.startsWith('0x')) {
      const bytes = Buffer.from(hex.slice(2), 'hex');
      const text = bytes.toString('utf8');
      // Check if it's printable
      if (/^[\x20-\x7E\n\r\t]+$/.test(text)) return text;
    }
    return hex;
  } catch {
    return hex;
  }
}

function formatWei(value: string | undefined): string {
  if (!value || value === '0x0' || value === '0x') return '0 ETH';
  try {
    const bi = BigInt(value);
    const eth = Number(bi) / 1e18;
    return `${eth} ETH`;
  } catch {
    return value;
  }
}
