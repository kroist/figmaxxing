import React, { useState, useEffect } from 'react';
import { Text, Box, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { FigmaDestination } from '../types.js';
import { generateCaptureId } from '../lib/claude.js';
import StatusBar from '../components/status-bar.js';

type Props = {
  destination: FigmaDestination;
  onComplete: (captureId: string) => void;
};

export default function CaptureIdScreen({ destination, onComplete }: Props) {
  const { exit } = useApp();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [captureId, setCaptureId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    generateCaptureId(destination)
      .then((id) => {
        if (cancelled) return;
        setCaptureId(id);
        setStatus('success');
        // Auto-advance after a brief pause so user can see the ID
        setTimeout(() => {
          if (!cancelled) onComplete(id);
        }, 1500);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setStatus('error');
        // Exit after showing error
        setTimeout(() => exit(), 100);
      });

    return () => { cancelled = true; };
  }, []);

  return (
    <Box flexDirection="column">
      <StatusBar step={5} label="Generate capture ID" />

      {status === 'loading' && (
        <Text>
          <Spinner type="dots" /> Generating capture ID via Claude Code...
        </Text>
      )}

      {status === 'success' && (
        <Box flexDirection="column">
          <Text color="green">Capture ID: <Text bold>{captureId}</Text></Text>
          <Text dimColor>Launching browser...</Text>
        </Box>
      )}

      {status === 'error' && (
        <Box flexDirection="column">
          <Text color="red" bold>Failed to generate capture ID</Text>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}
