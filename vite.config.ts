import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const ROOT = new URL('.', import.meta.url).pathname;

/** site.webmanifest (the installed-app name and icons), built from the same VITE_APP_NAME as the page. */
function manifest(name: string): Plugin {
  const body = JSON.stringify(
    {
      name,
      short_name: name.length > 12 ? 'Analytics' : name,
      description: 'Visitors, sources and revenue for your websites.',
      start_url: '/',
      display: 'standalone',
      background_color: '#f4f5f7',
      theme_color: '#15171c',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  );
  return {
    name: 'site-webmanifest',
    configureServer(server) {
      server.middlewares.use('/site.webmanifest', (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(body);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'site.webmanifest', source: body });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, 'VITE_');
  return {
    root: 'src/dashboard',
    // .env and .env.local live at the project root, next to package.json.
    envDir: ROOT,
    publicDir: '../../public',
    plugins: [react(), manifest(env.VITE_APP_NAME || 'Open Analytics')],
    build: { outDir: '../../dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:8787',
          // Keep the browser's Host (localhost:5173). Sign-in only accepts requests whose Origin matches the
          // address they were sent to, and in development that's the dashboard's port, not the API's.
          changeOrigin: false,
        },
      },
    },
  };
});
