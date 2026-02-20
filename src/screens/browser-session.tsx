import React, { useState, useEffect, useRef } from 'react';
import { Text, Box, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { EventEmitter } from 'events';
import type { CaptureConfig } from '../types.js';
import { launchBrowser, type BrowserSession as BSession } from '../lib/browser.js';
import { injectCaptureToolbar, type CaptureResult } from '../lib/capture.js';
import StatusBar from '../components/status-bar.js';

type Props = {
  config: CaptureConfig;
  onComplete: (result: CaptureResult) => void;
};

type Status = 'launching' | 'open' | 'injecting';

export default function BrowserSession({ config, onComplete }: Props) {
  const { exit } = useApp();
  const [status, setStatus] = useState<Status>('launching');
  const [launchError, setLaunchError] = useState('');
  const [toolbarReady, setToolbarReady] = useState(false);
  const [captureCount, setCaptureCount] = useState(0);
  const sessionRef = useRef<BSession | null>(null);
  const eventsRef = useRef(new EventEmitter());
  const completedRef = useRef(false);

  function finish() {
    if (completedRef.current) return;
    completedRef.current = true;
    sessionRef.current?.browser.close().catch(() => {});
    onComplete({ success: captureCount > 0 });
  }

  useEffect(() => {
    let cancelled = false;

    // Track submissions from the Figma toolbar
    eventsRef.current.on('capture:submitted', () => {
      setCaptureCount((c) => c + 1);
    });

    launchBrowser(config, eventsRef.current)
      .then((session) => {
        if (cancelled) {
          session.browser.close();
          return;
        }
        sessionRef.current = session;
        setStatus('open');

        session.browser.on('disconnected', () => {
          if (!cancelled) finish();
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setLaunchError(err.message);
        setTimeout(() => exit(), 100);
      });

    return () => {
      cancelled = true;
      sessionRef.current?.browser.close().catch(() => {});
    };
  }, []);

  useInput((input) => {
    if (status === 'open' && !toolbarReady && (input === 'c' || input === 'C')) {
      injectToolbar();
    }
    if (input === 'q' || input === 'Q') {
      finish();
    }
  });

  async function injectToolbar() {
    const session = sessionRef.current;
    if (!session) return;

    setStatus('injecting');
    const result = await injectCaptureToolbar(session.page, session.context, config.captureId);
    setStatus('open');

    if (result.success) {
      setToolbarReady(true);
    } else {
      setLaunchError(result.error || 'Failed to inject capture toolbar');
    }
  }

  if (launchError) {
    return (
      <Box flexDirection="column">
        <StatusBar step={6} label="Browser session" />
        <Text color="red" bold>Error</Text>
        <Text color="red">{launchError}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <StatusBar step={6} label="Browser session" />

      {status === 'launching' && (
        <Text>
          <Spinner type="dots" /> Launching browser...
        </Text>
      )}

      {status === 'injecting' && (
        <Text>
          <Spinner type="dots" /> Injecting Figma capture toolbar...
        </Text>
      )}

      {status === 'open' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">Browser is open at <Text bold>{config.url}</Text></Text>

          {captureCount > 0 && (
            <Text color="green">{captureCount} capture{captureCount > 1 ? 's' : ''} submitted.</Text>
          )}

          <Box marginTop={1} flexDirection="column">
            {!toolbarReady ? (
              <Box flexDirection="column">
                <Text>Connect wallet and navigate to the desired state.</Text>
                <Box marginTop={1}>
                  <Text bold color="cyan">[C]</Text>
                  <Text dimColor> inject Figma capture toolbar  </Text>
                  <Text bold color="red">[Q]</Text>
                  <Text dimColor> quit</Text>
                </Box>
              </Box>
            ) : (
              <Box flexDirection="column">
                <Text>Use the Figma toolbar in the browser to capture pages.</Text>
                <Box marginTop={1}>
                  <Text bold color="red">[Q]</Text>
                  <Text dimColor> quit (or close browser)</Text>
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
