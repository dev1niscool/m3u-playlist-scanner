import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(root, 'release/M3U-Playlist-Scanner.html');
const html = await readFile(outputPath, 'utf8');
const outputStat = await stat(outputPath);

function requireMatch(pattern, label) {
  const match = html.match(pattern);
  if (!match) throw new Error(`Missing ${label}`);
  return match[1];
}

function hash(value) {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

const style = requireMatch(/<style>([\s\S]*?)<\/style>/, 'inline style');
const script = requireMatch(/<script>([\s\S]*?)<\/script>/, 'inline script');
const policy = requireMatch(
  /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  'Content Security Policy',
);

for (const expectedHash of [hash(style), hash(script)]) {
  if (!policy.includes(`'${expectedHash}'`)) {
    throw new Error(`Content Security Policy is missing ${expectedHash}`);
  }
}

const disallowedPatterns = [
  /__STYLE(?:_HASH)?__/,
  /__SCRIPT(?:_HASH)?__/,
  /<script\s+[^>]*src=/i,
  /<link\s+[^>]*rel=["']stylesheet/i,
  /\binnerHTML\b/,
  /\beval\s*\(/,
  /document\.write\s*\(/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
];

for (const pattern of disallowedPatterns) {
  if (pattern.test(html))
    throw new Error(`Disallowed pattern found: ${pattern}`);
}

if (outputStat.size > 2_000_000) {
  throw new Error('Portable HTML is unexpectedly larger than 2 MB');
}

console.log(
  `Verified ${outputPath} (${outputStat.size.toLocaleString()} bytes)`,
);
