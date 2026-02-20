import React, { useState, useEffect } from 'react';
import { Text, Box, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { checkClaudeAvailable } from '../lib/claude.js';
import { loadWallets, createWallet } from '../lib/wallet.js';
import { markSetupComplete } from '../lib/config.js';

type Props = {
  onComplete: () => void;
};

type CheckStatus = 'pending' | 'checking' | 'ok' | 'warn' | 'fail';

type CheckItem = {
  label: string;
  status: CheckStatus;
  detail: string;
};

type Phase =
  | 'running'
  | 'prompt-chromium'
  | 'installing-chromium'
  | 'prompt-wallet'
  | 'wallet-created'
  | 'fatal'
  | 'done';

const SECURITY_WARNING = [
  'Wallets are stored UNENCRYPTED in ~/.figmaxxing/wallets.json',
  'Do NOT store wallets with significant funds. This tool is for UI capture only.',
];

const INITIAL_CHECKS: CheckItem[] = [
  { label: 'Node.js version', status: 'pending', detail: '' },
  { label: 'Playwright Chromium', status: 'pending', detail: '' },
  { label: 'Claude Code', status: 'pending', detail: '' },
  { label: 'Figma MCP', status: 'pending', detail: '' },
  { label: 'Wallet', status: 'pending', detail: '' },
];

function statusIcon(status: CheckStatus): React.ReactElement {
  switch (status) {
    case 'pending':
      return <Text dimColor>-</Text>;
    case 'checking':
      return <Text color="cyan"><Spinner type="dots" /></Text>;
    case 'ok':
      return <Text color="green">✓</Text>;
    case 'warn':
      return <Text color="yellow">!</Text>;
    case 'fail':
      return <Text color="red">✗</Text>;
  }
}

export default function SetupWizard({ onComplete }: Props) {
  const { exit } = useApp();
  const [checks, setChecks] = useState<CheckItem[]>(INITIAL_CHECKS);
  const [phase, setPhase] = useState<Phase>('running');
  const [currentStep, setCurrentStep] = useState(0);
  const [fatalMessage, setFatalMessage] = useState('');
  const [createdWallet, setCreatedWallet] = useState<{ address: string; privateKey: string } | null>(null);

  function updateCheck(index: number, update: Partial<CheckItem>) {
    setChecks(prev => prev.map((c, i) => (i === index ? { ...c, ...update } : c)));
  }

  function fatal(step: number, detail: string, message: string) {
    updateCheck(step, { status: 'fail', detail });
    setFatalMessage(message);
    setPhase('fatal');
  }

  function finish() {
    markSetupComplete();
    setPhase('done');
    setTimeout(() => onComplete(), 800);
  }

  // Run checks from a given step onwards, stopping at prompts or fatals
  async function runFrom(step: number) {
    // Step 0: Node.js version
    if (step <= 0) {
      setCurrentStep(0);
      updateCheck(0, { status: 'checking' });
      const major = parseInt(process.version.slice(1), 10);
      if (major >= 18) {
        updateCheck(0, { status: 'ok', detail: process.version });
      } else {
        fatal(0, `${process.version} — requires >= 18`, `Node.js ${process.version} is too old. Please install Node.js 18 or later.`);
        return;
      }
    }

    // Step 1: Playwright Chromium
    if (step <= 1) {
      setCurrentStep(1);
      updateCheck(1, { status: 'checking' });
      try {
        const pw = await import('playwright');
        const execPath = pw.chromium.executablePath();
        if (existsSync(execPath)) {
          updateCheck(1, { status: 'ok', detail: 'Chromium found' });
        } else {
          updateCheck(1, { status: 'warn', detail: 'Chromium not installed' });
          setPhase('prompt-chromium');
          return;
        }
      } catch {
        updateCheck(1, { status: 'warn', detail: 'Chromium not installed' });
        setPhase('prompt-chromium');
        return;
      }
    }

    // Step 2: Claude Code
    if (step <= 2) {
      setCurrentStep(2);
      updateCheck(2, { status: 'checking' });
      try {
        const version = await new Promise<string>((resolve, reject) => {
          const proc = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
          proc.on('error', reject);
          proc.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`exit ${code}`))));
        });
        updateCheck(2, { status: 'ok', detail: version || 'installed' });
      } catch {
        fatal(2, 'Not found', 'Claude Code is not installed.\nRun: npm install -g @anthropic-ai/claude-code');
        return;
      }
    }

    // Step 3: Figma MCP
    if (step <= 3) {
      setCurrentStep(3);
      updateCheck(3, { status: 'checking' });
      try {
        const result = await checkClaudeAvailable();
        if (result.hasFigmaMcp) {
          updateCheck(3, { status: 'ok', detail: 'Connected' });
        } else {
          fatal(3, 'Figma MCP not configured',
            'Figma MCP is not configured in Claude Code.\n\n' +
            'Run: claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp\n' +
            'Then: open Claude, type /mcp, select figma, Authenticate, Allow Access');
          return;
        }
      } catch {
        fatal(3, 'Check failed',
          'Could not verify Figma MCP.\n\n' +
          'Run: claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp\n' +
          'Then: open Claude, type /mcp, select figma, Authenticate, Allow Access');
        return;
      }
    }

    // Step 4: Wallet
    if (step <= 4) {
      setCurrentStep(4);
      updateCheck(4, { status: 'checking' });
      const wallets = loadWallets();
      if (wallets.length > 0) {
        updateCheck(4, { status: 'ok', detail: `${wallets.length} wallet(s) found` });
        finish();
      } else {
        updateCheck(4, { status: 'warn', detail: 'No wallets' });
        setPhase('prompt-wallet');
      }
    }
  }

  // Initial run
  useEffect(() => {
    runFrom(0);
  }, []);

  // Handle Chromium installation when phase changes
  useEffect(() => {
    if (phase !== 'installing-chromium') return;

    const proc = spawn('npx', ['playwright', 'install', 'chromium'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        updateCheck(1, { status: 'ok', detail: 'Chromium installed' });
        setPhase('running');
        runFrom(2);
      } else {
        fatal(1, 'Installation failed', `Failed to install Playwright Chromium.\n${stderr.slice(0, 300)}`);
      }
    });

    proc.on('error', (err) => {
      fatal(1, 'Installation failed', `Failed to install Playwright Chromium: ${err.message}`);
    });
  }, [phase]);

  // Handle user input for prompts
  useInput((input, key) => {
    if (phase === 'prompt-chromium') {
      if (input.toLowerCase() === 'y') {
        updateCheck(1, { status: 'checking', detail: 'Installing...' });
        setPhase('installing-chromium');
      } else if (input.toLowerCase() === 'n') {
        fatal(1, 'Skipped by user', 'Playwright Chromium is required for browser capture.');
      }
    } else if (phase === 'prompt-wallet') {
      if (input.toLowerCase() === 'y') {
        const w = createWallet('Capture Wallet');
        setCreatedWallet({ address: w.address, privateKey: w.privateKey });
        updateCheck(4, { status: 'ok', detail: w.address.slice(0, 10) + '...' });
        setPhase('wallet-created');
      } else if (input.toLowerCase() === 's') {
        updateCheck(4, { status: 'warn', detail: 'Skipped' });
        finish();
      }
    } else if (phase === 'wallet-created') {
      if (key.return) {
        finish();
      }
    } else if (phase === 'fatal') {
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">figmaxxing Setup</Text>
      </Box>

      {checks.map((check, i) => (
        <Box key={i}>
          <Text>  </Text>
          {statusIcon(check.status)}
          <Text> </Text>
          <Text dimColor={check.status === 'pending'}>{check.label}</Text>
          {check.detail && <Text dimColor> — {check.detail}</Text>}
        </Box>
      ))}

      {phase === 'prompt-chromium' && (
        <Box marginTop={1} flexDirection="column">
          <Text>Playwright Chromium is not installed.</Text>
          <Text bold>Install now? <Text color="green">[Y]</Text> Install / <Text color="red">[N]</Text> No</Text>
        </Box>
      )}

      {phase === 'installing-chromium' && (
        <Box marginTop={1}>
          <Text><Spinner type="dots" /> Installing Playwright Chromium...</Text>
        </Box>
      )}

      {phase === 'prompt-wallet' && (
        <Box marginTop={1} flexDirection="column">
          <Text>No wallets found.</Text>
          <Text bold>Create a wallet? <Text color="green">[Y]</Text> Create / <Text color="yellow">[S]</Text> Skip</Text>
        </Box>
      )}

      {phase === 'wallet-created' && createdWallet && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="green">Wallet created</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>Address: <Text bold>{createdWallet.address}</Text></Text>
            <Text>Key:     <Text dimColor>{createdWallet.privateKey}</Text></Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {SECURITY_WARNING.map((line, i) => (
              <Text key={i} color="yellow">! {line}</Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to continue...</Text>
          </Box>
        </Box>
      )}

      {phase === 'fatal' && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red" bold>Setup cannot continue:</Text>
          {fatalMessage.split('\n').map((line, i) => (
            <Text key={i} color="red">{line}</Text>
          ))}
          <Box marginTop={1}>
            <Text dimColor>Press any key to exit.</Text>
          </Box>
        </Box>
      )}

      {phase === 'done' && (
        <Box marginTop={1}>
          <Text color="green" bold>Setup complete!</Text>
        </Box>
      )}
    </Box>
  );
}
