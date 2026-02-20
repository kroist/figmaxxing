import { readFileSync, writeFileSync, existsSync } from 'fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Wallet } from '../types.js';
import { ensureConfigDir, getConfigPath } from './config.js';

const WALLETS_FILE = 'wallets.json';

export function loadWallets(): Wallet[] {
  const path = getConfigPath(WALLETS_FILE);
  if (!existsSync(path)) return [];
  try {
    const data = readFileSync(path, 'utf-8');
    return JSON.parse(data);
  } catch {
    throw new Error(
      `Could not read wallet file at ${path}. Delete it and create a new wallet.`
    );
  }
}

export function saveWallets(wallets: Wallet[]): void {
  ensureConfigDir();
  writeFileSync(getConfigPath(WALLETS_FILE), JSON.stringify(wallets, null, 2));
}

export function createWallet(name: string): Wallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const wallet: Wallet = { name, address: account.address, privateKey };
  const wallets = loadWallets();
  wallets.push(wallet);
  saveWallets(wallets);
  return wallet;
}

export function importWallet(name: string, privateKey: string): Wallet {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('Invalid private key. Must be 0x followed by 64 hex characters.');
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const wallet: Wallet = { name, address: account.address, privateKey };
  const wallets = loadWallets();
  wallets.push(wallet);
  saveWallets(wallets);
  return wallet;
}

export function createEphemeralWallet(): Wallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { name: 'Ephemeral', address: account.address, privateKey };
}

export function deleteWallet(address: string): void {
  const wallets = loadWallets().filter(w => w.address !== address);
  saveWallets(wallets);
}
