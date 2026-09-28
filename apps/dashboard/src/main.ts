import { CoordinatorClient } from './api.js';
import { Dashboard } from './app.js';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

const dashboard = new Dashboard({
  root,
  client: new CoordinatorClient(import.meta.env.VITE_COORDINATOR_URL ?? ''),
});
dashboard.start();
