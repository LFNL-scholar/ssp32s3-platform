import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function gzipDistPlugin(): Plugin {
  return {
    name: 'gzip-dist-only',
    closeBundle() {
      const distDir = path.resolve(__dirname, 'dist');
      if (!fs.existsSync(distDir)) return;

      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (/\.(html|js|css|svg|json)$/i.test(entry.name)) {
            const raw = fs.readFileSync(full);
            const gz = zlib.gzipSync(raw, { level: 9 });
            fs.writeFileSync(`${full}.gz`, gz);
            fs.unlinkSync(full);
          }
        }
      };
      walk(distDir);
    },
  };
}

export default defineConfig({
  plugins: [preact(), gzipDistPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    minify: 'esbuild',
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://ssp32s3.local',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://ssp32s3.local',
        ws: true,
      },
    },
  },
});
