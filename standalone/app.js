(() => {
  'use strict';

  const MAX_INPUT_BYTES = 2_000_000;
  const MAX_CANDIDATES = 500;
  const MAX_API_BYTES = 1_000_000;
  const REQUEST_TIMEOUT_MS = 8_000;
  const CHECK_CONCURRENCY = 8;
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

  const elements = {
    clearButton: document.querySelector('#clear-button'),
    characterCount: document.querySelector('#character-count'),
    detectedCount: document.querySelector('#detected-count'),
    downloadButton: document.querySelector('#download-button'),
    dropZone: document.querySelector('#drop-zone'),
    failedCount: document.querySelector('#failed-count'),
    failedTab: document.querySelector('#failed-tab'),
    fileInput: document.querySelector('#file-input'),
    fileStatus: document.querySelector('#file-status'),
    minimumInput: document.querySelector('#minimum-input'),
    notice: document.querySelector('#notice'),
    progressBar: document.querySelector('#progress-bar'),
    progressCount: document.querySelector('#progress-count'),
    progressLabel: document.querySelector('#progress-label'),
    progressRegion: document.querySelector('#progress-region'),
    resultList: document.querySelector('#result-list'),
    results: document.querySelector('#results'),
    scanButton: document.querySelector('#scan-button'),
    sourceInput: document.querySelector('#source-input'),
    workingCount: document.querySelector('#working-count'),
    workingTab: document.querySelector('#working-tab'),
  };

  const state = {
    failed: [],
    isChecking: false,
    runController: null,
    selectedTab: 'working',
    working: [],
  };

  function textElement(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = String(value);
    return element;
  }

  function primitiveString(value) {
    return ['string', 'number', 'boolean', 'bigint'].includes(typeof value)
      ? String(value)
      : '';
  }

  function containsControlCharacters(value) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 31 || code === 127) return true;
    }
    return false;
  }

  function cleanValue(value) {
    return primitiveString(value)
      .normalize('NFKC')
      .trim()
      .replace(/^[\s"'`{[(<]+|[\s"'`}\])>,;]+$/g, '');
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function isBlockedHostname(hostname) {
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

  function normalizeHost(rawHost) {
    const cleaned = cleanValue(rawHost).replace(/\/+$/, '');
    if (
      !cleaned ||
      cleaned.length > 500 ||
      containsControlCharacters(cleaned)
    ) {
      return null;
    }

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

  function normalizeCandidate(hostValue, userValue, passValue) {
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

  function parseCsvLine(line) {
    const values = [];
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

  function findField(record, names) {
    const entry = Object.entries(record).find(([key]) =>
      names.includes(key.toLowerCase().replace(/[^a-z]/g, '')),
    );
    return cleanValue(entry ? entry[1] : '');
  }

  function parsePlaylistText(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const boundedText = text.slice(0, MAX_INPUT_BYTES);
    const lines = boundedText.split(/\r?\n/, 50_000);
    const candidates = new Map();
    let lastHost = null;

    const addCandidate = (hostValue, userValue, passValue) => {
      if (candidates.size >= MAX_CANDIDATES) return;
      const candidate = normalizeCandidate(hostValue, userValue, passValue);
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

      const urls = line.match(/https?:\/\/[^\s"'<>]+/gi) || [];
      for (const rawUrl of urls) {
        try {
          const parsed = new URL(rawUrl.replace(/[),.;]+$/, ''));
          const user =
            parsed.searchParams.get('username') ||
            parsed.searchParams.get('user');
          const pass =
            parsed.searchParams.get('password') ||
            parsed.searchParams.get('pass');
          if (user && pass) addCandidate(parsed.origin, user, pass);
        } catch {
          // Ignore malformed URL-shaped text.
        }
      }

      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          const record = JSON.parse(line);
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
      if (userMatch && passMatch && ((hostMatch && hostMatch[1]) || lastHost)) {
        addCandidate(
          (hostMatch && hostMatch[1]) || lastHost || '',
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
        if (/^https?:\/\//i.test(parts[0])) {
          addCandidate(parts[0], parts[1], parts[2]);
        } else if (/^https?:\/\//i.test(parts[2])) {
          addCandidate(parts[2], parts[0], parts[1]);
        }
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
        const withoutHost = line
          .replace((hostMatch && hostMatch[1]) || '', ' ')
          .trim();
        const combo = withoutHost.match(
          /^([\w.@-]{1,256})\s*[:|]\s*([^\s|]{1,256})$/,
        );
        if (combo && !/^https?$/i.test(combo[1])) {
          addCandidate(lastHost, combo[1], combo[2]);
        }

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

  function buildApiUrl(candidate) {
    const url = new URL('/player_api.php', `${candidate.host}/`);
    url.searchParams.set('username', candidate.user);
    url.searchParams.set('password', candidate.pass);
    return url.toString();
  }

  function buildM3uUrl(candidate) {
    const url = new URL('/get.php', `${candidate.host}/`);
    url.searchParams.set('username', candidate.user);
    url.searchParams.set('password', candidate.pass);
    url.searchParams.set('type', 'm3u_plus');
    url.searchParams.set('output', 'ts');
    return url.toString();
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function evaluatePayload(payload, minimum) {
    if (!payload || typeof payload !== 'object') {
      return { status: 'failed', reason: 'Unexpected server response' };
    }

    const userInfo = payload.user_info;
    if (!userInfo || typeof userInfo !== 'object') {
      return { status: 'failed', reason: 'Credentials were not accepted' };
    }

    const authenticated =
      ['string', 'number'].includes(typeof userInfo.auth) &&
      String(userInfo.auth) === '1';
    const activeStatus =
      typeof userInfo.status === 'string' &&
      userInfo.status.toLowerCase() === 'active';
    if (!authenticated || !activeStatus) {
      return {
        status: 'failed',
        reason: 'Invalid, inactive, or expired credentials',
      };
    }

    const max =
      userInfo.max_connections === null || userInfo.max_connections === ''
        ? null
        : safeNumber(userInfo.max_connections);
    if (max !== null && max < minimum) {
      return {
        status: 'failed',
        reason: `Max connections (${max}) is below ${minimum}`,
      };
    }

    const expirySeconds = safeNumber(userInfo.exp_date);
    return {
      status: 'working',
      active: safeNumber(userInfo.active_cons),
      max,
      expiry: expirySeconds > 0 ? expirySeconds * 1_000 : null,
    };
  }

  async function readJsonWithLimit(response) {
    if (!response.body) return response.json();
    const reader = response.body.getReader();
    const chunks = [];
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

  async function checkCandidate(candidate, minimum, runSignal) {
    if (
      window.location.protocol === 'https:' &&
      candidate.host.startsWith('http://')
    ) {
      return {
        ...candidate,
        status: 'failed',
        reason:
          'HTTP endpoint blocked by the browser; use the private hosted checker',
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
      return {
        ...candidate,
        ...evaluatePayload(await readJsonWithLimit(response), minimum),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        if (runSignal.aborted) return null;
        return { ...candidate, status: 'failed', reason: 'Request timed out' };
      }
      return {
        ...candidate,
        status: 'failed',
        reason:
          error instanceof SyntaxError
            ? 'Server returned invalid JSON'
            : 'Browser blocked the response (CORS or network policy); use the private hosted checker',
      };
    } finally {
      window.clearTimeout(timeout);
      runSignal.removeEventListener('abort', abortRun);
    }
  }

  function setNotice(message, type = 'info') {
    elements.notice.textContent = message;
    elements.notice.className = `notice ${type}`;
    elements.notice.hidden = !message;
  }

  function updateCharacterCount() {
    elements.characterCount.textContent = `${elements.sourceInput.value.length.toLocaleString()} / ${MAX_INPUT_BYTES.toLocaleString()}`;
  }

  function updateCounts(detected) {
    elements.workingCount.textContent = String(state.working.length);
    elements.failedCount.textContent = String(state.failed.length);
    elements.detectedCount.textContent = String(detected);
    elements.workingTab.querySelector('span').textContent = String(
      state.working.length,
    );
    elements.failedTab.querySelector('span').textContent = String(
      state.failed.length,
    );
  }

  function formatExpiry(value) {
    if (!value) return 'No expiry';
    try {
      return new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date(value));
    } catch {
      return 'Unknown expiry';
    }
  }

  function makeMetric(label, value) {
    const metric = textElement('span', 'metric', '');
    const strong = textElement('strong', '', value);
    metric.append(strong, document.createTextNode(` ${label}`));
    return metric;
  }

  async function copyText(value) {
    if (!navigator.clipboard || !window.isSecureContext) {
      setNotice(
        'Clipboard access is unavailable here. Open the hosted checker to copy securely.',
        'warning',
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setNotice('Playlist URL copied to the clipboard.', 'success');
    } catch {
      setNotice('The browser did not allow clipboard access.', 'warning');
    }
  }

  function renderRow(result) {
    const row = document.createElement('article');
    row.className = `result-row ${result.status}`;

    const identity = document.createElement('div');
    identity.className = 'result-identity';
    const hostLine = document.createElement('div');
    hostLine.className = 'result-host';
    hostLine.append(
      textElement('span', 'status-dot', ''),
      textElement('span', 'truncate', result.host),
    );
    identity.append(hostLine);

    if (result.status === 'working') {
      const credentialLine = textElement(
        'div',
        'credential-line truncate',
        `${result.user}  •  ••••••••`,
      );
      identity.append(credentialLine);
    } else {
      identity.append(textElement('div', 'reason-line', result.reason));
    }

    const metrics = document.createElement('div');
    metrics.className = 'result-metrics';
    if (result.status === 'working') {
      metrics.append(
        makeMetric('active', result.active),
        makeMetric('max', result.max === null ? '—' : result.max),
        makeMetric('', formatExpiry(result.expiry)),
      );
    } else {
      metrics.append(makeMetric('', 'Not confirmed'));
    }

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (result.status === 'working') {
      const copyButton = textElement('button', '', 'Copy M3U');
      copyButton.type = 'button';
      copyButton.addEventListener('click', () => copyText(buildM3uUrl(result)));
      actions.append(copyButton);
    }

    row.append(identity, metrics, actions);
    return row;
  }

  function renderResults() {
    elements.resultList.replaceChildren();
    const values =
      state.selectedTab === 'working' ? state.working : state.failed;
    if (values.length === 0) {
      elements.resultList.append(
        textElement(
          'div',
          'empty-state',
          state.selectedTab === 'working'
            ? 'No working playlists have been confirmed in this run.'
            : 'No failed checks in this run.',
        ),
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const result of values) fragment.append(renderRow(result));
    elements.resultList.append(fragment);
  }

  function selectTab(tab) {
    state.selectedTab = tab;
    const showingWorking = tab === 'working';
    elements.workingTab.setAttribute('aria-selected', String(showingWorking));
    elements.failedTab.setAttribute('aria-selected', String(!showingWorking));
    renderResults();
  }

  function setChecking(checking) {
    state.isChecking = checking;
    elements.sourceInput.disabled = checking;
    elements.fileInput.disabled = checking;
    elements.minimumInput.disabled = checking;
    elements.scanButton.querySelector('span').textContent = checking
      ? 'Stop checking'
      : 'Check playlists';
  }

  function updateProgress(completed, total) {
    elements.progressRegion.hidden = false;
    elements.progressCount.textContent = `${completed} / ${total}`;
    elements.progressBar.style.width = `${total ? (completed / total) * 100 : 0}%`;
  }

  async function scan() {
    if (state.isChecking) {
      state.runController.abort();
      return;
    }

    const candidates = parsePlaylistText(elements.sourceInput.value);
    if (candidates.length === 0) {
      setNotice(
        'No valid host, username, and password combinations were detected.',
        'error',
      );
      return;
    }

    const minimum = Math.max(
      0,
      Math.min(9999, Number(elements.minimumInput.value) || 0),
    );
    state.working = [];
    state.failed = [];
    state.selectedTab = 'working';
    state.runController = new AbortController();
    elements.results.hidden = false;
    elements.progressLabel.textContent = 'Checking authorized services…';
    elements.downloadButton.disabled = true;
    setNotice('', 'info');
    setChecking(true);
    updateCounts(candidates.length);
    updateProgress(0, candidates.length);
    selectTab('working');

    let nextIndex = 0;
    let completed = 0;
    const worker = async () => {
      while (
        nextIndex < candidates.length &&
        !state.runController.signal.aborted
      ) {
        const candidate = candidates[nextIndex];
        nextIndex += 1;
        const result = await checkCandidate(
          candidate,
          minimum,
          state.runController.signal,
        );
        if (!result) break;
        if (result.status === 'working') state.working.push(result);
        else state.failed.push(result);
        completed += 1;
        updateProgress(completed, candidates.length);
        updateCounts(candidates.length);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(CHECK_CONCURRENCY, candidates.length) },
        () => worker(),
      ),
    );

    const stopped = state.runController.signal.aborted;
    setChecking(false);
    elements.progressLabel.textContent = stopped
      ? 'Check stopped'
      : 'Check complete';
    elements.downloadButton.disabled = state.working.length === 0;
    renderResults();

    const policyFailures = state.failed.filter((result) =>
      /browser|CORS|network policy/i.test(result.reason),
    ).length;
    if (stopped) {
      setNotice(
        `Stopped after ${completed} of ${candidates.length} checks.`,
        'warning',
      );
    } else if (policyFailures > 0) {
      setNotice(
        `${state.working.length} working confirmed. ${policyFailures} checks were blocked by portable-browser security rules; those entries were not classified as inactive.`,
        'warning',
      );
    } else {
      setNotice(
        `${state.working.length} working and ${state.failed.length} failed checks.`,
        state.working.length ? 'success' : 'warning',
      );
    }
  }

  function csvCell(value) {
    let text = primitiveString(value);
    if (/^[=+@\t\r-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function downloadWorkingCsv() {
    if (state.working.length === 0) return;
    const rows = [
      ['host', 'username', 'password', 'active', 'max', 'expiry', 'm3u_url'],
      ...state.working.map((result) => [
        result.host,
        result.user,
        result.pass,
        result.active,
        result.max === null ? '' : result.max,
        result.expiry ? new Date(result.expiry).toISOString() : '',
        buildM3uUrl(result),
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'working-playlists.csv';
    link.rel = 'noopener';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  async function loadFile(file) {
    if (!file) return;
    if (file.size > MAX_INPUT_BYTES) {
      setNotice('That file is larger than the 2 MB limit.', 'error');
      return;
    }
    const isText =
      file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt');
    if (!isText) {
      setNotice('Choose a plain .txt file.', 'error');
      return;
    }

    try {
      const text = await file.text();
      elements.sourceInput.value = text.slice(0, MAX_INPUT_BYTES);
      elements.fileStatus.textContent = `Loaded locally: ${file.name}`;
      updateCharacterCount();
      setNotice(`${file.name} is ready to check.`, 'success');
    } catch {
      setNotice('The browser could not read that file.', 'error');
    } finally {
      elements.fileInput.value = '';
    }
  }

  function clearSession() {
    if (state.runController) state.runController.abort();
    state.working = [];
    state.failed = [];
    state.selectedTab = 'working';
    elements.sourceInput.value = '';
    elements.fileStatus.textContent = 'Supports .txt files up to 2 MB';
    elements.results.hidden = true;
    elements.progressRegion.hidden = true;
    elements.progressBar.style.width = '0%';
    elements.downloadButton.disabled = true;
    setNotice('', 'info');
    setChecking(false);
    updateCharacterCount();
    updateCounts(0);
    elements.sourceInput.focus();
  }

  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    if (
      !event.dataTransfer ||
      !Array.from(event.dataTransfer.types).includes('Files')
    )
      return;
    event.preventDefault();
    dragDepth += 1;
    elements.dropZone.classList.add('is-dragging');
  });
  window.addEventListener('dragover', (event) => {
    if (
      !event.dataTransfer ||
      !Array.from(event.dataTransfer.types).includes('Files')
    )
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (
      !event.dataTransfer ||
      !Array.from(event.dataTransfer.types).includes('Files')
    )
      return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) elements.dropZone.classList.remove('is-dragging');
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    elements.dropZone.classList.remove('is-dragging');
    const files = event.dataTransfer ? event.dataTransfer.files : null;
    if (files && files.length > 0) void loadFile(files[0]);
  });

  elements.sourceInput.addEventListener('input', () => {
    elements.fileStatus.textContent = 'Pasted text — kept in this browser';
    updateCharacterCount();
  });
  elements.fileInput.addEventListener('change', () => {
    void loadFile(elements.fileInput.files[0]);
  });
  elements.scanButton.addEventListener('click', scan);
  elements.downloadButton.addEventListener('click', downloadWorkingCsv);
  elements.clearButton.addEventListener('click', clearSession);
  elements.workingTab.addEventListener('click', () => selectTab('working'));
  elements.failedTab.addEventListener('click', () => selectTab('failed'));

  updateCharacterCount();
  updateCounts(0);
})();
