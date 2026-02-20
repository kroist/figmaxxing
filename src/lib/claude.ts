import { spawn } from 'child_process';
import type { FigmaDestination } from '../types.js';
import { log, logError } from './logger.js';

type Team = { name: string; planKey: string };
type FigmaFile = { name: string; fileKey: string };

export type FigmaOptions = { teams: Team[]; files: FigmaFile[] };

/**
 * Spawn `claude` CLI in --print mode and return the last assistant text content.
 */
export function spawnClaude(prompt: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    log(`Claude spawn: ${prompt.slice(0, 120)}...`);
    // --allowedTools is variadic (<tools...>) and eats all remaining positional args,
    // so we pass the prompt via stdin instead of as a positional argument.
    const args = [
      '--print',
      '--model', 'sonnet',
      '--output-format', 'json',
      '--allowedTools', 'mcp__figma__generate_figma_design',
    ];

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
  const prompt =
    'Call mcp__figma__generate_figma_design with no parameters. Return ONLY a JSON object with the following format, no other text: { "teams": [{"name": "...", "planKey": "..."}], "files": [{"name": "...", "fileKey": "..."}] }';

  const text = await spawnClaude(prompt);

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
  let prompt: string;

  if (destination.mode === 'existingFile') {
    prompt = `Call mcp__figma__generate_figma_design with outputMode 'existingFile' and fileKey '${destination.fileKey}'. Return ONLY the capture ID as a plain string, no other text.`;
  } else {
    prompt = `Call mcp__figma__generate_figma_design with outputMode 'newFile', planKey '${destination.planKey}', and fileName '${destination.fileName}'. Return ONLY the capture ID as a plain string, no other text.`;
  }

  const text = await spawnClaude(prompt);

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
export function warmupMcp(): Promise<boolean> {
  return new Promise((resolve) => {
    log('Warming up MCP via PTY...');
    let resolved = false;
    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      proc.kill('SIGTERM');
      resolve(result);
    };

    const env = { ...process.env };
    delete env.CLAUDECODE;

    // python3 pty.spawn creates a real PTY for Claude so it loads MCP servers
    const proc = spawn('python3', [
      '-c',
      'import pty; pty.spawn(["claude"])',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // Resolve immediately once we see figma tools in the output
      if (stdout.toLowerCase().includes('figma')) {
        log(`MCP warmup: figma detected in output (${stdout.length} bytes)`);
        done(true);
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      log(`MCP warmup stderr: ${chunk.toString().trim()}`);
    });

    const timer = setTimeout(() => {
      log(`MCP warmup timed out, stdout: ${stdout.length} bytes`);
      done(false);
    }, 30_000);

    // Send the probe after a short startup delay
    setTimeout(() => {
      if (resolved) return;
      log('MCP warmup: sending probe...');
      proc.stdin.write('list mcp tools\n');
    }, 3_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      log(`MCP warmup exited with code ${code}`);
      done(stdout.toLowerCase().includes('figma'));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logError('MCP warmup', err);
      done(false);
    });
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
