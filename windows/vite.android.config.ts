import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Nova pour Android (Capacitor) : l'interface de Windows avec le pont Android à la place d'Electron.
export default defineConfig({
  root: 'src/android',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/android', emptyOutDir: true, target: 'es2022' },
});
