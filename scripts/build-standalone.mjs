import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = await readFile(
  join(root, 'standalone/index.template.html'),
  'utf8',
);
const style = (
  await readFile(join(root, 'standalone/style.css'), 'utf8')
).trim();
const script = (await readFile(join(root, 'standalone/app.js'), 'utf8')).trim();

function cspHash(value) {
  return `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
}

let output = template.replace('__STYLE__', style).replace('__SCRIPT__', script);
const embeddedStyle = output.match(/<style>([\s\S]*?)<\/style>/)?.[1];
const embeddedScript = output.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (embeddedStyle === undefined || embeddedScript === undefined) {
  throw new Error('Standalone template is missing its inline assets');
}
output = output
  .replace('__STYLE_HASH__', cspHash(embeddedStyle))
  .replace('__SCRIPT_HASH__', cspHash(embeddedScript));

const outputPath = join(root, 'release/M3U-Playlist-Scanner.html');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, output, 'utf8');

console.log(`Built ${outputPath}`);
