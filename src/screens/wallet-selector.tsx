import React, { useState } from 'react';
import { Text, Box, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import type { Wallet } from '../types.js';
import { loadWallets, createWallet, importWallet, createEphemeralWallet } from '../lib/wallet.js';
import StatusBar from '../components/status-bar.js';

type Props = {
  onComplete: (wallet: Wallet) => void;
};

type SubScreen = 'list' | 'import' | 'created';

const SECURITY_WARNING = [
  'Wallets are stored UNENCRYPTED in ~/.figmaxxing/wallets.json',
  'Do NOT store wallets with significant funds. This tool is for UI capture only.',
];

export default function WalletSelector({ onComplete }: Props) {
  const [subScreen, setSubScreen] = useState<SubScreen>('list');
  const [importKey, setImportKey] = useState('');
  const [importError, setImportError] = useState('');
  const [createdWallet, setCreatedWallet] = useState<Wallet | null>(null);
  const [isEphemeral, setIsEphemeral] = useState(false);

  const wallets = loadWallets();

  const items = [
    ...wallets.map(w => ({ label: `${w.name} (${w.address.slice(0, 6)}...${w.address.slice(-4)})`, value: w.address })),
    { label: 'Create new wallet', value: '__create__' },
    { label: 'Import wallet (paste private key)', value: '__import__' },
    { label: 'Use ephemeral wallet (not saved)', value: '__ephemeral__' },
  ];

  const handleSelect = (item: { value: string }) => {
    if (item.value === '__create__') {
      const w = createWallet('Capture Wallet');
      setCreatedWallet(w);
      setIsEphemeral(false);
      setSubScreen('created');
    } else if (item.value === '__import__') {
      setSubScreen('import');
    } else if (item.value === '__ephemeral__') {
      const w = createEphemeralWallet();
      setCreatedWallet(w);
      setIsEphemeral(true);
      setSubScreen('created');
    } else {
      const w = wallets.find(w => w.address === item.value);
      if (w) onComplete(w);
    }
  };

  const handleImportSubmit = (value: string) => {
    try {
      const w = importWallet('Imported Wallet', value);
      setCreatedWallet(w);
      setIsEphemeral(false);
      setSubScreen('created');
    } catch (e: any) {
      setImportError(e.message);
    }
  };

  if (subScreen === 'created' && createdWallet) {
    return (
      <Box flexDirection="column">
        <StatusBar step={1} label="Select wallet" />
        <Text bold color="green">{isEphemeral ? 'Ephemeral wallet created' : 'Wallet created'}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Address: <Text bold>{createdWallet.address}</Text></Text>
          <Text>Key:     <Text dimColor>{createdWallet.privateKey}</Text></Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {SECURITY_WARNING.map((line, i) => (
            <Text key={i} color="yellow">! {line}</Text>
          ))}
          {isEphemeral && <Text color="yellow">! This wallet will NOT be saved after this session.</Text>}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Enter to continue...</Text>
        </Box>
        <ContinueOnEnter onContinue={() => onComplete(createdWallet)} />
      </Box>
    );
  }

  if (subScreen === 'import') {
    return (
      <Box flexDirection="column">
        <StatusBar step={1} label="Select wallet" />
        <Text bold>Import wallet</Text>
        <Box marginTop={1}>
          <Text>Private key (0x...): </Text>
          <TextInput value={importKey} onChange={setImportKey} onSubmit={handleImportSubmit} />
        </Box>
        {importError && (
          <Box marginTop={1}>
            <Text color="red">{importError}</Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <StatusBar step={1} label="Select wallet" />
      {wallets.length > 0 && (
        <Box marginBottom={1} flexDirection="column">
          {SECURITY_WARNING.map((line, i) => (
            <Text key={i} color="yellow">! {line}</Text>
          ))}
        </Box>
      )}
      <SelectInput items={items} onSelect={handleSelect} />
    </Box>
  );
}

function ContinueOnEnter({ onContinue }: { onContinue: () => void }) {
  useInput((_input, key) => {
    if (key.return) onContinue();
  });
  return null;
}
