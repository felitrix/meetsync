// Smoke test real de uma build unpacked no Chrome/Edge via DevTools Protocol.
// Uso: node scripts/smoke-extension.mjs "<caminho-do-navegador>" [dist]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const browserPath = process.argv[2];
const extensionPath = resolve(process.argv[3] || 'dist');
if (!browserPath) throw new Error('Informe o caminho do Chrome ou Edge.');

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Não foi possível reservar uma porta local.'));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function pollJson(url, accept, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fetch(url).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
      if (await accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error(`Timeout consultando ${url}`);
}

async function evaluate(target, expression) {
  return new Promise((resolveValue, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const requestId = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timeout no DevTools Protocol.'));
    }, 10_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: requestId,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== requestId) return;
      clearTimeout(timer);
      socket.close();
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text || 'Falha ao avaliar a página.'));
        return;
      }
      resolveValue(message.result?.result?.value);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Falha ao conectar ao DevTools Protocol.'));
    });
  });
}

async function findMeetSyncTarget(base, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const targets = await fetch(`${base}/json/list`).then((response) => response.json()).catch(() => []);
    for (const target of targets) {
      if (!String(target.url).startsWith('chrome-extension://') || !target.webSocketDebuggerUrl) continue;
      try {
        const raw = await evaluate(target, 'JSON.stringify(chrome.runtime.getManifest())');
        const manifest = JSON.parse(raw);
        if (manifest.version === '0.4.8' && manifest.manifest_version === 3) {
          return { target, manifest };
        }
      } catch {
        // Navegadores incluem extensões internas; ignora e continua procurando o MeetSync.
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('O navegador não carregou o MeetSync dentro do prazo.');
}

const port = await freePort();
const profilePath = mkdtempSync(join(tmpdir(), 'meetsync-smoke-'));
const child = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profilePath}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

try {
  const base = `http://127.0.0.1:${port}`;
  await pollJson(`${base}/json/version`, (value) => Boolean(value.webSocketDebuggerUrl));
  const { target, manifest } = await findMeetSyncTarget(base);
  const extensionId = new URL(target.url).hostname;

  const optionsUrl = `chrome-extension://${extensionId}/${manifest.options_ui.page}`;
  await fetch(`${base}/json/new?${encodeURIComponent(optionsUrl)}`, { method: 'PUT' });
  const optionsTargets = await pollJson(
    `${base}/json/list`,
    (value) => Array.isArray(value) && value.some((item) => item.url === optionsUrl),
    15_000,
  );
  const optionsTarget = optionsTargets.find((item) => item.url === optionsUrl);
  const optionsReady = await pollJson(
    `${base}/json/list`,
    async () => Boolean(await evaluate(optionsTarget, "document.body.dataset.optionsReady === 'true'")),
    15_000,
  ).catch(() => false);
  if (!optionsReady) throw new Error('A página de configurações não ficou pronta.');
  const optionsPersistence = await evaluate(
    optionsTarget,
    `(async () => {
      const input = document.querySelector('[data-setting="selfName"]');
      if (!input) return false;
      input.value = 'MeetSync Smoke';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const saved = await chrome.storage.local.get('meetsync:settings');
      return saved['meetsync:settings']?.selfName === 'MeetSync Smoke';
    })()`,
  );
  if (!optionsPersistence) throw new Error('A página de configurações não persistiu a alteração.');

  const meetSmokeUrl = 'https://meet.google.com/abc-defg-hij';
  await fetch(`${base}/json/new?${encodeURIComponent(meetSmokeUrl)}`, { method: 'PUT' });
  const meetTargets = await pollJson(
    `${base}/json/list`,
    (value) => Array.isArray(value) && value.some((target) => String(target.url).startsWith('https://meet.google.com/')),
    20_000,
  );
  const meetTarget = meetTargets.find((target) => String(target.url).startsWith('https://meet.google.com/'));
  const hostMounted = await pollJson(
    `${base}/json/list`,
    async () => Boolean(await evaluate(meetTarget, "document.getElementById('meetsync-host')")),
    15_000,
  ).catch(() => false);

  if (!hostMounted) {
    const pageState = await evaluate(
      meetTarget,
      "JSON.stringify({ href: location.href, readyState: document.readyState, title: document.title, hasBody: Boolean(document.body) })",
    ).catch(() => '{}');
    throw new Error(`O content script não montou a interface no Google Meet. Página: ${pageState}`);
  }
  console.log(JSON.stringify({
    ok: true,
    browser: browserPath,
    manifestVersion: manifest.manifest_version,
    extensionVersion: manifest.version,
    minimumChromeVersion: manifest.minimum_chrome_version,
    permissions: manifest.permissions,
    contentScriptMounted: true,
    optionsPageReady: true,
    optionsPersistence: true,
  }));
} catch (error) {
  if (stderr) console.error(stderr.slice(-4_000));
  throw error;
} finally {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
    ]);
  }
  rmSync(profilePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
