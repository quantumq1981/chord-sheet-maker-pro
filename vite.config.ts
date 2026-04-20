import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/chord-sheet-maker-pro/',
  plugins: [react()],
  // Use app.html as the React entry point so the existing CSMPN Builder
  // (index.html) is preserved as a standalone static file.
  build: {
    rollupOptions: {
      input: {
        app: 'app.html',
        ugProImporter: 'ug-pro-importer.html',
      },
      output: {
        // Split large dependencies into separate chunks so the browser can
        // cache them independently and the initial bundle stays lean.
        manualChunks: {
          react: ['react', 'react-dom'],
          osmd: ['opensheetmusicdisplay'],
          pdf: ['jspdf', 'jszip'],
        },
      },
    },
    // Target modern browsers only — avoids unnecessary transpilation and
    // keeps the output smaller and faster.
    target: 'esnext',
    // Source maps for production — essential for debugging on iOS Safari
    // (DevTools shows original TypeScript, not minified bundle).
    sourcemap: true,
  },
});
