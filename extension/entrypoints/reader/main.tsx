import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReaderApp } from '../../../src/reader-app';
import { extensionEnvironment } from '../../environment';
import '../../../src/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing reader root.');
const environment = await extensionEnvironment();
createRoot(root).render(
  <StrictMode>
    <ReaderApp environment={environment} />
  </StrictMode>,
);
