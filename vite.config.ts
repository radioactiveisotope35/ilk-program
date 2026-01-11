import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      // WebSocket proxy for Binance streams (bypasses CORS in development)
      proxy: {
        '/binance-ws': {
          target: 'wss://stream.binance.com:9443',
          ws: true,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/binance-ws/, ''),
        },
        '/binance-api': {
          target: 'https://data-api.binance.vision',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/binance-api/, ''),
        },
      },
    },
    plugins: [react()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      }
    }
  };
});