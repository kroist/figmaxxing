import React, { useState, useEffect } from 'react';
import { Text, Box } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { FigmaDestination as FigmaDestType } from '../types.js';
import StatusBar from '../components/status-bar.js';
import { fetchFigmaOptions } from '../lib/claude.js';

type Team = { name: string; planKey: string };
type FigmaFile = { name: string; fileKey: string };

type Props = {
  url: string;
  onComplete: (destination: FigmaDestType) => void;
};

type SubScreen = 'selectMode' | 'loading' | 'selectItem' | 'fileName';

function fileNameFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return `${hostname} capture`;
  } catch {
    return 'DApp capture';
  }
}

export default function FigmaDestination({ url, onComplete }: Props) {
  const [subScreen, setSubScreen] = useState<SubScreen>('selectMode');
  const [mode, setMode] = useState<'newFile' | 'existingFile'>('newFile');
  const [teams, setTeams] = useState<Team[]>([]);
  const [files, setFiles] = useState<FigmaFile[]>([]);
  const [fileName, setFileName] = useState(fileNameFromUrl(url));
  const [selectedPlanKey, setSelectedPlanKey] = useState('');
  const [error, setError] = useState('');

  const modeItems = [
    { label: 'New Figma file', value: 'newFile' },
    { label: 'Existing Figma file', value: 'existingFile' },
  ];

  const handleModeSelect = (item: { value: string }) => {
    setMode(item.value as 'newFile' | 'existingFile');
    setSubScreen('loading');
  };

  useEffect(() => {
    if (subScreen !== 'loading') return;
    fetchFigmaOptions()
      .then(({ teams, files }) => {
        setTeams(teams);
        setFiles(files);
        setSubScreen('selectItem');
      })
      .catch(e => {
        setError(e.message);
      });
  }, [subScreen]);

  const handleItemSelect = (item: { value: string }) => {
    if (mode === 'existingFile') {
      onComplete({ mode: 'existingFile', fileKey: item.value });
    } else {
      setSelectedPlanKey(item.value);
      setSubScreen('fileName');
    }
  };

  const handleFileNameSubmit = (value: string) => {
    if (!value.trim()) return;
    onComplete({ mode: 'newFile', planKey: selectedPlanKey, fileName: value.trim() });
  };

  if (error) {
    return (
      <Box flexDirection="column">
        <StatusBar step={4} label="Figma destination" />
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (subScreen === 'loading') {
    return (
      <Box flexDirection="column">
        <StatusBar step={4} label="Figma destination" />
        <Text>
          <Spinner type="dots" /> Fetching Figma options...
        </Text>
      </Box>
    );
  }

  if (subScreen === 'selectItem') {
    const listItems = mode === 'newFile'
      ? teams.map(t => ({ label: t.name, value: t.planKey }))
      : files.map(f => ({ label: f.name, value: f.fileKey }));

    return (
      <Box flexDirection="column">
        <StatusBar step={4} label="Figma destination" />
        <Text bold>{mode === 'newFile' ? 'Select team:' : 'Select file:'}</Text>
        <SelectInput items={listItems} onSelect={handleItemSelect} />
      </Box>
    );
  }

  if (subScreen === 'fileName') {
    return (
      <Box flexDirection="column">
        <StatusBar step={4} label="Figma destination" />
        <Text bold>File name:</Text>
        <Box marginTop={1}>
          <TextInput value={fileName} onChange={setFileName} onSubmit={handleFileNameSubmit} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <StatusBar step={4} label="Figma destination" />
      <SelectInput items={modeItems} onSelect={handleModeSelect} />
    </Box>
  );
}
