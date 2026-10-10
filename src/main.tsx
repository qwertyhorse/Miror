import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ExhibitionApp from './exhibition/ExhibitionApp';
import { appUrl } from './versionScope';
import './base.css';

const entryPaths = new Set(['/', '/v1.1', '/v1.1/']);

if (entryPaths.has(window.location.pathname)) {
  const destination = new URL(window.location.href);
  destination.pathname = appUrl('/exhibition');
  window.location.replace(destination.toString());
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode><ExhibitionApp /></StrictMode>,
  );
}
