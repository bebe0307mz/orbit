import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static build (served by services/api later). Relative base so it works under any path.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
});
