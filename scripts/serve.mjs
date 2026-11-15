import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
let singleFile = null;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--file') singleFile = process.argv[++i];
  else if (arg.startsWith('--file=')) singleFile = arg.slice(7);
  else throw new Error('Unknown preview option: ' + arg);
  if (!singleFile || singleFile.startsWith('--')) throw new Error('Missing --file');
}
if (singleFile) {
  singleFile = resolve(singleFile);
  if (!(await stat(singleFile)).isFile()) throw new Error('OFFLINE_FILE_MISSING');
}
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (singleFile && !['/', '/index.html'].includes(pathname)) { res.writeHead(404); res.end('Not found'); return; }
    const file = singleFile || resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const inside = relative(root, file);
    if (!singleFile && (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep))) { res.writeHead(403); res.end(); return; }
    await stat(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${server.address().port}`));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping: ${signal}`);
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  server.close(() => {
    clearTimeout(deadline);
    console.log(`Stopped: ${signal}`);
    process.exit(0);
  });
  server.closeAllConnections();
});
