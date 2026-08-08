import { createHash, randomBytes, randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetLedger } from './relay-budget.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.MEETSYNC_RELAY_PORT || 19876);
const MAX_BODY_BYTES = 256 * 1024;
const LIMITS = Object.freeze({ dailyCalls: 5, meetingCalls: 2, inputPerCall: 16_000, outputPerCall: 1_200 });
const ALLOWED_OPERATIONS = new Set(['catch-up', 'summary', 'correction', 'question', 'title', 'format']);
const ALLOWED_MODELS = new Set((process.env.MEETSYNC_NVIDIA_MODELS || 'meta/llama-3.1-8b-instruct').split(',').map((v) => v.trim()).filter(Boolean));
const stateDir = join(process.env.LOCALAPPDATA || process.cwd(), 'MeetSync');
const usagePath = join(stateDir, 'nvidia-usage.json');
const helperPath = join(dirname(fileURLToPath(import.meta.url)), 'credential-helper.ps1');
const pairCode = String(randomInt(100000, 1000000));
const tokens = new Map();
const cache = new Map();

function today() { return new Date().toISOString().slice(0, 10); }
function emptyUsage() { return { day: today(), calls: 0, reservedInputTokens: 0, reservedOutputTokens: 0, meetings: {} }; }
function loadUsage() {
  try {
    const parsed = JSON.parse(readFileSync(usagePath, 'utf8'));
    return parsed.day === today() ? parsed : emptyUsage();
  } catch { return emptyUsage(); }
}
function saveUsage(next) {
  mkdirSync(stateDir, { recursive: true });
  const temp = `${usagePath}.tmp`;
  const { limits: _limits, ...state } = next;
  writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, usagePath);
}
const budget = new BudgetLedger({ limits: LIMITS, initial: loadUsage(), today, persist: saveUsage });

function readApiKey() {
  const key = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-Get'], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (!/^nvapi-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error('Chave NVIDIA ausente ou inválida no Gerenciador de Credenciais.');
  return key;
}

function validOrigin(origin) { return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin); }
function cors(res, origin) {
  if (validOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
function reply(res, status, value, origin) {
  cors(res, origin);
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function error(res, status, code, message, origin) { reply(res, status, { error: message, code }, origin); }

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('Payload excede 256 KB.'), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON inválido.'), { status: 400, code: 'INVALID_JSON' }); }
}

function authenticate(req, origin) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  return token.length >= 20 && tokens.get(token) === origin;
}

async function generate(payload) {
  const { model, prompt, meetingId, operation, maxTokens, confirmed, confidential } = payload || {};
  if (confirmed !== true) throw Object.assign(new Error('Confirmação explícita obrigatória.'), { status: 403, code: 'CONSENT_REQUIRED' });
  if (confidential !== false) throw Object.assign(new Error('Reunião confidencial bloqueada.'), { status: 403, code: 'CONFIDENTIAL' });
  if (!ALLOWED_MODELS.has(model)) throw Object.assign(new Error('Modelo fora da allowlist.'), { status: 400, code: 'MODEL_NOT_ALLOWED' });
  if (!ALLOWED_OPERATIONS.has(operation)) throw Object.assign(new Error('Operação não autorizada.'), { status: 400, code: 'OPERATION_NOT_ALLOWED' });
  if (typeof prompt !== 'string' || !prompt.trim() || typeof meetingId !== 'string' || !meetingId || !Number.isInteger(maxTokens) || maxTokens < 1) {
    throw Object.assign(new Error('Requisição inválida.'), { status: 400, code: 'INVALID_REQUEST' });
  }
  const cacheKey = createHash('sha256').update(JSON.stringify({ model, prompt, meetingId, operation, maxTokens })).digest('hex');
  if (cache.has(cacheKey)) return { ...cache.get(cacheKey), cached: true };
  budget.reserve(meetingId, Math.max(1, Math.ceil(prompt.length / 3)), maxTokens);
  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${readApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, top_p: 0.7, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`NVIDIA HTTP ${response.status}`), { status: response.status, code: `NVIDIA_${response.status}` });
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('Resposta NVIDIA vazia.'), { status: 502, code: 'EMPTY_RESPONSE' });
  const result = { text: text.trim(), usage: { promptTokens: data?.usage?.prompt_tokens, completionTokens: data?.usage?.completion_tokens }, cached: false };
  cache.set(cacheKey, result);
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return result;
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    if (!validOrigin(origin)) return error(res, 403, 'ORIGIN_REJECTED', 'Origem rejeitada.', origin);
    cors(res, origin); res.writeHead(204); return res.end();
  }
  if (!validOrigin(origin)) return error(res, 403, 'ORIGIN_REJECTED', 'Somente a extensão MeetSync pode acessar o relay.', origin);
  try {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, paired: authenticate(req, origin) }, origin);
    if (req.method === 'POST' && req.url === '/pair') {
      const body = await readJson(req);
      if (body.code !== pairCode) return error(res, 403, 'PAIRING_FAILED', 'Código de pareamento inválido.', origin);
      const token = randomBytes(32).toString('base64url');
      tokens.set(token, origin);
      return reply(res, 200, { token }, origin);
    }
    if (!authenticate(req, origin)) return error(res, 401, 'UNPAIRED', 'Relay não pareado.', origin);
    if (req.method === 'GET' && req.url === '/v1/models') return reply(res, 200, { models: [...ALLOWED_MODELS] }, origin);
    if (req.method === 'GET' && req.url === '/v1/usage') return reply(res, 200, budget.snapshot(), origin);
    if (req.method === 'POST' && req.url === '/v1/generate') return reply(res, 200, await generate(await readJson(req)), origin);
    return error(res, 404, 'NOT_FOUND', 'Rota inexistente.', origin);
  } catch (cause) {
    const status = Number(cause?.status) || 500;
    error(res, status, cause?.code || 'RELAY_ERROR', status >= 500 ? 'Falha no relay NVIDIA.' : cause.message, origin);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MeetSync NVIDIA Relay ativo em http://${HOST}:${PORT}`);
  console.log(`Código de pareamento: ${pairCode}`);
  console.log('A chave permanece no Gerenciador de Credenciais do Windows; prompts e respostas não são gravados.');
});
