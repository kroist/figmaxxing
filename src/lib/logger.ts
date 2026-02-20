import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from './config.js';

const LOGS_DIR = join(getConfigDir(), 'logs');

let sessionFile: string | null = null;
let sessionStart: Date | null = null;

/**
 * Start a new session log file. Call once at the beginning of a session.
 * Returns the log file path.
 */
export function startSession(): string {
  mkdirSync(LOGS_DIR, { recursive: true });
  sessionStart = new Date();
  const ts = sessionStart.toISOString().replace(/[:.]/g, '-');
  sessionFile = join(LOGS_DIR, `${ts}.log`);
  appendFileSync(sessionFile, `Session started: ${sessionStart.toISOString()}\n`);
  return sessionFile;
}

/**
 * Log session metadata (URL, wallet, chain, capture ID).
 */
export function logSessionInfo(info: {
  url: string;
  wallet: string;
  chain: string;
  captureId?: string;
}): void {
  log(`URL: ${info.url}`);
  log(`Wallet: ${info.wallet}`);
  log(`Chain: ${info.chain}`);
  if (info.captureId) {
    log(`Capture ID: ${info.captureId}`);
  }
}

/**
 * Append a line to the current session log.
 * If no session is active, starts one automatically.
 */
export function log(message: string): void {
  if (!sessionFile) startSession();
  const ts = new Date().toISOString();
  appendFileSync(sessionFile!, `[${ts}] ${message}\n`);
}

/**
 * Log an error with optional stack trace.
 */
export function logError(label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  log(`ERROR ${label}: ${msg}`);
  if (err instanceof Error && err.stack) {
    log(err.stack);
  }
}

/**
 * End the session log with a summary.
 */
export function endSession(result?: { figmaUrl?: string }): void {
  if (!sessionFile || !sessionStart) return;
  const end = new Date();
  const durationMs = end.getTime() - sessionStart.getTime();
  const mins = Math.floor(durationMs / 60000);
  const secs = Math.floor((durationMs % 60000) / 1000);

  log(`Session ended: ${end.toISOString()}`);
  log(`Duration: ${mins}m ${secs}s`);
  if (result?.figmaUrl) {
    log(`Figma URL: ${result.figmaUrl}`);
  }
  sessionFile = null;
  sessionStart = null;
}

/**
 * Get the current log file path (for display in the TUI).
 */
export function getLogFile(): string | null {
  return sessionFile;
}
