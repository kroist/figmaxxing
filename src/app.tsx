import React, { useState } from 'react';
import { Text } from 'ink';
import type { Wallet, Chain, FigmaDestination as FigmaDestType } from './types.js';
import type { CaptureResult } from './lib/capture.js';
import { isFirstRun } from './lib/config.js';
import SetupWizard from './screens/setup-wizard.js';
import WalletSelector from './screens/wallet-selector.js';
import ChainPicker from './screens/chain-picker.js';
import UrlInput from './screens/url-input.js';
import FigmaDestination from './screens/figma-destination.js';
import CaptureIdScreen from './screens/capture-id.js';
import BrowserSession from './screens/browser-session.js';
import ResultScreen from './screens/result.js';

type Screen = 'setup' | 'wallet' | 'chain' | 'url' | 'figma' | 'captureId' | 'browser' | 'result';

export default function App() {
  const [screen, setScreen] = useState<Screen>(isFirstRun() ? 'setup' : 'wallet');
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [chain, setChain] = useState<Chain | null>(null);
  const [url, setUrl] = useState('');
  const [figmaDest, setFigmaDest] = useState<FigmaDestType | null>(null);
  const [captureId, setCaptureId] = useState('');
  const [captureResult, setCaptureResult] = useState<CaptureResult | null>(null);

  switch (screen) {
    case 'setup':
      return <SetupWizard onComplete={() => setScreen('wallet')} />;

    case 'wallet':
      return (
        <WalletSelector
          onComplete={(w) => {
            setWallet(w);
            setScreen('chain');
          }}
        />
      );

    case 'chain':
      return (
        <ChainPicker
          onComplete={(c) => {
            setChain(c);
            setScreen('url');
          }}
        />
      );

    case 'url':
      return (
        <UrlInput
          onComplete={(u) => {
            setUrl(u);
            setScreen('figma');
          }}
        />
      );

    case 'figma':
      return (
        <FigmaDestination
          url={url}
          onComplete={(dest) => {
            setFigmaDest(dest);
            setScreen('captureId');
          }}
        />
      );

    case 'captureId':
      return (
        <CaptureIdScreen
          destination={figmaDest!}
          onComplete={(id) => {
            setCaptureId(id);
            setScreen('browser');
          }}
        />
      );

    case 'browser':
      return (
        <BrowserSession
          config={{
            wallet: wallet!,
            chain: chain!,
            url,
            captureId,
            figmaEndpoint: `https://mcp.figma.com/mcp/capture/${captureId}/submit`,
          }}
          onComplete={(result) => {
            setCaptureResult(result);
            setScreen('result');
          }}
        />
      );

    case 'result':
      return <ResultScreen result={captureResult!} />;

    default:
      return <Text>Unknown screen: {screen}</Text>;
  }
}
