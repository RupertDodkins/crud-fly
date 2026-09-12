import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only: POST /__save?name=x.webm writes the body to tools/out/. Lets the in-browser recorder land files on disk.
function saveToDisk(): Plugin {
  return {
    name: 'crud-fly-save',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end();
        }
        const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? 'capture.bin';
        const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = join(process.cwd(), 'tools', 'out');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, safe), Buffer.concat(chunks));
          res.setHeader('content-type', 'text/plain');
          res.end(join(dir, safe));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [saveToDisk()],
});
