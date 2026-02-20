import React, { useState } from 'react';
import { Text, Box } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import type { Chain } from '../types.js';
import { CHAINS } from '../lib/chains.js';
import StatusBar from '../components/status-bar.js';

type Props = {
  onComplete: (chain: Chain) => void;
};

type SubScreen = 'list' | 'customId' | 'customRpc';

export default function ChainPicker({ onComplete }: Props) {
  const [subScreen, setSubScreen] = useState<SubScreen>('list');
  const [customId, setCustomId] = useState('');
  const [customRpc, setCustomRpc] = useState('');
  const [error, setError] = useState('');

  const items = [
    ...CHAINS.map(c => ({ label: `${c.name} (${c.id})`, value: String(c.id) })),
    { label: 'Custom...', value: '__custom__' },
  ];

  const handleSelect = (item: { value: string }) => {
    if (item.value === '__custom__') {
      setSubScreen('customId');
    } else {
      const chain = CHAINS.find(c => String(c.id) === item.value);
      if (chain) onComplete(chain);
    }
  };

  const handleCustomIdSubmit = (value: string) => {
    const id = parseInt(value, 10);
    if (isNaN(id) || id <= 0) {
      setError('Chain ID must be a positive number');
      return;
    }
    setError('');
    setSubScreen('customRpc');
  };

  const handleCustomRpcSubmit = (value: string) => {
    if (!value.startsWith('http://') && !value.startsWith('https://')) {
      setError('RPC URL must start with http:// or https://');
      return;
    }
    const id = parseInt(customId, 10);
    onComplete({
      id,
      name: `Custom (${id})`,
      hexId: '0x' + id.toString(16),
      rpc: value,
    });
  };

  if (subScreen === 'customId') {
    return (
      <Box flexDirection="column">
        <StatusBar step={2} label="Select chain" />
        <Text bold>Custom chain</Text>
        <Box marginTop={1}>
          <Text>Chain ID: </Text>
          <TextInput value={customId} onChange={setCustomId} onSubmit={handleCustomIdSubmit} />
        </Box>
        {error && <Text color="red">{error}</Text>}
      </Box>
    );
  }

  if (subScreen === 'customRpc') {
    return (
      <Box flexDirection="column">
        <StatusBar step={2} label="Select chain" />
        <Text bold>Custom chain (ID: {customId})</Text>
        <Box marginTop={1}>
          <Text>RPC URL: </Text>
          <TextInput value={customRpc} onChange={setCustomRpc} onSubmit={handleCustomRpcSubmit} />
        </Box>
        {error && <Text color="red">{error}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <StatusBar step={2} label="Select chain" />
      <SelectInput items={items} onSelect={handleSelect} />
    </Box>
  );
}
