import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs let the build be hosted at any path; routing is hash-based.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
