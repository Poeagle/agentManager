import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // dev server 端口;agentmanager-dev 用 VITE_PORT 覆盖。仅影响 dev——vite build 不读 server.*
    port: Number(process.env.VITE_PORT) || 42011,
    proxy: {
      '/api': {
        // 默认连本机生产后端 :42010;agentmanager-dev 设 VITE_API_TARGET 指向 dev 后端 :42020
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:42010',
        ws: true,
      },
    },
  },
});
