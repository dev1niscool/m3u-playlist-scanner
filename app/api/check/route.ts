import {
  REQUEST_TIMEOUT_MS,
  buildApiUrl,
  evaluatePlayerApiPayload,
  normalizeCandidateInput,
  readJsonWithLimit,
  type ApiCheckOutcome,
  type Candidate,
} from '@/lib/playlist';

const MAX_REQUEST_BYTES = 4_096;
const CATEGORY_ACTIONS = new Set([
  'get_live_categories',
  'get_vod_categories',
  'get_series_categories',
]);
const STREAM_ACTIONS = new Set([
  'get_live_streams',
  'get_vod_streams',
  'get_series',
]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function readRequestBody(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) throw new Error('request-too-large');
  if (!request.body) return '';

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
      if (body.length > MAX_REQUEST_BYTES) throw new Error('request-too-large');
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

function requestCandidate(value: unknown): Candidate | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.host !== 'string' ||
    typeof raw.user !== 'string' ||
    typeof raw.pass !== 'string'
  ) {
    return null;
  }
  return normalizeCandidateInput(raw.host, raw.user, raw.pass);
}

function requestAction(value: unknown): {
  action?: string;
  parameters?: Record<string, string>;
} | null {
  if (value === undefined) return {};
  if (typeof value !== 'string') return null;
  if (CATEGORY_ACTIONS.has(value)) return { action: value };
  if (!STREAM_ACTIONS.has(value)) return null;
  return { action: value };
}

function requestParameters(
  action: string | undefined,
  value: unknown,
): Record<string, string> | null {
  if (!action || CATEGORY_ACTIONS.has(action)) {
    return value === undefined ||
      (value &&
        typeof value === 'object' &&
        Object.keys(value as object).length === 0)
      ? {}
      : null;
  }
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1 || entries[0][0] !== 'category_id') return null;
  const categoryId = entries[0][1];
  if (typeof categoryId !== 'string' || !/^\d{1,20}$/.test(categoryId)) {
    return null;
  }
  return { category_id: categoryId };
}

function failed(reason: string): ApiCheckOutcome {
  return { status: 'failed', reason };
}

export async function POST(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  if (!origin || origin !== requestUrl.origin) {
    return json({ error: 'Same-origin requests only' }, 403);
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return json({ error: 'JSON request required' }, 415);
  }

  let input: Record<string, unknown>;
  try {
    const body = await readRequestBody(request);
    input = JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error && error.message === 'request-too-large'
            ? 'Request is too large'
            : 'Invalid JSON request',
      },
      400,
    );
  }

  const candidate = requestCandidate(input.candidate);
  const actionInput = requestAction(input.action);
  if (!candidate || !actionInput) {
    return json({ error: 'Invalid playlist check request' }, 400);
  }
  const parameters = requestParameters(actionInput.action, input.parameters);
  if (!parameters) {
    return json({ error: 'Invalid playlist action parameters' }, 400);
  }

  const minimum = Number(input.minimum ?? 1);
  if (
    !actionInput.action &&
    (!Number.isInteger(minimum) || minimum < 1 || minimum > 1_000)
  ) {
    return json({ error: 'Invalid minimum connection count' }, 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      buildApiUrl(candidate, actionInput.action, parameters),
      {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const reason = `Server returned HTTP ${response.status}`;
      return actionInput.action
        ? json({ error: reason }, 502)
        : json({ outcome: failed(reason) });
    }

    const payload = await readJsonWithLimit(response);
    return actionInput.action
      ? json({ data: payload })
      : json({ outcome: evaluatePlayerApiPayload(payload, minimum) });
  } catch (error) {
    const timedOut =
      error instanceof DOMException && error.name === 'AbortError';
    const tooLarge =
      error instanceof Error && /response is too large/i.test(error.message);
    const reason = timedOut
      ? 'Request timed out'
      : tooLarge
        ? 'Server response exceeded the safety limit'
        : 'The public playlist server could not be reached';
    return actionInput.action
      ? json({ error: reason }, timedOut ? 504 : 502)
      : json({ outcome: failed(reason) });
  } finally {
    clearTimeout(timeout);
  }
}
