'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Download,
  Eye,
  EyeOff,
  FileText,
  Film,
  ListFilter,
  LoaderCircle,
  Pause,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  Tv,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Toaster, toast } from '@/components/ui/toast';
import {
  MAX_CANDIDATES,
  MAX_INPUT_BYTES,
  REQUEST_TIMEOUT_MS,
  buildApiUrl,
  buildM3uUrl,
  csvCell,
  maskM3uUrl,
  parsePlaylistText,
  readJsonWithLimit,
  type Candidate,
  type CheckResult,
  type FailedResult,
  type WorkingResult,
} from '@/lib/playlist';

type ScanStatus = 'idle' | 'parsing' | 'checking' | 'done' | 'stopped';
type SortMode = 'max' | 'active' | 'expiry';
type ViewMode = 'm3u' | 'xtream';
type ContentType = 'live' | 'vod' | 'series';
type Category = { id: string; name: string };
type Stream = { id: string; name: string; extension: string };

type DetailState =
  | { kind: 'types' }
  | { kind: 'categories'; type: ContentType; categories: Category[] }
  | {
      kind: 'streams';
      type: ContentType;
      categoryName: string;
      categories: Category[];
      streams: Stream[];
    };

type WebMCPTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown;
};

declare global {
  interface Document {
    readonly modelContext?: {
      registerTool: (
        tool: WebMCPTool,
        options?: { signal?: AbortSignal },
      ) => void | Promise<void>;
    };
  }
}

const CHECK_CONCURRENCY = 8;
const example = `https://demo.example:8443 | username | password`;
const typeLabels: Record<ContentType, string> = {
  live: 'Live TV',
  vod: 'Movies',
  series: 'Series',
};

function message(
  title: string,
  type: 'success' | 'info' | 'warning' | 'error' = 'info',
) {
  toast.add({ title, type, timeout: 3_000 });
}

function safeNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function mixedContentBlocked(candidate: Candidate): boolean {
  return (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    candidate.host.startsWith('http://')
  );
}

async function fetchApi(
  candidate: Candidate,
  action?: string,
  parameters?: Record<string, string>,
) {
  if (mixedContentBlocked(candidate)) {
    throw new Error('HTTP endpoints cannot be checked from this secure page');
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(buildApiUrl(candidate, action, parameters), {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Server returned HTTP ${response.status}`);
    return await readJsonWithLimit(response);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function checkCandidate(
  candidate: Candidate,
  minimum: number,
  runSignal: AbortSignal,
): Promise<CheckResult | null> {
  if (mixedContentBlocked(candidate)) {
    return {
      ...candidate,
      status: 'failed',
      reason: 'HTTP endpoint blocked on a secure page',
    };
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );
  const abortRun = () => controller.abort();
  runSignal.addEventListener('abort', abortRun, { once: true });

  try {
    const response = await fetch(buildApiUrl(candidate), {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ...candidate,
        status: 'failed',
        reason: `Server returned HTTP ${response.status}`,
      };
    }

    const payload = await readJsonWithLimit(response);
    if (!payload || typeof payload !== 'object') {
      return {
        ...candidate,
        status: 'failed',
        reason: 'Unexpected server response',
      };
    }

    const userInfo = (payload as { user_info?: unknown }).user_info;
    if (!userInfo || typeof userInfo !== 'object') {
      return {
        ...candidate,
        status: 'failed',
        reason: 'Credentials were not accepted',
      };
    }

    const info = userInfo as Record<string, unknown>;
    const authenticated =
      (typeof info.auth === 'string' || typeof info.auth === 'number') &&
      String(info.auth) === '1';
    const activeStatus =
      typeof info.status === 'string' && info.status.toLowerCase() === 'active';
    if (!authenticated || !activeStatus) {
      return {
        ...candidate,
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
        ...candidate,
        status: 'failed',
        reason: `Max connections (${max}) is below ${minimum}`,
      };
    }

    const expirySeconds = safeNumber(info.exp_date);
    return {
      ...candidate,
      status: 'working',
      active: safeNumber(info.active_cons),
      max,
      expiry: expirySeconds > 0 ? expirySeconds * 1_000 : null,
    };
  } catch (error) {
    if (runSignal.aborted) return null;
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ...candidate, status: 'failed', reason: 'Request timed out' };
    }
    const reason =
      error instanceof Error && /response is too large/i.test(error.message)
        ? 'Server response exceeded the safety limit'
        : 'Network or CORS policy blocked the request';
    return { ...candidate, status: 'failed', reason };
  } finally {
    window.clearTimeout(timeout);
    runSignal.removeEventListener('abort', abortRun);
  }
}

function expiryLabel(expiry: number | null): { label: string; tone: string } {
  if (!expiry)
    return { label: 'No expiry', tone: 'bg-emerald-50 text-emerald-700' };
  const days = Math.ceil((expiry - Date.now()) / 86_400_000);
  if (days < 0) return { label: 'Expired', tone: 'bg-rose-50 text-rose-700' };
  if (days < 7)
    return { label: `${days}d left`, tone: 'bg-rose-50 text-rose-700' };
  if (days < 30)
    return { label: `${days}d left`, tone: 'bg-amber-50 text-amber-700' };
  return { label: `${days}d left`, tone: 'bg-teal-50 text-teal-700' };
}

function asRecordArray(payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload))
    throw new Error('The server returned an invalid list');
  return payload
    .slice(0, 2_500)
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object',
    );
}

export default function Home() {
  const [input, setInput] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [minimum, setMinimum] = useState('1');
  const [status, setStatus] = useState<ScanStatus>('idle');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [results, setResults] = useState<CheckResult[]>([]);
  const [showInput, setShowInput] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('m3u');
  const [sortMode, setSortMode] = useState<SortMode>('max');
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [failedOpen, setFailedOpen] = useState(false);
  const [selected, setSelected] = useState<WorkingResult | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: 'types' });
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const runControllerRef = useRef<AbortController | null>(null);

  const working = useMemo(
    () =>
      results.filter(
        (result): result is WorkingResult => result.status === 'working',
      ),
    [results],
  );
  const failed = useMemo(
    () =>
      results.filter(
        (result): result is FailedResult => result.status === 'failed',
      ),
    [results],
  );
  const sortedWorking = useMemo(() => {
    return [...working].sort((left, right) => {
      if (sortMode === 'active') return right.active - left.active;
      if (sortMode === 'expiry')
        return (
          (left.expiry ?? Number.MAX_SAFE_INTEGER) -
          (right.expiry ?? Number.MAX_SAFE_INTEGER)
        );
      return (
        (right.max ?? Number.MAX_SAFE_INTEGER) -
        (left.max ?? Number.MAX_SAFE_INTEGER)
      );
    });
  }, [sortMode, working]);
  const isRunning = status === 'parsing' || status === 'checking';
  const percent = progress.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();

    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: 'stage_playlist_text',
            title: 'Stage playlist text',
            description:
              'Place user-provided playlist credential text into the scanner and report how many safe, unique candidates were detected. This does not start network checks.',
            inputSchema: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  minLength: 1,
                  maxLength: MAX_INPUT_BYTES,
                },
              },
              required: ['text'],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: true },
            execute(rawInput) {
              if (!rawInput || typeof rawInput !== 'object')
                throw new Error('Input must be an object');
              const text = (rawInput as { text?: unknown }).text;
              if (
                typeof text !== 'string' ||
                !text.trim() ||
                text.length > MAX_INPUT_BYTES
              ) {
                throw new Error('Text must contain 1 to 2,000,000 characters');
              }
              const detected = parsePlaylistText(text).length;
              setInput(text);
              setFileName(null);
              setShowInput(true);
              return {
                detectedCandidates: detected,
                networkChecksStarted: false,
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => undefined);
    } catch {
      // WebMCP is optional; the visible scanner remains fully functional.
    }

    return () => lifecycle.abort();
  }, []);

  useEffect(() => () => runControllerRef.current?.abort(), []);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    const extensionOk = file.name.toLowerCase().endsWith('.txt');
    const typeOk = !file.type || file.type === 'text/plain';
    if (!extensionOk || !typeOk) {
      message('Choose a plain .txt file', 'error');
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      message('That file is larger than the 2 MB safety limit', 'error');
      return;
    }
    try {
      const text = await file.text();
      setInput(text.slice(0, MAX_INPUT_BYTES));
      setFileName(file.name);
      setShowInput(true);
      message(`${file.name} loaded locally`, 'success');
    } catch {
      message('The file could not be read', 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function startScan() {
    if (!input.trim()) {
      message('Paste credentials or choose a .txt file first', 'warning');
      return;
    }
    if (input.length > MAX_INPUT_BYTES) {
      message('Input is larger than the 2 MB safety limit', 'error');
      return;
    }

    runControllerRef.current?.abort();
    setStatus('parsing');
    setResults([]);
    setSelected(null);
    setDetail({ kind: 'types' });
    setProgress({ completed: 0, total: 0 });
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));

    const candidates = parsePlaylistText(input);
    if (!candidates.length) {
      setStatus('idle');
      message('No supported playlist credentials were detected', 'error');
      return;
    }

    const controller = new AbortController();
    runControllerRef.current = controller;
    setProgress({ completed: 0, total: candidates.length });
    setStatus('checking');

    let nextIndex = 0;
    let completed = 0;
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= candidates.length) return;
        const result = await checkCandidate(
          candidates[index],
          Number(minimum),
          controller.signal,
        );
        if (result && !controller.signal.aborted)
          setResults((current) => [...current, result]);
        completed += 1;
        if (!controller.signal.aborted)
          setProgress({ completed, total: candidates.length });
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(CHECK_CONCURRENCY, candidates.length) },
        () => worker(),
      ),
    );
    if (runControllerRef.current !== controller) return;
    setShowInput(false);
    setStatus(controller.signal.aborted ? 'stopped' : 'done');
    runControllerRef.current = null;
    if (!controller.signal.aborted)
      message('Playlist check complete', 'success');
  }

  function stopScan() {
    runControllerRef.current?.abort();
    setStatus('stopped');
    setShowInput(false);
    message('Checking stopped; gathered results are shown', 'warning');
  }

  function resetAll() {
    runControllerRef.current?.abort();
    runControllerRef.current = null;
    setInput('');
    setFileName(null);
    setResults([]);
    setProgress({ completed: 0, total: 0 });
    setStatus('idle');
    setShowInput(true);
    setSelected(null);
    setDetail({ kind: 'types' });
    setDetailError(null);
  }

  async function copyText(value: string, label = 'Copied') {
    try {
      await navigator.clipboard.writeText(value);
      message(label, 'success');
    } catch {
      message('Clipboard access was unavailable', 'error');
    }
  }

  function exportCsv() {
    if (!working.length) {
      message('There are no working playlists to export', 'warning');
      return;
    }
    const rows = [
      [
        'Host',
        'Username',
        'Password',
        'Active Connections',
        'Max Connections',
        'Expiry Date',
      ],
      ...working.map((item) => [
        item.host,
        item.user,
        item.pass,
        item.active,
        item.max ?? 'Unlimited',
        item.expiry
          ? new Date(item.expiry).toISOString().slice(0, 10)
          : 'Unlimited',
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'working-playlists.csv';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function openDetails(item: WorkingResult) {
    setSelected(item);
    setDetail({ kind: 'types' });
    setDetailError(null);
  }

  async function loadCategories(type: ContentType) {
    if (!selected) return;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const action =
        type === 'live'
          ? 'get_live_categories'
          : type === 'vod'
            ? 'get_vod_categories'
            : 'get_series_categories';
      const records = asRecordArray(await fetchApi(selected, action));
      const categories = records
        .map((item) => ({
          id:
            typeof item.category_id === 'string' ||
            typeof item.category_id === 'number'
              ? String(item.category_id)
              : '',
          name:
            typeof item.category_name === 'string'
              ? item.category_name.trim()
              : '',
        }))
        .filter((item) => item.id && item.name)
        .slice(0, 1_000);
      if (!categories.length) throw new Error('No categories were returned');
      setDetail({ kind: 'categories', type, categories });
    } catch (error) {
      setDetailError(
        error instanceof Error
          ? error.message
          : 'Categories could not be loaded',
      );
    } finally {
      setDetailLoading(false);
    }
  }

  async function loadStreams(
    type: ContentType,
    category: Category,
    categories: Category[],
  ) {
    if (!selected) return;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const action =
        type === 'live'
          ? 'get_live_streams'
          : type === 'vod'
            ? 'get_vod_streams'
            : 'get_series';
      const records = asRecordArray(
        await fetchApi(selected, action, { category_id: category.id }),
      );
      const streams = records
        .map((item) => {
          const rawId = item.stream_id ?? item.series_id;
          const rawExtension = item.container_extension;
          return {
            id:
              typeof rawId === 'string' || typeof rawId === 'number'
                ? String(rawId)
                : '',
            name: typeof item.name === 'string' ? item.name.trim() : '',
            extension:
              (typeof rawExtension === 'string'
                ? rawExtension.replace(/[^a-zA-Z0-9]/g, '')
                : '') || 'mp4',
          };
        })
        .filter((item) => item.id && item.name)
        .slice(0, 2_500);
      if (!streams.length)
        throw new Error('No content was returned for this category');
      setDetail({
        kind: 'streams',
        type,
        categoryName: category.name,
        categories,
        streams,
      });
    } catch (error) {
      setDetailError(
        error instanceof Error ? error.message : 'Content could not be loaded',
      );
    } finally {
      setDetailLoading(false);
    }
  }

  function detailBack() {
    setDetailError(null);
    if (detail.kind === 'streams') {
      setDetail({
        kind: 'categories',
        type: detail.type,
        categories: detail.categories,
      });
    } else {
      setDetail({ kind: 'types' });
    }
  }

  function streamCopyValue(stream: Stream, type: ContentType): string {
    if (!selected || type === 'series') return stream.name;
    const route = type === 'live' ? 'live' : 'movie';
    const extension = type === 'live' ? 'ts' : stream.extension;
    const url = new URL(
      `/${route}/${encodeURIComponent(selected.user)}/${encodeURIComponent(selected.pass)}/${encodeURIComponent(stream.id)}.${extension}`,
      `${selected.host}/`,
    );
    return url.toString();
  }

  return (
    <Toaster>
      <main className="mx-auto min-h-screen w-full max-w-[1520px] px-4 py-5 sm:px-7 sm:py-8">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-[#102a3d] text-teal-300 shadow-lg shadow-slate-900/15">
              <RadioTower className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-[-0.03em] sm:text-2xl">
                M3U Playlist Scanner
              </h1>
              <p className="text-sm text-muted-foreground">
                Private, browser-based playlist checks
              </p>
            </div>
          </div>
          <div className="flex w-fit items-center gap-2 rounded-full border bg-white/75 px-3 py-1.5 text-sm text-slate-600 shadow-sm backdrop-blur">
            <ShieldCheck className="size-4 text-teal-600" aria-hidden="true" />
            Files stay on this device
          </div>
        </header>

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(390px,.85fr)]">
          <section className="surface-shadow overflow-hidden rounded-[1.6rem] border bg-card/95">
            {showInput && (
              <div className="p-5 sm:p-7 lg:p-9">
                <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">
                      Source
                    </p>
                    <h2 className="text-2xl font-semibold tracking-[-0.035em]">
                      Add playlist credentials
                    </h2>
                  </div>
                  <span className="rounded-full bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-700">
                    Auto-detect
                  </span>
                </div>

                <Textarea
                  value={input}
                  onChange={(event) => {
                    setInput(event.target.value.slice(0, MAX_INPUT_BYTES));
                    setFileName(null);
                  }}
                  disabled={isRunning}
                  maxLength={MAX_INPUT_BYTES}
                  placeholder={`Paste one or more entries…\n\n${example}\nHOST: https://demo.example  USER: username  PASS: password`}
                  aria-label="Playlist credentials"
                  className="min-h-72 resize-y rounded-2xl border-slate-200 bg-slate-950 p-4 font-mono text-[0.9rem] leading-6 text-slate-100 caret-teal-300 shadow-inner placeholder:text-slate-500 focus-visible:border-teal-500 focus-visible:ring-teal-500/25 disabled:bg-slate-950"
                />

                <div className="mt-3 flex min-h-6 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {fileName
                      ? `Loaded: ${fileName}`
                      : 'Supports M3U, CSV, JSON-like logs, labeled fields, and host/user/pass rows.'}
                  </span>
                  <span>
                    {input.length.toLocaleString()} /{' '}
                    {MAX_INPUT_BYTES.toLocaleString()} characters
                  </span>
                </div>

                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,text/plain"
                  className="sr-only"
                  onChange={(event) =>
                    void handleFile(event.currentTarget.files?.[0])
                  }
                />
                <div className="mt-5 flex flex-wrap items-end gap-3">
                  <div>
                    <label
                      htmlFor="minimum-connections"
                      className="mb-2 block text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                    >
                      Minimum connections
                    </label>
                    <Select
                      value={minimum}
                      onValueChange={(value) => setMinimum(String(value))}
                      disabled={isRunning}
                    >
                      <SelectTrigger
                        id="minimum-connections"
                        className="h-11 min-w-44 bg-white px-3"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {['1', '2', '3', '4', '5', '10', '50'].map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}+ connections
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {!isRunning ? (
                    <Button
                      onClick={() => void startScan()}
                      className="h-11 rounded-xl bg-[#102a3d] px-5 text-white hover:bg-[#183c54]"
                    >
                      <RadioTower data-icon="inline-start" />
                      Check playlists
                    </Button>
                  ) : (
                    <Button
                      onClick={stopScan}
                      variant="destructive"
                      className="h-11 rounded-xl px-5"
                    >
                      <Pause data-icon="inline-start" />
                      Stop checking
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className="h-11 rounded-xl bg-white px-4"
                    disabled={isRunning}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Upload data-icon="inline-start" />
                    Choose .txt file
                  </Button>
                  {input && !isRunning && (
                    <Button
                      variant="ghost"
                      className="h-11"
                      onClick={() => {
                        setInput('');
                        setFileName(null);
                      }}
                    >
                      Clear text
                    </Button>
                  )}
                </div>
              </div>
            )}

            {isRunning && (
              <div className="border-t bg-slate-50/90 px-5 py-5 sm:px-7 lg:px-9">
                <Progress value={percent} className="gap-2">
                  <ProgressLabel className="flex items-center gap-2 text-sm">
                    <LoaderCircle
                      className="size-4 animate-spin text-teal-600"
                      aria-hidden="true"
                    />
                    {status === 'parsing'
                      ? 'Finding playlist credentials…'
                      : 'Checking authorized services…'}
                  </ProgressLabel>
                  <ProgressValue>
                    {() =>
                      status === 'parsing'
                        ? 'Preparing'
                        : `${progress.completed} / ${progress.total}`
                    }
                  </ProgressValue>
                </Progress>
              </div>
            )}

            {(results.length > 0 ||
              status === 'done' ||
              status === 'stopped') && (
              <div
                className={
                  showInput ? 'border-t p-5 sm:p-7 lg:p-9' : 'p-5 sm:p-7 lg:p-9'
                }
              >
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-700">
                        Results
                      </p>
                      <h2 className="text-2xl font-semibold tracking-[-0.035em]">
                        Working playlists
                      </h2>
                    </div>
                    <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-sm font-bold text-emerald-700">
                      {working.length}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowInput((current) => !current)}
                    >
                      <FileText data-icon="inline-start" />
                      {showInput ? 'Hide input' : 'Edit input'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFailedOpen(true)}
                    >
                      <CircleAlert data-icon="inline-start" />
                      Failed {failed.length}
                    </Button>
                    <Button variant="outline" size="sm" onClick={exportCsv}>
                      <Download data-icon="inline-start" />
                      CSV
                    </Button>
                    <Button variant="ghost" size="sm" onClick={resetAll}>
                      <RefreshCw data-icon="inline-start" />
                      Start over
                    </Button>
                  </div>
                </div>

                <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border bg-slate-50 p-2.5">
                  <ListFilter
                    className="ml-1 size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Select
                    value={sortMode}
                    onValueChange={(value) => setSortMode(value as SortMode)}
                  >
                    <SelectTrigger size="sm" className="min-w-36 bg-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="max">Max connections</SelectItem>
                      <SelectItem value="active">Active connections</SelectItem>
                      <SelectItem value="expiry">Expiry date</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="ml-auto flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setViewMode((current) =>
                          current === 'm3u' ? 'xtream' : 'm3u',
                        )
                      }
                    >
                      {viewMode === 'm3u'
                        ? 'Show Xtream fields'
                        : 'Show M3U links'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevealSecrets((current) => !current)}
                    >
                      {revealSecrets ? (
                        <EyeOff data-icon="inline-start" />
                      ) : (
                        <Eye data-icon="inline-start" />
                      )}
                      {revealSecrets ? 'Mask passwords' : 'Reveal passwords'}
                    </Button>
                  </div>
                </div>

                <div className="thin-scrollbar max-h-[660px] space-y-3 overflow-y-auto pr-1">
                  {sortedWorking.length ? (
                    sortedWorking.map((item) => {
                      const expiry = expiryLabel(item.expiry);
                      const isSelected = selected?.id === item.id;
                      return (
                        <article
                          key={item.id}
                          className={`group rounded-2xl border p-4 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-teal-300 hover:shadow-md ${isSelected ? 'border-teal-400 bg-teal-50/45 ring-2 ring-teal-500/10' : 'bg-white'}`}
                        >
                          {viewMode === 'm3u' ? (
                            <button
                              type="button"
                              className="w-full text-left"
                              onClick={() => openDetails(item)}
                            >
                              <span className="block break-all rounded-xl bg-slate-950 px-3 py-2.5 font-mono text-xs leading-5 text-slate-200">
                                {revealSecrets
                                  ? buildM3uUrl(item)
                                  : maskM3uUrl(item)}
                              </span>
                            </button>
                          ) : (
                            <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 text-sm">
                              <span className="text-right text-xs font-semibold text-muted-foreground">
                                Host
                              </span>
                              <button
                                type="button"
                                className="truncate rounded-lg bg-slate-100 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-teal-50"
                                onClick={() =>
                                  void copyText(item.host, 'Host copied')
                                }
                              >
                                {item.host}
                              </button>
                              <Clipboard
                                className="size-3.5 text-slate-400"
                                aria-hidden="true"
                              />
                              <span className="text-right text-xs font-semibold text-muted-foreground">
                                User
                              </span>
                              <button
                                type="button"
                                className="truncate rounded-lg bg-slate-100 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-teal-50"
                                onClick={() =>
                                  void copyText(item.user, 'Username copied')
                                }
                              >
                                {item.user}
                              </button>
                              <Clipboard
                                className="size-3.5 text-slate-400"
                                aria-hidden="true"
                              />
                              <span className="text-right text-xs font-semibold text-muted-foreground">
                                Pass
                              </span>
                              <button
                                type="button"
                                className="truncate rounded-lg bg-slate-100 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-teal-50"
                                onClick={() =>
                                  void copyText(item.pass, 'Password copied')
                                }
                              >
                                {revealSecrets ? item.pass : '••••••••'}
                              </button>
                              <Clipboard
                                className="size-3.5 text-slate-400"
                                aria-hidden="true"
                              />
                            </div>
                          )}

                          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
                            <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">
                              {item.active} active
                            </span>
                            <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">
                              {item.max ?? 'Unlimited'} max
                            </span>
                            <span
                              className={`rounded-full px-2.5 py-1 font-semibold ${expiry.tone}`}
                            >
                              {expiry.label}
                            </span>
                            <div className="ml-auto flex gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  void copyText(
                                    buildM3uUrl(item),
                                    'M3U URL copied',
                                  )
                                }
                              >
                                <Clipboard data-icon="inline-start" /> Copy URL
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openDetails(item)}
                              >
                                Browse <ChevronRight data-icon="inline-end" />
                              </Button>
                            </div>
                          </div>
                        </article>
                      );
                    })
                  ) : (
                    <div className="rounded-2xl border border-dashed bg-slate-50 px-5 py-12 text-center">
                      <CircleAlert
                        className="mx-auto mb-3 size-6 text-slate-400"
                        aria-hidden="true"
                      />
                      <p className="font-medium text-slate-700">
                        No working playlists matched this check.
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Review failed items for network, CORS, credential, or
                        minimum-connection details.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          <aside className="surface-shadow overflow-hidden rounded-[1.6rem] border bg-[#102a3d] text-slate-100 xl:sticky xl:top-8">
            {selected ? (
              <div className="flex min-h-[520px] flex-col">
                <div className="border-b border-white/10 p-5 sm:p-7">
                  <div className="flex items-start gap-3">
                    {detail.kind !== 'types' && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="mt-0.5 text-slate-300 hover:bg-white/10 hover:text-white"
                        onClick={detailBack}
                        aria-label="Back"
                      >
                        <ArrowLeft />
                      </Button>
                    )}
                    <div className="min-w-0">
                      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-teal-300">
                        Playlist content
                      </p>
                      <h2 className="truncate text-xl font-semibold tracking-[-0.03em]">
                        {detail.kind === 'types'
                          ? 'Choose a library'
                          : detail.kind === 'categories'
                            ? typeLabels[detail.type]
                            : detail.categoryName}
                      </h2>
                      <p className="mt-1 truncate font-mono text-xs text-slate-400">
                        {selected.host}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="thin-scrollbar max-h-[calc(100vh-13rem)] flex-1 overflow-y-auto p-5 sm:p-7">
                  {detailLoading ? (
                    <div className="grid min-h-64 place-items-center text-center">
                      <div>
                        <LoaderCircle
                          className="mx-auto mb-3 size-7 animate-spin text-teal-300"
                          aria-hidden="true"
                        />
                        <p className="text-sm text-slate-300">
                          Loading from the selected service…
                        </p>
                      </div>
                    </div>
                  ) : detailError ? (
                    <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm leading-6 text-amber-50">
                      <div className="flex gap-3">
                        <CircleAlert
                          className="mt-0.5 size-5 shrink-0 text-amber-300"
                          aria-hidden="true"
                        />
                        <p>{detailError}</p>
                      </div>
                    </div>
                  ) : detail.kind === 'types' ? (
                    <div className="space-y-3">
                      {(
                        [
                          ['live', 'Live TV', Tv, 'Browse live channels'],
                          ['vod', 'Movies', Film, 'Browse movie categories'],
                          [
                            'series',
                            'Series',
                            RadioTower,
                            'Browse series categories',
                          ],
                        ] as const
                      ).map(([type, label, Icon, description]) => (
                        <button
                          key={type}
                          type="button"
                          onClick={() => void loadCategories(type)}
                          className="flex w-full items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-4 text-left transition hover:border-teal-300/50 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-teal-300"
                        >
                          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-teal-300/10 text-teal-300">
                            <Icon className="size-5" aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold">{label}</span>
                            <span className="mt-0.5 block text-sm text-slate-400">
                              {description}
                            </span>
                          </span>
                          <ChevronRight
                            className="size-5 text-slate-500"
                            aria-hidden="true"
                          />
                        </button>
                      ))}
                    </div>
                  ) : detail.kind === 'categories' ? (
                    <div className="space-y-1">
                      {detail.categories.map((category) => (
                        <button
                          key={category.id}
                          type="button"
                          onClick={() =>
                            void loadStreams(
                              detail.type,
                              category,
                              detail.categories,
                            )
                          }
                          className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-slate-200 transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-teal-300"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {category.name}
                          </span>
                          <ChevronRight
                            className="size-4 text-slate-500"
                            aria-hidden="true"
                          />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {detail.streams.map((stream) => (
                        <button
                          key={`${stream.id}-${stream.name}`}
                          type="button"
                          onClick={() =>
                            void copyText(
                              streamCopyValue(stream, detail.type),
                              detail.type === 'series'
                                ? 'Series title copied'
                                : 'Stream URL copied',
                            )
                          }
                          className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-slate-200 transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-teal-300"
                        >
                          <Clipboard
                            className="size-4 shrink-0 text-teal-300"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {stream.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-5 sm:p-7 lg:p-9">
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-teal-300">
                  Safe by design
                </p>
                <h2 className="text-2xl font-semibold tracking-[-0.035em]">
                  Your data stays in the browser
                </h2>
                <p className="mt-3 text-[0.95rem] leading-6 text-slate-300">
                  Pasted text and selected files are not uploaded or saved.
                  Checks go directly to each public host you provide, subject to
                  that host’s CORS policy.
                </p>

                <div className="mt-8 grid grid-cols-3 gap-2">
                  {[
                    [working.length, 'Working'],
                    [failed.length, 'Failed'],
                    [progress.total, 'Detected'],
                  ].map(([value, label]) => (
                    <div
                      key={label}
                      className="rounded-2xl border border-white/10 bg-white/5 p-3 text-center"
                    >
                      <div className="text-2xl font-semibold text-white">
                        {value}
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{label}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-6 space-y-3">
                  {[
                    [
                      'No HTML injection',
                      'All playlist and API values render as escaped text.',
                    ],
                    [
                      'Bounded work',
                      `Files are capped at 2 MB and each run at ${MAX_CANDIDATES} unique entries.`,
                    ],
                    [
                      'Public hosts only',
                      'Localhost and private-network destinations are rejected.',
                    ],
                    [
                      'Secrets masked',
                      'Passwords remain hidden until you choose to reveal or copy them.',
                    ],
                  ].map(([title, description]) => (
                    <div
                      key={title}
                      className="flex gap-3 rounded-2xl bg-white/5 p-3.5"
                    >
                      <Check
                        className="mt-0.5 size-4 shrink-0 text-teal-300"
                        aria-hidden="true"
                      />
                      <div>
                        <p className="text-sm font-semibold text-slate-100">
                          {title}
                        </p>
                        <p className="mt-0.5 text-xs leading-5 text-slate-400">
                          {description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>

        <p className="mx-auto mt-5 max-w-3xl text-center text-xs leading-5 text-muted-foreground">
          Only check playlists and services you own or are authorized to access.
          HTTP-only services cannot be reached from a secure HTTPS page; no
          relay or proxy is used.
        </p>

        <Dialog open={failedOpen} onOpenChange={setFailedOpen}>
          <DialogContent className="max-h-[82vh] max-w-2xl overflow-hidden p-0">
            <DialogHeader className="border-b px-5 py-5 pr-12">
              <DialogTitle className="text-lg">Failed playlists</DialogTitle>
              <DialogDescription>
                Network, policy, credential, and connection-limit failures from
                this run.
              </DialogDescription>
            </DialogHeader>
            <div className="thin-scrollbar max-h-[62vh] space-y-2 overflow-y-auto p-4">
              {failed.length ? (
                failed.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-xl border bg-slate-50 p-3.5 text-sm"
                  >
                    <p className="break-all font-mono text-xs text-slate-700">
                      {item.host}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-slate-500">
                        User:{' '}
                        <span className="font-mono text-slate-700">
                          {item.user}
                        </span>
                      </span>
                      <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700">
                        {item.reason}
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  No failed playlists in this run.
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </main>
    </Toaster>
  );
}
