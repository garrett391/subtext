import { defineConfig } from 'vite';

export default defineConfig({
  base: '/subtext/', // repo name for a project site; use '/' on a username.github.io repo
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
});
