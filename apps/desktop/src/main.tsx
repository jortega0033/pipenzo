import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRoot } from './AppRoot.js';
import './pipenzo-theme.css';
// Note: agentdock's own reference-demo styling (light-mode, Inter) lives in styles.css,
// unused now that main.tsx points at Pipenzo's own dark theme. Left in place rather than
// deleted -- AppRoot.tsx still renders agentdock's demo components pending a later ticket
// that replaces them with Pipenzo's own screens.

async function renderApp(): Promise<void> {
  const captureMode =
    import.meta.env.DEV && new URLSearchParams(window.location.search).has('asset-capture');
  if (captureMode) {
    const { installAssetCaptureBridge } = await import('./asset-capture-bridge.js');
    installAssetCaptureBridge();
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppRoot />
    </StrictMode>,
  );
}

void renderApp();
