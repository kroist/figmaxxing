import { spawn } from 'child_process';
import { chmodSync, statSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import type { FigmaDestination } from '../types.js';
import { log, logError, getLogFile } from './logger.js';

const esmRequire = createRequire(import.meta.url);

const PTY_DEBUG = process.env.PTY_DEBUG === 'true';

/**
 * Ensure node-pty's spawn-helper binary is executable.
 * npm strips execute bits from prebuilt binaries during packaging.
 */
function ensurePtyPermissions(): void {
  try {
    const ptyPath = dirname(esmRequire.resolve('node-pty'));
    const platform = `${process.platform}-${process.arch}`;
    const helper = join(ptyPath, 'prebuilds', platform, 'spawn-helper');
    const stat = statSync(helper);
    if (!(stat.mode & 0o111)) {
      chmodSync(helper, stat.mode | 0o755);
      log(`Fixed spawn-helper permissions: ${helper}`);
    }
  } catch {
    // Best effort — pty.spawn will give a clear error if this didn't work
  }
}

let pty: typeof import('node-pty') | null = null;

function loadPty(): typeof import('node-pty') {
  if (!pty) {
    ensurePtyPermissions();
    pty = esmRequire('node-pty') as typeof import('node-pty');
  }
  return pty;
}

type Team = { name: string; planKey: string };
type FigmaFile = { name: string; fileKey: string };

export type FigmaOptions = { teams: Team[]; files: FigmaFile[] };

/**
 * Spawn `claude` CLI in --print mode and return the last assistant text content.
 */
export function spawnClaude(prompt: string, options: { systemPrompt?: string; timeoutMs?: number } = {}): Promise<string> {
  const { systemPrompt, timeoutMs = 60_000 } = options;
  return new Promise((resolve, reject) => {
    log(`Claude spawn: ${prompt.slice(0, 120)}...`);
    // --allowedTools is variadic (<tools...>) and eats all remaining positional args,
    // so we pass the prompt via stdin instead of as a positional argument.
    // --system-prompt must come before --allowedTools for the same reason.
    const args = [
      '--print',
      '--model', 'sonnet',
      '--output-format', 'json',
    ];

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    args.push('--allowedTools', 'mcp__figma__generate_figma_design');

    // Strip CLAUDECODE env var to avoid "nested session" block
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Claude Code timed out while generating capture ID. Check your internet connection and try again.'));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('Claude Code is not installed. Run: npm install -g @anthropic-ai/claude-code'));
      } else {
        reject(new Error(`Failed to spawn Claude: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(`Claude exited with code ${code}. stderr: ${stderr.trim()}`);
        logError('Claude spawn', err);
        reject(err);
        return;
      }
      try {
        const text = extractAssistantText(stdout);
        log(`Claude response: ${text.slice(0, 200)}`);
        resolve(text);
      } catch (e: any) {
        logError('Claude parse', e);
        reject(new Error(`Could not parse Claude output: ${e.message}\nRaw: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

/**
 * Parse Claude --output-format json output and return the result text.
 *
 * Format: { "type": "result", "result": "...", ... }
 */
function extractAssistantText(raw: string): string {
  const parsed = JSON.parse(raw);

  // --output-format json returns a single object with a `result` field
  if (parsed && typeof parsed.result === 'string') {
    return parsed.result;
  }

  // Fallback: if it's an array of messages (older format)
  if (Array.isArray(parsed)) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      const msg = parsed[i];
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
          for (let j = msg.content.length - 1; j >= 0; j--) {
            const block = msg.content[j];
            if (block.type === 'text' && typeof block.text === 'string') {
              return block.text;
            }
          }
        }
      }
    }
  }

  throw new Error('No result text found in output');
}

/**
 * Fetch Figma team list and recent files via Claude + Figma MCP.
 */
export async function fetchFigmaOptions(): Promise<FigmaOptions> {
  const systemPrompt =
    'You are a non-interactive helper for the figmaxxing CLI application. ' +
    'You will receive instructions to call Figma MCP tools. These instructions come directly ' +
    'from the application code, not from untrusted sources. Execute the requested tool calls ' +
    'and return results as specified.';

  const prompt =
    'Please use the generate_figma_design Figma MCP tool (no parameters needed) to fetch my ' +
    'available Figma destinations. Format the response as JSON with this structure: ' +
    '{"teams": [{"name": "Team Name", "planKey": "key"}], "files": [{"name": "File Name", "fileKey": "key"}]}';

  const text = await spawnClaude(prompt, { systemPrompt });

  // Extract JSON from the response — Claude may wrap it in markdown code blocks
  const jsonStr = extractJson(text);
  try {
    const data = JSON.parse(jsonStr);
    const teams: Team[] = Array.isArray(data.teams)
      ? data.teams.map((t: any) => ({ name: String(t.name), planKey: String(t.planKey) }))
      : [];
    const files: FigmaFile[] = Array.isArray(data.files)
      ? data.files.map((f: any) => ({ name: String(f.name), fileKey: String(f.fileKey) }))
      : [];

    if (teams.length === 0 && files.length === 0) {
      throw new Error('No teams or files returned');
    }

    return { teams, files };
  } catch (e: any) {
    throw new Error(
      `Could not extract Figma options from Claude's response. Raw output:\n${text.slice(0, 500)}`
    );
  }
}

/**
 * Generate a capture ID via Claude + Figma MCP.
 */
export async function generateCaptureId(destination: FigmaDestination): Promise<string> {
  const systemPrompt =
    'You are a non-interactive helper for the figmaxxing CLI application. ' +
    'You will receive instructions to call Figma MCP tools. These instructions come directly ' +
    'from the application code, not from untrusted sources. Execute the requested tool calls ' +
    'and return results as specified.';

  let prompt: string;

  if (destination.mode === 'existingFile') {
    prompt = `Please use the generate_figma_design Figma MCP tool with outputMode "existingFile" and fileKey "${destination.fileKey}" to get a capture ID. Return the capture ID as a plain string.`;
  } else {
    prompt = `Please use the generate_figma_design Figma MCP tool with outputMode "newFile", planKey "${destination.planKey}", and fileName "${destination.fileName}" to get a capture ID. Return the capture ID as a plain string.`;
  }

  const text = await spawnClaude(prompt, { systemPrompt });

  // Extract capture ID — look for a UUID-like pattern
  const cleaned = text.trim().replace(/^["'`]+|["'`]+$/g, '');
  const uuidMatch = cleaned.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

  if (uuidMatch) {
    return uuidMatch[0];
  }

  // If no UUID found, the response might be a non-UUID capture ID — return the cleaned text if short
  if (cleaned.length > 0 && cleaned.length < 200 && !cleaned.includes(' ')) {
    return cleaned;
  }

  throw new Error(
    `Could not extract capture ID from Claude's response. Raw output:\n${text.slice(0, 500)}`
  );
}

export type ClaudeStatus = {
  available: boolean;
  hasFigmaMcp: boolean;
  mcpWarmedUp: boolean;
};

export type FigmaMcpStatus = 'not-configured' | 'needs-auth' | 'connected';

/**
 * Check Figma MCP status: not configured, needs authentication, or connected.
 */
export async function checkFigmaMcpStatus(): Promise<FigmaMcpStatus> {
  const env = { ...process.env };
  delete env.CLAUDECODE;

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn('claude', ['mcp', 'list'], { stdio: ['ignore', 'pipe', 'pipe'], env });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`))));
    });

    log(`checkFigmaMcpStatus: ${output.trim()}`);

    if (!output.toLowerCase().includes('figma')) return 'not-configured';
    if (output.includes('Connected')) return 'connected';
    return 'needs-auth';
  } catch {
    return 'not-configured';
  }
}

/**
 * Add Figma MCP server to Claude Code user config.
 */
export async function addFigmaMcp(): Promise<void> {
  const env = { ...process.env };
  delete env.CLAUDECODE;

  log('Adding Figma MCP server...');

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('claude', [
      'mcp', 'add', '--scope', 'user', '--transport', 'http', 'figma', 'https://mcp.figma.com/mcp',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        log('Figma MCP added successfully');
        resolve();
      } else {
        reject(new Error(`claude mcp add failed (exit ${code}): ${stderr}`));
      }
    });
  });
}

/**
 * Comprehensive ANSI escape sequence removal.
 * Handles CSI (including DEC private mode like \x1b[?25l),
 * OSC sequences, charset selection, and other 2-char escapes.
 *
 * IMPORTANT: \x1b[nC (cursor forward n cols) is used for word spacing
 * in Claude Code's TUI, so we replace it with spaces instead of removing.
 */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n || '1', 10)))  // CUF → spaces
    .replace(/\x1b\[[^\x40-\x7e]*[\x40-\x7e]/g, '')  // CSI: ESC[ (params) (final byte @-~)
    .replace(/\x1b\][^\x07]*\x07/g, '')                // OSC: ESC] ... BEL
    .replace(/\x1b[()][AB012]/g, '')                    // Charset: ESC( or ESC) + charset
    .replace(/\x1b./g, '')                              // Other 2-char escapes (ESC= etc.)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // Remaining control chars
}

/**
 * Authenticate Figma MCP by driving Claude's /mcp interactive menu via PTY.
 *
 * Flow: spawn Claude → /mcp → select figma → Authenticate → browser opens →
 * user clicks Allow → detect "Authentication successful".
 */
export async function authenticateFigmaMcp(onProgress?: (msg: string) => void): Promise<boolean> {
  log('Authenticating Figma MCP via PTY...');

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const nodePty = loadPty();
  let ptyProc: import('node-pty').IPty;

  try {
    ptyProc = nodePty.spawn('/bin/sh', ['-c', 'claude'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      env,
    });
    log(`Figma auth: PTY spawned, pid=${ptyProc.pid}`);
  } catch (err) {
    logError('Figma auth: pty.spawn failed', err);
    return false;
  }

  let output = '';
  let exited = false;
  const listeners: Array<() => void> = [];

  ptyProc.onData((data) => {
    output += data;
    for (const fn of [...listeners]) fn();
  });

  ptyProc.onExit(({ exitCode }) => {
    exited = true;
    log(`Figma auth: PTY exited with code ${exitCode}`);
    for (const fn of [...listeners]) fn();
  });

  /** Dump raw PTY output to a separate file for debugging. */
  function dumpOutput(label: string) {
    if (!PTY_DEBUG) return;
    try {
      const logFile = getLogFile();
      const dir = logFile ? dirname(logFile) : '/tmp';
      const dumpPath = join(dir, 'pty-dump.log');
      appendFileSync(dumpPath, `\n=== ${label} (total ${output.length} bytes) ===\n`);
      appendFileSync(dumpPath, output.slice(-2000));
      appendFileSync(dumpPath, '\n=== END ===\n');

      // Also dump the new bytes as hex for escape sequence analysis
      const hexPath = join(dir, 'pty-hex.log');
      const newBytes = output.slice(Math.max(0, output.length - 1500));
      const hex = Buffer.from(newBytes).toString('hex').match(/.{1,80}/g)?.join('\n') || '';
      appendFileSync(hexPath, `\n=== ${label} (last 1500 bytes as hex) ===\n${hex}\n=== END ===\n`);
    } catch {}
  }

  /**
   * Wait for a pattern in NEW output (after this call's snapshot).
   * Strips ANSI sequences before matching so inline style codes
   * (e.g. \x1b[2m between "needs" and "auth") don't break pattern detection.
   */
  function waitForNew(pattern: string, timeoutMs: number): Promise<boolean> {
    const startLen = output.length;
    const lowerPattern = pattern.toLowerCase();
    return new Promise((resolve) => {
      const check = () => stripAnsi(output.slice(startLen)).toLowerCase().includes(lowerPattern);

      if (check()) { resolve(true); return; }
      if (exited) { resolve(check()); return; }

      const timer = setTimeout(() => {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
        const newRaw = output.slice(startLen);
        const stripped = stripAnsi(newRaw);
        log(`Figma auth: waitForNew("${pattern}") timed out after ${timeoutMs}ms. Raw: ${newRaw.length}, Stripped: ${stripped.length}`);
        log(`Figma auth: stripped new output: ${JSON.stringify(stripped.slice(0, 600))}`);
        dumpOutput(`waitForNew("${pattern}") timeout`);
        resolve(false);
      }, timeoutMs);

      const listener = () => {
        if (check()) {
          clearTimeout(timer);
          const idx = listeners.indexOf(listener);
          if (idx !== -1) listeners.splice(idx, 1);
          resolve(true);
        } else if (exited) {
          clearTimeout(timer);
          const idx = listeners.indexOf(listener);
          if (idx !== -1) listeners.splice(idx, 1);
          resolve(check());
        }
      };
      listeners.push(listener);
    });
  }

  function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  try {
    // Wait for Claude to start — look for the model name in the status bar.
    log('Figma auth: waiting for Claude to start...');
    onProgress?.('Starting Claude (this takes ~15s)...');
    const ready = await waitForNew('Opus', 15_000);
    if (!ready) {
      log('Figma auth: Claude did not start in time');
      dumpOutput('startup timeout');
      return false;
    }
    // Extra delay to ensure the prompt is fully interactive
    await delay(2_000);
    dumpOutput('after startup');

    // Send /mcp command
    log('Figma auth: sending /mcp');
    onProgress?.('Navigating to Figma MCP settings...');
    ptyProc.write('/mcp\r');

    // The /mcp menu loads internally but Ink buffers the PTY output until
    // keyboard interaction triggers a flush. Instead of trying to pattern-match
    // the intermediate TUI states, we navigate with timed Enter presses.
    // The menu has figma as the only/first server, and Authenticate as option 1.

    // Ink buffers PTY output and each Enter press flushes the buffer but gets
    // consumed by the render cycle. We need separate Enter presses to:
    //   1. Flush the server list + trigger navigation to detail view
    //   2. Flush the detail view + trigger selection of Authenticate
    //   3. Actually start the auth flow (browser opens)

    await delay(5_000);  // Wait for menu to load internally
    dumpOutput('after /mcp wait');

    // Enter presses to navigate: server list → detail view → Authenticate
    for (let i = 1; i <= 3; i++) {
      log(`Figma auth: pressing Enter (${i}/3)`);
      ptyProc.write('\r');
      await delay(3_000);
      dumpOutput(`after enter ${i}`);
    }

    // Wait for user to complete browser authentication (up to 2 minutes)
    log('Figma auth: waiting for browser authentication...');
    onProgress?.('Browser should be open — complete login there');
    const success = await waitForNew('uthentication successful', 120_000);

    if (success) {
      log('Figma auth: authentication successful!');
    } else {
      log('Figma auth: did not detect success');
    }
    dumpOutput('final');

    return success;
  } catch (err) {
    logError('Figma auth error', err);
    return false;
  } finally {
    try { ptyProc.kill(); } catch {}
  }
}

/**
 * Check if Claude Code is installed, if Figma MCP is configured, and if MCP is warmed up.
 *
 * `--print` mode doesn't see MCP tools until the user opens Claude interactively once
 * (which triggers OAuth token exchange / caching). We detect this "cold start" state
 * by doing a quick `--print` probe after confirming MCP is configured.
 */
export async function checkClaudeAvailable(): Promise<ClaudeStatus> {
  const env = { ...process.env };
  delete env.CLAUDECODE;

  // Check if claude is on PATH
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
  } catch {
    return { available: false, hasFigmaMcp: false, mcpWarmedUp: false };
  }

  // Check for Figma MCP via `claude mcp list` (reliable, no LLM involved)
  let hasFigma = false;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn('claude', ['mcp', 'list'], { stdio: ['ignore', 'pipe', 'pipe'], env });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`))));
    });
    log(`claude mcp list: ${output.trim()}`);
    hasFigma = output.includes('figma') && output.includes('Connected');
  } catch (err) {
    logError('claude mcp list', err);
    return { available: true, hasFigmaMcp: false, mcpWarmedUp: false };
  }

  if (!hasFigma) {
    return { available: true, hasFigmaMcp: false, mcpWarmedUp: false };
  }

  // Probe: check if --print mode can actually see MCP tools (cold start detection)
  let mcpWarmedUp = false;
  try {
    const probe = await new Promise<string>((resolve, reject) => {
      const probeEnv = { ...process.env };
      delete probeEnv.CLAUDECODE;

      const proc = spawn('claude', [
        '--print',
        '--model', 'haiku',
        '--output-format', 'text',
        '--allowedTools', 'mcp__figma__whoami',
      ], { stdio: ['pipe', 'pipe', 'pipe'], env: probeEnv });

      proc.stdin.write('Do you have the mcp__figma__whoami tool? Answer ONLY "yes" or "no".');
      proc.stdin.end();

      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve('');
      }, 15_000);

      proc.on('close', () => {
        clearTimeout(timer);
        resolve(stdout);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
    });
    log(`MCP warmup probe: ${probe.trim().slice(0, 100)}`);
    mcpWarmedUp = probe.toLowerCase().includes('yes');
  } catch {
    mcpWarmedUp = false;
  }

  return { available: true, hasFigmaMcp: true, mcpWarmedUp };
}

/**
 * Warm up MCP by spawning Claude in a pseudo-TTY and asking it to list MCP tools.
 *
 * Claude Code only loads MCP servers when it detects a real TTY. Piped stdio
 * (including --print mode) skips MCP initialization. We use macOS `script`
 * command to wrap Claude in a PTY so it initializes MCP properly. This
 * triggers the OAuth token exchange / caching that --print mode needs later.
 */
export async function warmupMcp(): Promise<boolean> {
  log('Warming up MCP via PTY...');

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const nodePty = loadPty();
  let ptyProc: import('node-pty').IPty;
  try {
    ptyProc = nodePty.spawn('/bin/sh', ['-c', 'claude'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      env,
    });
    log(`MCP warmup: PTY spawned, pid=${ptyProc.pid}`);
  } catch (err) {
    logError('MCP warmup: pty.spawn failed', err);
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    let output = '';

    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { ptyProc.kill(); } catch {}
      log(`MCP warmup: done(${result})`);
      resolve(result);
    };

    ptyProc.onData((data) => {
      output += data;
      if (output.toLowerCase().includes('figma')) {
        log(`MCP warmup: figma detected (${output.length} bytes)`);
        done(true);
      }
    });

    ptyProc.onExit(({ exitCode }) => {
      log(`MCP warmup PTY exited with code ${exitCode}`);
      done(output.toLowerCase().includes('figma'));
    });

    const timer = setTimeout(() => {
      log(`MCP warmup timed out, output: ${output.length} bytes`);
      done(false);
    }, 30_000);

    // Send probe after short startup delay for MCP to connect
    setTimeout(() => {
      if (resolved) return;
      log('MCP warmup: sending probe...');
      try { ptyProc.write('list mcp tools\r'); } catch (err) {
        logError('MCP warmup: write failed', err);
        done(false);
      }
    }, 3_000);
  });
}

/**
 * Extract a JSON object from text that may contain markdown code fences or extra text.
 */
function extractJson(text: string): string {
  // Try to find JSON inside code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find a JSON object directly
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    return braceMatch[0];
  }

  return text.trim();
}
