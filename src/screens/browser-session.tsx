import React, { useState, useEffect, useRef } from 'react';
import { Text, Box, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { EventEmitter } from 'events';
import type { CaptureConfig } from '../types.js';
import { launchBrowser, type BrowserSession as BSession } from '../lib/browser.js';
import { executeCapture, type CaptureResult } from '../lib/capture.js';
import StatusBar from '../components/status-bar.js';

type Props = {
  config: CaptureConfig;
  onComplete: (result: CaptureResult) => void;
};

type Status = 'launching' | 'open' | 'capturing' | 'done' | 'error';

export default function BrowserSession({ config, onComplete }: Props) {
  const { exit } = useApp();
  const [status, setStatus] = useState<Status>('launching');
  const [error, setError] = useState('');
  const sessionRef = useRef<BSession | null>(null);
  const eventsRef = useRef(new EventEmitter());

  useEffect(() => {
    let cancelled = false;

    launchBrowser(config, eventsRef.current)
      .then((session) => {
        if (cancelled) {
          session.browser.close();
          return;
        }
        sessionRef.current = session;
        setStatus('open');

        // Listen for browser close (user closed the window)
        session.browser.on('disconnected', () => {
          if (!cancelled) {
            setStatus('error');
            setError('Browser was closed.');
            setTimeout(() => exit(), 100);
          }
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setError(err.message);
        setTimeout(() => exit(), 100);
      });

    return () => {
      cancelled = true;
      sessionRef.current?.browser.close().catch(() => {});
    };
  }, []);

  useInput((input, key) => {
    if (status === 'open' && (input === 'c' || input === 'C')) {
      triggerCapture();
    }
    if (input === 'q' || input === 'Q') {
      sessionRef.current?.browser.close().catch(() => {});
      exit();
    }
  });

  async function triggerCapture() {
    const session = sessionRef.current;
    if (!session) return;

    setStatus('capturing');
    try {
      const result = await executeCapture(session.page, session.context, config.captureId);
      setStatus('done');
      await session.browser.close().catch(() => {});
      onComplete(result);
    } catch (err: any) {
      setStatus('error');
      setError(err.message);
      await session.browser.close().catch(() => {});
      onComplete({ success: false, error: err.message });
    }
  }

  return (
    <Box flexDirection="column">
      <StatusBar step={6} label="Browser session" />

      {status === 'launching' && (
        <Text>
          <Spinner type="dots" /> Launching browser...
        </Text>
      )}

      {status === 'open' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">Browser is open at <Text bold>{config.url}</Text></Text>
          <Text>Connect wallet and navigate to the desired state.</Text>
          <Box marginTop={1}>
            <Text dimColor>Press </Text>
            <Text bold color="cyan">[C]</Text>
            <Text dimColor> to capture when ready</Text>
            <Text dimColor>  |  </Text>
            <Text bold color="red">[Q]</Text>
            <Text dimColor> to quit</Text>
          </Box>
        </Box>
      )}

      {status === 'capturing' && (
        <Text>
          <Spinner type="dots" /> Capturing page...
        </Text>
      )}

      {status === 'error' && (
        <Box flexDirection="column">
          <Text color="red" bold>Error</Text>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}
