import { defineConfig } from 'vite';

export default defineConfig({
  // Tauri loads the built files from disk; relative URLs keep that working.
  base: './',
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // Tauri embeds frontendDist into the binary; source maps would bloat it for no
  // runtime benefit (there is no browser devtools consumer in production).
  build: { target: 'es2022', sourcemap: false },
});
