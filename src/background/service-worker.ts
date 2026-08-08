// Service worker (MV3) — enxuto. Executa as chamadas HTTP ao Ollama em nome do content
// script (CORS/host permissions) e responde via mensagens.

import {
  handleOllamaAction,
  streamGenerate,
  STREAM_PORT,
  type OllamaAction,
  type StreamRequest,
} from '@/services/ollama-client';
import { loadSettings } from '@/services/storage-service';
import { t, setLocale, resolveLocale } from '@/i18n';
import {
  handleNvidiaRelayAction,
  type NvidiaRelayAction,
} from '@/services/nvidia-relay-client';

const MEETING_HOSTS = new Set([
  'meet.google.com',
  'teams.cloud.microsoft',
  'teams.microsoft.com',
]);
const MAX_URL_CHARS = 2_048;
const MAX_MODEL_CHARS = 300;
const MAX_PROMPT_CHARS = 2_000_000;
const MAX_NOTIFICATION_CHARS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Confirma que a mensagem veio do popup ou de um content script desta própria extensão. */
function isTrustedSender(sender?: chrome.runtime.MessageSender): boolean {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const rawUrl = sender.url ?? sender.tab?.url;
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'chrome-extension:') return url.hostname === chrome.runtime.id;
    return url.protocol === 'https:' && MEETING_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isMeetingSender(sender?: chrome.runtime.MessageSender): boolean {
  if (!isTrustedSender(sender)) return false;
  const rawUrl = sender?.url ?? sender?.tab?.url;
  try {
    const url = new URL(rawUrl ?? '');
    return url.protocol === 'https:' && MEETING_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isOllamaAction(message: unknown): message is OllamaAction {
  if (!isRecord(message) || typeof message.type !== 'string' || typeof message.url !== 'string') return false;
  if (message.url.length === 0 || message.url.length > MAX_URL_CHARS) return false;
  if (message.type === 'ollama:test' || message.type === 'ollama:tags') return true;
  return (
    message.type === 'ollama:generate' &&
    typeof message.model === 'string' &&
    message.model.length > 0 &&
    message.model.length <= MAX_MODEL_CHARS &&
    typeof message.prompt === 'string' &&
    message.prompt.length > 0 &&
    message.prompt.length <= MAX_PROMPT_CHARS
  );
}

function isStreamRequest(message: unknown): message is StreamRequest {
  return (
    isRecord(message) &&
    typeof message.url === 'string' &&
    message.url.length > 0 &&
    message.url.length <= MAX_URL_CHARS &&
    typeof message.model === 'string' &&
    message.model.length > 0 &&
    message.model.length <= MAX_MODEL_CHARS &&
    typeof message.prompt === 'string' &&
    message.prompt.length > 0 &&
    message.prompt.length <= MAX_PROMPT_CHARS
  );
}

function isNvidiaAction(message: unknown): message is NvidiaRelayAction {
  if (!isRecord(message) || typeof message.type !== 'string' || !message.type.startsWith('nvidia:')) return false;
  if (typeof message.url !== 'string' || message.url.length === 0 || message.url.length > MAX_URL_CHARS) return false;
  if (message.type === 'nvidia:test') return message.token === undefined || typeof message.token === 'string';
  if (message.type === 'nvidia:pair') return typeof message.code === 'string' && /^\d{6}$/.test(message.code);
  if (typeof message.token !== 'string' || message.token.length < 20 || message.token.length > 300) return false;
  if (message.type === 'nvidia:models' || message.type === 'nvidia:usage') return true;
  return message.type === 'nvidia:generate' &&
    typeof message.model === 'string' && message.model.length > 0 && message.model.length <= MAX_MODEL_CHARS &&
    typeof message.prompt === 'string' && message.prompt.length > 0 && message.prompt.length <= 200_000 &&
    typeof message.meetingId === 'string' && message.meetingId.length > 0 && message.meetingId.length <= 200 &&
    typeof message.operation === 'string' && ['catch-up', 'summary', 'correction', 'question', 'title', 'format'].includes(message.operation) &&
    typeof message.maxTokens === 'number' && Number.isInteger(message.maxTokens) && message.maxTokens >= 1 && message.maxTokens <= 1_200 &&
    message.confirmed === true && message.confidential === false && typeof message.anonymized === 'boolean';
}

function boundedText(value: unknown, max = MAX_NOTIFICATION_CHARS): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Resolve o idioma a partir das settings salvas (o worker não tem o store em memória). */
async function ensureLocale(): Promise<void> {
  const settings = await loadSettings();
  setLocale(resolveLocale(settings.locale));
}

// Ações simples (tags/test/generate) via mensagem única.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isTrustedSender(sender) && isOllamaAction(message)) {
    handleOllamaAction(message).then(sendResponse);
    return true; // resposta assíncrona
  }
  return undefined;
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isTrustedSender(sender) && isNvidiaAction(message)) {
    handleNvidiaRelayAction(message).then(sendResponse);
    return true;
  }
  return undefined;
});

// Notificações de estado de captura (B): o content script avisa quando uma reunião começa
// a ser capturada e quando termina. Feedback proativo sem precisar abrir o painel.
type NotifyMessage = { type: 'meetsync:notify'; kind: 'start' | 'end' | 'hint'; code?: string; entries?: number; title?: string; text?: string };

chrome.runtime.onMessage.addListener((message: NotifyMessage, sender) => {
  if (!isMeetingSender(sender) || !message || message.type !== 'meetsync:notify') return undefined;
  if (!['start', 'end', 'hint'].includes(message.kind)) return undefined;
  const iconUrl = chrome.runtime.getURL('public/icons/icon-128.png');
  void (async () => {
    await ensureLocale();
    const n = t().notify;
    if (message.kind === 'start') {
      void chrome.notifications.create({
        type: 'basic',
        iconUrl,
        title: n.captureStartedTitle,
        message: message.code ? n.capturingCode(boundedText(message.code, 300)) : n.capturingMeeting,
        priority: 0,
      });
    } else if (message.kind === 'end') {
      void chrome.notifications.create({
        type: 'basic',
        iconUrl,
        title: n.meetingEndedTitle,
        message: n.transcriptReady(message.entries ?? 0),
        priority: 0,
      });
    } else if (message.kind === 'hint' && typeof message.text === 'string') {
      void chrome.notifications.create({
        type: 'basic',
        iconUrl,
        title: boundedText(message.title, 200) || 'MeetSync',
        message: boundedText(message.text),
        priority: 0,
      });
    }
  })();
  return undefined;
});

// Alertas de menção: notificação clicável (foca a aba do Meet) + badge no ícone.
type AlertMessage = { type: 'meetsync:alert'; title: string; message: string; notify?: boolean; badge?: boolean };

// notificationId -> aba que originou o alerta (para focar ao clicar).
const alertTabByNotif = new Map<string, { tabId: number; windowId?: number }>();
// tabId -> alertas pendentes (contador do badge).
const badgeByTab = new Map<number, number>();
let alertSeq = 0;

chrome.runtime.onMessage.addListener((message: AlertMessage, sender) => {
  if (
    !isMeetingSender(sender) ||
    !message ||
    message.type !== 'meetsync:alert' ||
    typeof message.title !== 'string' ||
    typeof message.message !== 'string'
  ) {
    return undefined;
  }
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;

  if (message.notify) {
    const notifId = `meetsync-alert-${++alertSeq}`;
    chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('public/icons/icon-128.png'),
      title: boundedText(message.title, 200),
      message: boundedText(message.message),
      priority: 2,
      requireInteraction: true,
    });
    if (typeof tabId === 'number') alertTabByNotif.set(notifId, { tabId, windowId });
  }

  if (message.badge && typeof tabId === 'number') {
    const count = (badgeByTab.get(tabId) ?? 0) + 1;
    badgeByTab.set(tabId, count);
    void chrome.action.setBadgeBackgroundColor({ color: '#EA4335' });
    void chrome.action.setBadgeText({ tabId, text: String(count) });
  }
  return undefined;
});

// Clique na notificação → traz a aba do Meet para frente e limpa o alerta.
chrome.notifications.onClicked.addListener((notifId) => {
  const target = alertTabByNotif.get(notifId);
  if (!target) return;
  void chrome.tabs.update(target.tabId, { active: true });
  if (typeof target.windowId === 'number') void chrome.windows.update(target.windowId, { focused: true });
  void chrome.notifications.clear(notifId);
  alertTabByNotif.delete(notifId);
  clearBadge(target.tabId);
});

// Ao voltar para a aba do Meet, zera o badge de alertas pendentes.
chrome.tabs.onActivated.addListener(({ tabId }) => clearBadge(tabId));

function clearBadge(tabId: number) {
  if (!badgeByTab.has(tabId)) return;
  badgeByTab.delete(tabId);
  void chrome.action.setBadgeText({ tabId, text: '' });
}

// Página de boas-vindas (C): aberta apenas na primeira instalação.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
  }
});

// Geração com streaming via Port: cada pedaço do Ollama é repassado ao content em tempo real.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== STREAM_PORT || !isTrustedSender(port.sender)) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener((req: unknown) => {
    if (!isStreamRequest(req)) {
      port.postMessage({ type: 'error', error: 'Solicitação inválida.' });
      return;
    }
    let alive = true;
    port.onDisconnect.addListener(() => {
      alive = false;
    });
    void streamGenerate((msg) => {
      if (alive) {
        try {
          port.postMessage(msg);
        } catch {
          alive = false;
        }
      }
    }, req);
  });
});
