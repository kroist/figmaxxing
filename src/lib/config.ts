import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.figmaxxing');
const SETUP_MARKER = 'setup_complete';

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function getConfigPath(filename: string): string {
  return join(CONFIG_DIR, filename);
}

export function isFirstRun(): boolean {
  return !existsSync(getConfigPath(SETUP_MARKER));
}

export function markSetupComplete(): void {
  ensureConfigDir();
  writeFileSync(getConfigPath(SETUP_MARKER), '');
}
