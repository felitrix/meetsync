export type NvidiaOperation = 'catch-up' | 'summary' | 'correction' | 'question' | 'title' | 'format';

export type NvidiaUsage = {
  day: string;
  calls: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  limits: { dailyCalls: number; meetingCalls: number; inputPerCall: number; outputPerCall: number };
};

export type NvidiaRelayAction =
  | { type: 'nvidia:test'; url: string; token?: string }
  | { type: 'nvidia:pair'; url: string; code: string }
  | { type: 'nvidia:models'; url: string; token: string }
  | { type: 'nvidia:usage'; url: string; token: string }
  | {
      type: 'nvidia:generate';
      url: string;
      token: string;
      model: string;
      prompt: string;
      meetingId: string;
      operation: NvidiaOperation;
      maxTokens: number;
      confirmed: true;
      confidential: false;
      anonymized: boolean;
    };

export type NvidiaRelayResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

function normalizeRelayUrl(input: string): string {
  let value = (input || '').trim();
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('URL do relay NVIDIA inválida.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('O relay NVIDIA deve usar somente http://127.0.0.1.');
  }
  return url.origin;
}

async function relayFetch(action: NvidiaRelayAction): Promise<NvidiaRelayResult<unknown>> {
  const base = normalizeRelayUrl(action.url);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if ('token' in action && action.token) headers.Authorization = `Bearer ${action.token}`;
  let path = '/health';
  let method = 'GET';
  let body: string | undefined;
  if (action.type === 'nvidia:pair') { path = '/pair'; method = 'POST'; body = JSON.stringify({ code: action.code }); }
  if (action.type === 'nvidia:models') path = '/v1/models';
  if (action.type === 'nvidia:usage') path = '/v1/usage';
  if (action.type === 'nvidia:generate') {
    path = '/v1/generate'; method = 'POST';
    body = JSON.stringify({ model: action.model, prompt: action.prompt, meetingId: action.meetingId, operation: action.operation, maxTokens: action.maxTokens, confirmed: action.confirmed, confidential: action.confidential, anonymized: action.anonymized });
  }
  try {
    const response = await fetch(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(120_000) });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return { ok: false, error: String(data.error ?? `HTTP ${response.status}`), code: String(data.code ?? response.status) };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'NETWORK' };
  }
}

export async function handleNvidiaRelayAction(action: NvidiaRelayAction): Promise<NvidiaRelayResult<unknown>> {
  return relayFetch(action);
}

async function send<T>(action: NvidiaRelayAction): Promise<T> {
  const result = await chrome.runtime.sendMessage(action) as NvidiaRelayResult<T> | undefined;
  if (!result) throw new Error('Sem resposta do relay NVIDIA.');
  if (!result.ok) throw new Error(`${result.code ? `[${result.code}] ` : ''}${result.error}`);
  return result.data;
}

export const nvidiaRelay = {
  normalizeUrl: normalizeRelayUrl,
  test: (url: string, token?: string) => send<{ ok: boolean; paired: boolean }>({ type: 'nvidia:test', url, token }),
  pair: (url: string, code: string) => send<{ token: string }>({ type: 'nvidia:pair', url, code }),
  listModels: (url: string, token: string) => send<{ models: string[] }>({ type: 'nvidia:models', url, token }),
  usage: (url: string, token: string) => send<NvidiaUsage>({ type: 'nvidia:usage', url, token }),
  generate: (request: Omit<Extract<NvidiaRelayAction, { type: 'nvidia:generate' }>, 'type'>) =>
    send<{ text: string; usage?: { promptTokens?: number; completionTokens?: number }; cached?: boolean }>({ type: 'nvidia:generate', ...request }),
};
