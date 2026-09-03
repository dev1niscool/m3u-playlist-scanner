export const MAX_INPUT_BYTES = 2_000_000;
export const MAX_CANDIDATES = 500;
export const MAX_API_BYTES = 1_000_000;
export const REQUEST_TIMEOUT_MS = 8_000;

export type Candidate = {
  id: string;
  host: string;
  user: string;
  pass: string;
};

export type WorkingResult = Candidate & {
  status: 'working';
  active: number;
  max: number | null;
  expiry: number | null;
};

export type FailedResult = Candidate & {
  status: 'failed';
  reason: string;
};

export type CheckResult = WorkingResult | FailedResult;

export type ApiCheckOutcome =
  | Pick<WorkingResult, 'status' | 'active' | 'max' | 'expiry'>
  | Pick<FailedResult, 'status' | 'reason'>;

const BLOCKED_LABELS = new Set([
  'host',
  'login',
  'null',
  'pass',
  'password',
  'port',
  'scan',
  'undefined',
  'url',
  'user',
  'username',
]);

function primitiveString(value: unknown): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
    ? String(value)
    : '';
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function cleanValue(value: unknown): string {
  return primitiveString(value)
    .normalize('NFKC')
    .trim()
    .replace(/^[\s"'`{[(<]+|[\s"'`}\])>,;]+$/g, '');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const mappedIpv4 = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4) return isBlockedHostname(mappedIpv4[1]);

  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isBlockedHostname(
      `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
    );
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.test') ||
    host.endsWith('.invalid') ||
    host === '::' ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    /^fe[89ab]/.test(host) ||
    host.startsWith('ff')
  ) {
    return true;
  }

  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function normalizeHost(rawHost: string): string | null {
  const cleaned = cleanValue(rawHost).replace(/\/+$/, '');
  if (!cleaned || cleaned.length > 500 || containsControlCharacters(cleaned))
    return null;

  const withProtocol = /^https?:\/\//i.test(cleaned)
    ? cleaned
    : `https://${cleaned}`;

  try {
    const parsed = new URL(withProtocol);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      isBlockedHostname(parsed.hostname)
    ) {
      return null;
    }
    if (parsed.port) {
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function normalizeCandidateInput(
  hostValue: string,
  userValue: string,
  passValue: string,
): Candidate | null {
  const host = normalizeHost(hostValue);
  const user = cleanValue(safeDecode(userValue));
  const pass = cleanValue(safeDecode(passValue));
  if (!host || !user || !pass || user.length > 256 || pass.length > 256) {
    return null;
  }
  if (containsControlCharacters(user) || containsControlCharacters(pass)) {
    return null;
  }
  if (BLOCKED_LABELS.has(user.toLowerCase())) return null;
  return { id: `${host}\u0000${user}\u0000${pass}`, host, user, pass };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(cleanValue(current));
      current = '';
    } else {
      current += character;
    }
  }

  values.push(cleanValue(current));
  return values;
}

function findField(record: Record<string, unknown>, names: string[]): string {
  const entry = Object.entries(record).find(([key]) =>
    names.includes(key.toLowerCase().replace(/[^a-z]/g, '')),
  );
  return cleanValue(entry?.[1]);
}

export function parsePlaylistText(text: string): Candidate[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const boundedText = text.slice(0, MAX_INPUT_BYTES);
  const lines = boundedText.split(/\r?\n/, 50_000);
  const candidates = new Map<string, Candidate>();
  let lastHost: string | null = null;

  const addCandidate = (
    hostValue: string,
    userValue: string,
    passValue: string,
  ) => {
    if (candidates.size >= MAX_CANDIDATES) return;
    const candidate = normalizeCandidateInput(hostValue, userValue, passValue);
    if (candidate && !candidates.has(candidate.id)) {
      candidates.set(candidate.id, candidate);
    }
  };

  const hostPattern = /(https?:\/\/[^\s"'<>,]+)/i;
  const userPattern =
    /(?:^|[\s|,])(?:username|user|usr|login|credential|👤)\s*[:=|>-]+\s*["']?([^\s|,"'<>]+)/i;
  const passPattern =
    /(?:^|[\s|,])(?:password|pass|passwd|pwd|key|🔐)\s*[:=|>-]+\s*["']?([^\s|,"'<>]+)/i;

  for (
    let index = 0;
    index < lines.length && candidates.size < MAX_CANDIDATES;
    index += 1
  ) {
    const line = lines[index]
      .normalize('NFKC')
      .replace(/[├└│─║╚╔═➠→★✮•➤👉]/gu, ' ')
      .trim();
    if (line.length < 3 || line.length > 2_000) continue;

    const urls = line.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
    for (const rawUrl of urls) {
      try {
        const parsed = new URL(rawUrl.replace(/[),.;]+$/, ''));
        const user =
          parsed.searchParams.get('username') ??
          parsed.searchParams.get('user');
        const pass =
          parsed.searchParams.get('password') ??
          parsed.searchParams.get('pass');
        if (user && pass) addCandidate(parsed.origin, user, pass);
      } catch {
        // Ignore malformed URL-shaped text.
      }
    }

    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const host = findField(record, [
          'host',
          'url',
          'server',
          'portal',
          'panel',
          'endpoint',
        ]);
        const user = findField(record, ['user', 'username', 'usr', 'login']);
        const pass = findField(record, ['pass', 'password', 'passwd', 'pwd']);
        if (host && user && pass) addCandidate(host, user, pass);
      } catch {
        // JSON-like log lines continue through the labeled parser below.
      }
    }

    if (line.includes(',')) {
      const parts = parseCsvLine(line);
      const urlIndex = parts.findIndex((part) => /^https?:\/\//i.test(part));
      if (urlIndex >= 0) {
        if (
          parts[urlIndex + 1] &&
          parts[urlIndex + 2] &&
          !/^\d{1,5}$/.test(parts[urlIndex + 1])
        ) {
          addCandidate(
            parts[urlIndex],
            parts[urlIndex + 1],
            parts[urlIndex + 2],
          );
        } else if (parts[urlIndex + 2] && parts[urlIndex + 3]) {
          addCandidate(
            parts[urlIndex],
            parts[urlIndex + 2],
            parts[urlIndex + 3],
          );
        }
      }
    }

    const hostMatch = line.match(hostPattern);
    const userMatch = line.match(userPattern);
    const passMatch = line.match(passPattern);
    if (hostMatch) lastHost = normalizeHost(hostMatch[1]);
    if (userMatch && passMatch && (hostMatch?.[1] || lastHost)) {
      addCandidate(
        hostMatch?.[1] ?? lastHost ?? '',
        userMatch[1],
        passMatch[1],
      );
      continue;
    }

    const parts = line
      .split(/[\s|\t]+/)
      .map(cleanValue)
      .filter(Boolean);
    if (parts.length === 3) {
      if (/^https?:\/\//i.test(parts[0]))
        addCandidate(parts[0], parts[1], parts[2]);
      else if (/^https?:\/\//i.test(parts[2]))
        addCandidate(parts[2], parts[0], parts[1]);
    } else if (parts.length === 2 && /^https?:\/\//i.test(parts[0])) {
      const separator = parts[1].indexOf(':');
      if (separator > 0) {
        addCandidate(
          parts[0],
          parts[1].slice(0, separator),
          parts[1].slice(separator + 1),
        );
      }
    }

    if (lastHost) {
      const withoutHost = line.replace(hostMatch?.[1] ?? '', ' ').trim();
      const combo = withoutHost.match(
        /^([\w.@-]{1,256})\s*[:|]\s*([^\s|]{1,256})$/,
      );
      if (combo && !/^https?$/i.test(combo[1]))
        addCandidate(lastHost, combo[1], combo[2]);

      if (userMatch && !passMatch) {
        for (
          let offset = 1;
          offset <= 3 && index + offset < lines.length;
          offset += 1
        ) {
          const nextPass = lines[index + offset]
            .normalize('NFKC')
            .match(passPattern);
          if (nextPass) {
            addCandidate(lastHost, userMatch[1], nextPass[1]);
            break;
          }
        }
      }
    }
  }

  return [...candidates.values()];
}

export function buildApiUrl(
  candidate: Candidate,
  action?: string,
  parameters: Record<string, string> = {},
): string {
  const url = new URL('/player_api.php', `${candidate.host}/`);
  url.searchParams.set('username', candidate.user);
  url.searchParams.set('password', candidate.pass);
  if (action) url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(parameters))
    url.searchParams.set(key, value);
  return url.toString();
}

export function buildM3uUrl(candidate: Candidate): string {
  const url = new URL('/get.php', `${candidate.host}/`);
  url.searchParams.set('username', candidate.user);
  url.searchParams.set('password', candidate.pass);
  url.searchParams.set('type', 'm3u_plus');
  url.searchParams.set('output', 'ts');
  return url.toString();
}

export function maskM3uUrl(candidate: Candidate): string {
  const url = new URL(buildM3uUrl(candidate));
  url.searchParams.set('password', '••••••••');
  return url.toString();
}

function safeNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function evaluatePlayerApiPayload(
  payload: unknown,
  minimum: number,
): ApiCheckOutcome {
  if (!payload || typeof payload !== 'object') {
    return { status: 'failed', reason: 'Unexpected server response' };
  }

  const userInfo = (payload as { user_info?: unknown }).user_info;
  if (!userInfo || typeof userInfo !== 'object') {
    return { status: 'failed', reason: 'Credentials were not accepted' };
  }

  const info = userInfo as Record<string, unknown>;
  const authenticated =
    (typeof info.auth === 'string' || typeof info.auth === 'number') &&
    String(info.auth) === '1';
  const activeStatus =
    typeof info.status === 'string' && info.status.toLowerCase() === 'active';
  if (!authenticated || !activeStatus) {
    return {
      status: 'failed',
      reason: 'Invalid, inactive, or expired credentials',
    };
  }

  const max =
    info.max_connections === null || info.max_connections === ''
      ? null
      : safeNumber(info.max_connections);
  if (max !== null && max < minimum) {
    return {
      status: 'failed',
      reason: `Max connections (${max}) is below ${minimum}`,
    };
  }

  const expirySeconds = safeNumber(info.exp_date);
  return {
    status: 'working',
    active: safeNumber(info.active_cons),
    max,
    expiry: expirySeconds > 0 ? expirySeconds * 1_000 : null,
  };
}

export async function readJsonWithLimit(response: Response): Promise<unknown> {
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_API_BYTES) throw new Error('Response is too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function csvCell(value: unknown): string {
  let text = primitiveString(value);
  if (/^[=+@\t\r-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
