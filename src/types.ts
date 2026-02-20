export type Wallet = {
  name: string;
  address: string;
  privateKey: string;
};

export type Chain = {
  id: number;
  name: string;
  hexId: string;
  rpc: string;
};

export type FigmaDestination = {
  mode: 'newFile' | 'existingFile';
  fileKey?: string;
  planKey?: string;
  fileName?: string;
};

export type CaptureConfig = {
  wallet: Wallet;
  chain: Chain;
  url: string;
  captureId: string;
  figmaEndpoint: string;
};

export type TxRequest = {
  id: number;
  method: string;
  params: any[];
  display: Record<string, string>;
  sign: () => Promise<string>;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};
