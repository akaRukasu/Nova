import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadLibrary } from './lib/library';
import './styles.css';

void loadLibrary().finally(() => createRoot(document.getElementById('root')!).render(<App />));
