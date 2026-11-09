import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReaderApp } from './reader-app';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(
  <StrictMode>
    <ReaderApp />
  </StrictMode>,
);
