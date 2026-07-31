import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // dev server 端口;agentmanager-dev 用 VITE_PORT 覆盖。仅影响 dev——vite build 不读 server.*
    port: Number(process.env.VITE_PORT) || 42011,
    // 监听所有网卡，让局域网内的其他设备也能打开并登录 dev dashboard。
    host: true,
    // Vite 7 默认拒绝 Host 头不在白名单里的请求(返回 "Blocked request. This host is
    // not allowed.")。放行所有 host，否则用局域网 IP、域名、反代或隧道打开会
    // 403。仅 dev 生效——生产是 Fastify 托管的静态构建，不受影响。
    allowedHosts: true,
    proxy: {
      '/api': {
        // 默认连本机生产后端 :42010;agentmanager-dev 设 VITE_API_TARGET 指向 dev 后端 :42020
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:42010',
        ws: true,
      },
    },
  },
});
