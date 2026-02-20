import React from 'react';
import { render } from 'ink';
import App from './app.js';
import { startSession } from './lib/logger.js';

startSession();
render(<App />);
