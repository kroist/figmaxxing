import type { Chain } from '../types.js';

export const CHAINS: Chain[] = [
  { id: 1, name: 'Ethereum', hexId: '0x1', rpc: 'https://eth.llamarpc.com' },
  { id: 42161, name: 'Arbitrum', hexId: '0xa4b1', rpc: 'https://arb1.arbitrum.io/rpc' },
  { id: 8453, name: 'Base', hexId: '0x2105', rpc: 'https://mainnet.base.org' },
  { id: 137, name: 'Polygon', hexId: '0x89', rpc: 'https://polygon-rpc.com' },
  { id: 10, name: 'Optimism', hexId: '0xa', rpc: 'https://mainnet.optimism.io' },
  { id: 56, name: 'BNB Chain', hexId: '0x38', rpc: 'https://bsc-dataseed.binance.org' },
  { id: 43114, name: 'Avalanche', hexId: '0xa86a', rpc: 'https://api.avax.network/ext/bc/C/rpc' },
];

export function findChain(id: number): Chain | undefined {
  return CHAINS.find(c => c.id === id);
}
