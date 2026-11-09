import 'codicon.css';
import './styles.css';

import { render } from 'preact';

import type { HostMessage } from '../shared/protocol';
import { App } from './App';
import { handleHostMessage, post } from './store';

window.addEventListener('message', (event: MessageEvent<HostMessage>) => handleHostMessage(event.data));
const root = document.getElementById('app');
if (root) render(<App />, root);
post({ type: 'ready' });
