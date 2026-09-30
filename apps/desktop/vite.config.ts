import { defineConfig } from 'vite';

export default defineConfig({
  // Tauri loads the built files from disk; relative URLs keep that working.
  base: './',
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});
