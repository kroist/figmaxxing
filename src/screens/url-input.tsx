import React, { useState } from 'react';
import { Text, Box } from 'ink';
import TextInput from 'ink-text-input';
import StatusBar from '../components/status-bar.js';

type Props = {
  onComplete: (url: string) => void;
};

export default function UrlInput({ onComplete }: Props) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (value: string) => {
    if (!value.startsWith('http://') && !value.startsWith('https://')) {
      setError('URL must start with http:// or https://');
      return;
    }
    onComplete(value);
  };

  return (
    <Box flexDirection="column">
      <StatusBar step={3} label="Enter DApp URL" />
      <Box>
        <Text>URL: </Text>
        <TextInput value={url} onChange={setUrl} onSubmit={handleSubmit} placeholder="https://app.uniswap.org" />
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}
