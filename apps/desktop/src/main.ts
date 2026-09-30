import { REMOTE_DISCLOSURE } from '@ai-commons/worker/disclosure';
import { DesktopApp } from './app.js';
import { confirmDialog } from './dialog.js';
import { tauriBackend } from './ipc.js';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

void new DesktopApp(root, {
  backend: tauriBackend(),
  confirm: confirmDialog,
  disclosure: REMOTE_DISCLOSURE,
}).start();
