import React from 'react';
import { Text, Box } from 'ink';

type Props = {
  step: number;
  label: string;
};

export default function StatusBar({ step, label }: Props) {
  return (
    <Box marginBottom={1}>
      <Text bold color="cyan">Step {step}/8: </Text>
      <Text>{label}</Text>
    </Box>
  );
}
