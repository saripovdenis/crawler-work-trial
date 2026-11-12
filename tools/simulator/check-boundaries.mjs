import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ownRoot = fileURLToPath(new URL('../../', import.meta.url));
const httpCall = /\bfetch\s*\(|\b(?:https?|axios|undici|requests|session)\s*\.\s*(?:get|post|put|delete|request|send)\s*\(|\b(?:new\s+WebSocket|XMLHttpRequest)\b/;
const clientImport = /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:node:)?(?:https|http2|net|tls|undici|axios|got|node-fetch|request|curl_cffi|urllib)(?:\/[^'"]*)?['"]/;
const service = path => path.match(/^services\/([^/]+)\//)?.[1];
export function violationsFor(path, source) {
  const errors = [];
  const transport = (path.startsWith('services/crawler/src/fetcher/') || path === 'services/monitor/src/client.ts');
  const python = path === 'services/fetcher-impersonate/cffi-fetch.py';
  const pythonClient = /(?:^|\n)\s*(?:from\s+(?:curl_cffi|urllib|requests|httpx|aiohttp)\b|import\s+(?:requests|httpx|aiohttp|urllib)\b)/;
  if (!transport && !python && (httpCall.test(source) || clientImport.test(source) || pythonClient.test(source))) errors.push(`${path}: outbound HTTP outside the fetcher`);
  // The dashboard may import the HTTP server, but not an HTTP client alias.
  if (!transport && /(?:from|require\()\s*['"](?:node:)?http['"]/.test(source)
      && !/import\s*\{\s*createServer\s*\}\s*from\s*['"]node:http['"]/.test(source))
    errors.push(`${path}: HTTP client-capable import outside the fetcher`);
  if (/services\/crawler\/src\/fetcher\/(?:remote-worker|index)\.ts$/.test(path) && /node:sqlite|packages\/db|\/scheduler\//.test(source)) errors.push(`${path}: fetch worker must not access SQLite or scheduler source`);
  if (python && /\b(?:sqlite3|sqlalchemy|psycopg|DatabaseSync)\b/.test(source)) errors.push(`${path}: Python transport must not access a database`);
  for (const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) continue;
    const target = relative(ownRoot, resolve(ownRoot, dirname(path), match[1])).replaceAll('\\', '/');
    const targetService = service(target);
    if (targetService && targetService !== service(path)) errors.push(`${path}: imports another service's source (${target})`);
    if (path.startsWith('apps/') && target.startsWith('packages/db/')) errors.push(`${path}: dashboard must use its separate read-only connection`);
  }
  return errors;
}
export function checkBoundaries(root = ownRoot) {
  const errors = [];
  function walk(dir) {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const skip = ['node_modules','dist','__pycache__','data','logs','tools','fixtures','docs','deploy'].includes(entry.name)
          || entry.name.startsWith('.') || /^apps\/dashboard\/src\/(pages|components|lib)$/.test(path);
        if (!skip) walk(path);
        continue;
      }
      if (!/\.(?:ts|js|mjs|cjs|py)$/.test(path)) continue;
      errors.push(...violationsFor(path, readFileSync(resolve(root, path), 'utf8')));
    }
  }
  walk('');
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBoundaries();
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Import and outbound HTTP boundaries passed');
}
