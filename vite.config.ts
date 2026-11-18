import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// NOTE: No `define` for GEMINI_API_KEY here, on purpose.
// Anything placed in `define` is inlined into the public JS bundle that every
// visitor downloads. The key must only ever live on the server side
// (netlify/functions/*), which reads it from process.env at request time.
export default defineConfig({
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
