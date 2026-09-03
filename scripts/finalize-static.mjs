import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const outputDirectory = join(process.cwd(), 'dist', 'client');
const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const githubPagesBasePath =
  process.env.GITHUB_ACTIONS === 'true' &&
  repositoryName &&
  !repositoryName.endsWith('.github.io')
    ? `/${repositoryName}`
    : '';

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return htmlFiles(path);
      return entry.name.endsWith('.html') ? [path] : [];
    }),
  );
  return files.flat();
}

function scriptHashes(html) {
  const hashes = new Set();
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const digest = createHash('sha256').update(match[1]).digest('base64');
    hashes.add(`'sha256-${digest}'`);
  }
  return [...hashes];
}

async function textAssetFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return textAssetFiles(path);
      return /\.(?:css|html|js|json|rsc)$/.test(entry.name) ? [path] : [];
    }),
  );
  return files.flat();
}

if (githubPagesBasePath) {
  for (const file of await textAssetFiles(outputDirectory)) {
    const contents = await readFile(file, 'utf8');
    const rewritten = contents
      .replaceAll('/_next/', `${githubPagesBasePath}/_next/`)
      .replaceAll('/favicon.svg', `${githubPagesBasePath}/favicon.svg`);
    if (rewritten !== contents) await writeFile(file, rewritten);
  }
}

const files = await htmlFiles(outputDirectory);
const allHashes = new Set();

for (const file of files) {
  const html = await readFile(file, 'utf8');
  for (const hash of scriptHashes(html)) allHashes.add(hash);
}

const policy = [
  "default-src 'self'",
  `script-src 'self' ${[...allHashes].join(' ')}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  'connect-src https:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-src 'none'",
  "worker-src 'self'",
].join('; ');

for (const file of files) {
  const html = await readFile(file, 'utf8');
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  await writeFile(file, html.replace('<head>', `<head>${tag}`));
}

const headers = [
  '/*',
  `  Content-Security-Policy: ${policy}`,
  '  Referrer-Policy: no-referrer',
  '  X-Content-Type-Options: nosniff',
  '  X-Frame-Options: DENY',
  '  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  '  Cross-Origin-Opener-Policy: same-origin',
  '',
].join('\n');

await writeFile(join(outputDirectory, '_headers'), headers);
