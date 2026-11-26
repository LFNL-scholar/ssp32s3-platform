import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '../web/dist');
const dstDir = path.resolve(__dirname, './public');

if (!fs.existsSync(srcDir)) {
  console.error('Error: ../web/dist not found. Run `cd web && npm run build` first.');
  process.exit(1);
}

fs.rmSync(dstDir, { recursive: true, force: true });
fs.mkdirSync(dstDir, { recursive: true });

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const srcPath = path.join(from, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, path.join(to, entry.name));
    } else if (entry.name.endsWith('.gz')) {
      const outName = entry.name.slice(0, -3);
      const raw = zlib.gunzipSync(fs.readFileSync(srcPath));
      fs.writeFileSync(path.join(to, outName), raw);
    } else {
      fs.copyFileSync(srcPath, path.join(to, entry.name));
    }
  }
}

copyDir(srcDir, dstDir);
console.log('Synced uncompressed web/dist assets -> cloudflare-worker/public');
