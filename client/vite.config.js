import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // 127.0.0.1 avoids localhost resolving to IPv6 ::1 first (e.g. on Windows).
      '/api': 'http://127.0.0.1:4000',
    },
  },
});
