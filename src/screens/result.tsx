import React from 'react';
import { Text, Box, useInput, useApp } from 'ink';
import type { CaptureResult } from '../lib/capture.js';
import StatusBar from '../components/status-bar.js';

type Props = {
  result: CaptureResult;
};

export default function ResultScreen({ result }: Props) {
  const { exit } = useApp();

  useInput(() => {
    exit();
  });

  return (
    <Box flexDirection="column">
      <StatusBar step={7} label="Result" />

      {result.success ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green" bold>Capture submitted successfully!</Text>
          <Text>Check your Figma file for the captured design.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>Capture failed</Text>
          <Text color="red">{result.error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Press any key to exit.</Text>
      </Box>
    </Box>
  );
}
