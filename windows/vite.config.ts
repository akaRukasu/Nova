import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Numéro de construction affiché sur l'écran de démarrage (GitHub le fournit).
process.env.VITE_NOVA_BUILD ??= 'local';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
