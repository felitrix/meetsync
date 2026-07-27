// Persistência local de configurações em chrome.storage.local (RF-108, RF-080).
// A transcrição da reunião EM ANDAMENTO vive em memória no store; além disso, mantemos um
// snapshot da última reunião como rede de segurança (o Meet redireciona/fecha a aba ao encerrar
// — sem isto a transcrição se perde antes do download). Tudo fica só local, nada sai do navegador.

import {
  DEFAULT_SETTINGS,
  type MeetingProvider,
  type MeetingSession,
  type TranscriptEntry,
  type UserSettings,
} from '@/types';
import { t } from '@/i18n';
import { cleanRollingTranscript, type CleanableTranscriptEntry } from '@/content/caption-utils';
import {
  normalizeHistoryRetention,
  selectHistoryIdsToKeep,
  type HistoryRetentionCount,
} from './retention-utils';

const SETTINGS_KEY = 'meetsync:settings';
const LAST_MEETING_KEY = 'meetsync:lastMeeting'; // legado (0.3.0) — migrado para o histórico
const HISTORY_KEY = 'meetsync:history'; // índice leve (metadados) para a lista
const MEETING_PREFIX = 'meetsync:meeting:'; // dados completos por reunião
const OPEN_HISTORY_KEY = 'meetsync:openHistory'; // sinaliza pra aba do Meet abrir o histórico ao carregar

/** Pede que a próxima aba do Meet a carregar abra o histórico (usado pelo popup fora do Meet). */
export async function requestOpenHistory(): Promise<void> {
  try {
    await chrome.storage.local.set({ [OPEN_HISTORY_KEY]: true });
  } catch {
    /* ignora */
  }
}

/** Consome o sinal de abrir histórico (retorna true uma única vez). */
export async function consumeOpenHistory(): Promise<boolean> {
  try {
    const res = await chrome.storage.local.get(OPEN_HISTORY_KEY);
    if (res[OPEN_HISTORY_KEY]) {
      await chrome.storage.local.remove(OPEN_HISTORY_KEY);
      return true;
    }
  } catch {
    /* ignora */
  }
  return false;
}

/** Dados completos de uma reunião salva. */
export type SavedMeeting = {
  session: MeetingSession;
  summaryText?: string;
  /** ISO de quando foi salvo. */
  savedAt: string;
};

/** Metadado leve para a lista do histórico (sem o transcript inteiro). */
export type HistoryMeta = {
  id: string;
  /** Plataforma da reunião (para o ícone na lista). Default 'google-meet' (dados antigos). */
  provider: MeetingProvider;
  title: string;
  meetingCode: string;
  savedAt: string;
  startISO?: string;
  endISO?: string;
  durationMin: number;
  lines: number;
  chats: number;
  participants: string[];
  hasSummary: boolean;
  starred: boolean;
  /** Prévia da primeira fala (para o card da lista). */
  preview?: { who: string; text: string };
};

function metaFromSession(session: MeetingSession, summaryText: string | undefined, savedAt: string, starred: boolean): HistoryMeta {
  const start = session.captureStartedAt;
  const end = session.captureEndedAt ?? savedAt;
  let durationMin = 0;
  if (start) durationMin = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000));
  const first = [...session.transcript].sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0))[0];
  return {
    id: session.id,
    provider: session.provider ?? 'google-meet',
    title: session.meetingTitle || session.meetingCode || t().history.meetingFallback,
    meetingCode: session.meetingCode,
    savedAt,
    startISO: start,
    endISO: session.captureEndedAt,
    durationMin,
    lines: session.transcript.length,
    chats: session.transcript.filter((e) => e.source === 'google-meet-chat').length,
    participants: session.participants.map((p) => p.name),
    hasSummary: !!summaryText,
    starred,
    preview: first ? { who: first.participantName, text: first.text } : undefined,
  };
}

export async function loadSettings(): Promise<UserSettings> {
  try {
    const res = await chrome.storage.local.get(SETTINGS_KEY);
    const stored = res[SETTINGS_KEY] as Partial<UserSettings> | undefined;
    const settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
    settings.historyRetentionCount = normalizeHistoryRetention(settings.historyRetentionCount);
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch {
    // storage indisponível — segue só em memória.
  }
}

/**
 * Salva/atualiza uma reunião no histórico (upsert por session.id). Chamado durante a captura e
 * ao encerrar. Mantém o índice (metadados) ordenado do mais novo ao mais antigo e poda o excesso.
 */
/** Leitura crua do índice (sem migração) — usada internamente para evitar recursão. */
async function readIndex(): Promise<HistoryMeta[]> {
  try {
    const res = await chrome.storage.local.get(HISTORY_KEY);
    return (res[HISTORY_KEY] as HistoryMeta[] | undefined) ?? [];
  } catch {
    return [];
  }
}

export async function saveMeeting(session: MeetingSession, summaryText?: string): Promise<void> {
  if (!session.id || session.transcript.length === 0) return;
  const savedAt = new Date().toISOString();
  const current = await readIndex();
  const prevStarred = current.find((m) => m.id === session.id)?.starred ?? false;
  const meta = metaFromSession(session, summaryText, savedAt, prevStarred);
  const full: SavedMeeting = { session, summaryText, savedAt };

  let index = [meta, ...current.filter((m) => m.id !== session.id)];

  // Poda configurável: favoritos são sempre preservados; limita apenas os não favoritos.
  const retention = (await loadSettings()).historyRetentionCount;
  const keepIds = selectHistoryIdsToKeep(index, retention);
  const pruned = index.filter((item) => !keepIds.has(item.id));
  index = index.filter((item) => keepIds.has(item.id));

  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: index, [MEETING_PREFIX + session.id]: full });
    if (pruned.length) await chrome.storage.local.remove(pruned.map((m) => MEETING_PREFIX + m.id));
  } catch {
    // Provável estouro de quota: tenta liberar a reunião mais antiga e salvar de novo, uma vez.
    const oldest =
      [...index].reverse().find((item) => !item.starred && item.id !== session.id) ??
      [...index].reverse().find((item) => item.id !== session.id);
    if (oldest && oldest.id !== session.id) {
      try {
        await chrome.storage.local.remove(MEETING_PREFIX + oldest.id);
        await chrome.storage.local.set({ [HISTORY_KEY]: index.slice(0, -1), [MEETING_PREFIX + session.id]: full });
      } catch {
        /* desiste — segue em memória */
      }
    }
  }
}

/** Aplica imediatamente a nova retenção e retorna quantas reuniões não favoritas foram removidas. */
export async function applyHistoryRetention(
  requestedLimit: unknown,
): Promise<{ limit: HistoryRetentionCount; removed: number }> {
  const limit = normalizeHistoryRetention(requestedLimit);
  const index = await readIndex();
  const keepIds = selectHistoryIdsToKeep(index, limit);
  const kept = index.filter((item) => keepIds.has(item.id));
  const pruned = index.filter((item) => !keepIds.has(item.id));
  if (!pruned.length) return { limit, removed: 0 };
  await chrome.storage.local.set({ [HISTORY_KEY]: kept });
  await chrome.storage.local.remove(pruned.map((item) => MEETING_PREFIX + item.id));
  return { limit, removed: pruned.length };
}

/** Índice do histórico (metadados), mais novo primeiro. Migra o formato legado 0.3.0 se preciso. */
export async function loadHistory(): Promise<HistoryMeta[]> {
  try {
    const res = await chrome.storage.local.get([HISTORY_KEY, LAST_MEETING_KEY]);
    const index = res[HISTORY_KEY] as HistoryMeta[] | undefined;
    if (index && index.length) return index;
    // Migração: importa o snapshot único da 0.3.0, se existir (saveMeeting usa readIndex → sem recursão).
    const legacy = res[LAST_MEETING_KEY] as SavedMeeting | undefined;
    if (legacy?.session?.transcript?.length) {
      await saveMeeting(legacy.session, legacy.summaryText);
      await chrome.storage.local.remove(LAST_MEETING_KEY);
      return readIndex();
    }
    return [];
  } catch {
    return [];
  }
}

export async function loadMeeting(id: string): Promise<SavedMeeting | null> {
  try {
    const res = await chrome.storage.local.get(MEETING_PREFIX + id);
    return (res[MEETING_PREFIX + id] as SavedMeeting | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Acha a reunião anterior mais recente na MESMA sala (mesmo meetingCode) que já tem ata salva —
 *  usada para dar continuidade à ata nova (o que foi resolvido / continua pendente desde então).
 *  Sem meetingCode (não identificado) não há como saber que é "a mesma sala" — retorna null. */
export async function findPreviousMeetingSummary(session: MeetingSession): Promise<{ summaryText: string; whenISO?: string } | null> {
  if (!session.meetingCode) return null;
  const index = await loadHistory();
  const curWhen = session.captureStartedAt;
  const candidates = index
    .filter((m) => m.id !== session.id && m.hasSummary && m.meetingCode === session.meetingCode)
    .sort((a, b) => (b.startISO ?? b.savedAt).localeCompare(a.startISO ?? a.savedAt));
  const prev = curWhen ? candidates.find((m) => (m.startISO ?? m.savedAt) < curWhen) : candidates[0];
  const chosen = prev ?? candidates[0];
  if (!chosen) return null;
  const saved = await loadMeeting(chosen.id);
  if (!saved?.summaryText) return null;
  return { summaryText: saved.summaryText, whenISO: chosen.startISO ?? chosen.savedAt };
}

/** Renomeia uma reunião do histórico (índice + dados completos) — usado ao aplicar um título
 *  sugerido por IA em lote. Diferente do download com IA, aqui o título É persistido. */
export async function renameMeeting(id: string, title: string): Promise<void> {
  try {
    const index = await loadHistory();
    const meta = index.find((m) => m.id === id);
    if (meta) meta.title = title;
    await chrome.storage.local.set({ [HISTORY_KEY]: index });

    const res = await chrome.storage.local.get(MEETING_PREFIX + id);
    const saved = res[MEETING_PREFIX + id] as SavedMeeting | undefined;
    if (saved) {
      saved.session.meetingTitle = title;
      await chrome.storage.local.set({ [MEETING_PREFIX + id]: saved });
    }
  } catch {
    /* falha ao renomear — ignora, mantém título anterior */
  }
}

/** Persiste um resumo/ata gerado por download com IA de volta no registro da reunião (índice
 *  + dados completos) — sem isso o histórico continuava marcando "Sem ata" mesmo depois de o
 *  usuário já ter gerado a ata via "Baixar .txt com IA". Não mexe em savedAt/ordem da lista. */
export async function updateMeetingSummary(id: string, summaryText: string): Promise<void> {
  try {
    const index = await loadHistory();
    const meta = index.find((m) => m.id === id);
    if (meta) meta.hasSummary = true;
    await chrome.storage.local.set({ [HISTORY_KEY]: index });

    const res = await chrome.storage.local.get(MEETING_PREFIX + id);
    const saved = res[MEETING_PREFIX + id] as SavedMeeting | undefined;
    if (saved) {
      saved.summaryText = summaryText;
      await chrome.storage.local.set({ [MEETING_PREFIX + id]: saved });
    }
  } catch {
    /* falha ao salvar a ata — ignora, o arquivo já foi baixado com a ata mesmo assim */
  }
}

// ---- Backup de reunião (exportar/importar entre dispositivos) ----
const BACKUP_SCHEMA = 'meetsync-backup';
const BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 50_000;
const TRANSCRIPT_SOURCES = new Set([
  'google-meet-caption',
  'google-meet-chat',
  'google-meet-event',
  'microsoft-teams-caption',
  'microsoft-teams-chat',
  'microsoft-teams-event',
]);

export type MeetingBackup = {
  schema: typeof BACKUP_SCHEMA;
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  starred: boolean;
  saved: SavedMeeting;
};

export type ImportMeetingResult =
  | { ok: true; kind: 'backup'; removedCaptionChars: 0 }
  | {
      ok: true;
      kind: 'cleaned-export';
      removedCaptionChars: number;
      originalCaptionChars: number;
      cleanedCaptionChars: number;
    }
  | { ok: false; error: 'invalid_json' | 'invalid_schema' };

/** Monta o JSON de backup de uma reunião — dá pra importar em outro dispositivo (com
 *  transcrição, resumo e todas as funcionalidades funcionando normalmente, como se tivesse
 *  sido capturada ali). Distinto do .json de export-txt (esse é pra automações/IA). */
export function buildMeetingBackup(meta: HistoryMeta, saved: SavedMeeting): string {
  const backup: MeetingBackup = { schema: BACKUP_SCHEMA, schemaVersion: BACKUP_SCHEMA_VERSION, starred: meta.starred, saved };
  return JSON.stringify(backup, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
}

function isOptionalIso(value: unknown): value is string | undefined {
  return value === undefined || (isBoundedString(value, 64, false) && Number.isFinite(Date.parse(value)));
}

function isValidImportedSession(value: unknown): value is MeetingSession {
  if (!isRecord(value)) return false;
  const provider = value.provider;
  if (provider !== undefined && provider !== 'google-meet' && provider !== 'microsoft-teams') return false;
  if (
    !isBoundedString(value.id, 200, false) ||
    !isBoundedString(value.meetingCode, 300) ||
    !isBoundedString(value.meetingUrl, 2_048) ||
    (value.meetingTitle !== undefined && !isBoundedString(value.meetingTitle, 2_000)) ||
    !isOptionalIso(value.captureStartedAt) ||
    !isOptionalIso(value.captureEndedAt) ||
    !Array.isArray(value.participants) ||
    value.participants.length > 2_000 ||
    !Array.isArray(value.transcript) ||
    value.transcript.length > MAX_BACKUP_ENTRIES
  ) {
    return false;
  }
  if (
    !value.participants.every(
      (participant) =>
        isRecord(participant) &&
        isBoundedString(participant.name, 500, false) &&
        (participant.id === undefined || isBoundedString(participant.id, 500)) &&
        (participant.avatarUrl === undefined || isBoundedString(participant.avatarUrl, 4_096)),
    )
  ) {
    return false;
  }
  return value.transcript.every(
    (entry) =>
      isRecord(entry) &&
      isBoundedString(entry.id, 200, false) &&
      isBoundedString(entry.participantName, 500, false) &&
      (entry.participantAvatarUrl === undefined || isBoundedString(entry.participantAvatarUrl, 4_096)) &&
      isBoundedString(entry.text, 100_000, false) &&
      isBoundedString(entry.capturedAt, 64, false) &&
      Number.isFinite(Date.parse(entry.capturedAt)) &&
      typeof entry.source === 'string' &&
      TRANSCRIPT_SOURCES.has(entry.source),
  );
}

/** Importa um backup gerado por buildMeetingBackup: grava a reunião no histórico deste
 *  dispositivo (upsert por session.id — reimportar o mesmo arquivo atualiza, não duplica). */
export async function importMeetingBackup(json: string): Promise<{ ok: true } | { ok: false; error: 'invalid_json' | 'invalid_schema' }> {
  if (new Blob([json]).size > MAX_BACKUP_BYTES) return { ok: false, error: 'invalid_schema' };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!isRecord(data) || data.schema !== BACKUP_SCHEMA || data.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    return { ok: false, error: 'invalid_schema' };
  }
  const saved = data.saved;
  if (
    typeof data.starred !== 'boolean' ||
    !isRecord(saved) ||
    !isValidImportedSession(saved.session) ||
    !isBoundedString(saved.savedAt, 64, false) ||
    !Number.isFinite(Date.parse(saved.savedAt)) ||
    (saved.summaryText !== undefined && !isBoundedString(saved.summaryText, 2_000_000))
  ) {
    return { ok: false, error: 'invalid_schema' };
  }
  const session = saved.session;
  if (!session.provider) session.provider = 'google-meet';
  await saveMeeting(session, saved.summaryText as string | undefined);
  if (data.starred) await setMeetingStarred(session.id, true);
  return { ok: true };
}

/**
 * Aceita tanto o backup completo quanto o JSON de exportação das versões antigas. No segundo
 * caso, reconcilia as janelas cumulativas antes de criar uma NOVA reunião no histórico; o arquivo
 * original permanece intacto no disco.
 */
export async function importMeetingFile(json: string): Promise<ImportMeetingResult> {
  if (new Blob([json]).size > MAX_BACKUP_BYTES) return { ok: false, error: 'invalid_schema' };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }

  if (isRecord(data) && data.schema === BACKUP_SCHEMA) {
    const imported = await importMeetingBackup(json);
    return imported.ok
      ? { ok: true, kind: 'backup', removedCaptionChars: 0 }
      : imported;
  }

  if (
    !isRecord(data) ||
    !Array.isArray(data.transcript) ||
    data.transcript.length === 0 ||
    data.transcript.length > MAX_BACKUP_ENTRIES ||
    (data.meetingTitle !== null && data.meetingTitle !== undefined && !isBoundedString(data.meetingTitle, 2_000)) ||
    !isBoundedString(data.meetingUrl, 2_048) ||
    !isBoundedString(data.meetingCode, 300) ||
    (data.captureStartedAt !== null && !isOptionalIso(data.captureStartedAt)) ||
    (data.captureEndedAt !== null && !isOptionalIso(data.captureEndedAt)) ||
    (data.summary !== null && data.summary !== undefined && !isBoundedString(data.summary, 2_000_000))
  ) {
    return { ok: false, error: 'invalid_schema' };
  }

  const rawEntries: CleanableTranscriptEntry[] = [];
  for (let i = 0; i < data.transcript.length; i++) {
    const raw = data.transcript[i];
    if (
      !isRecord(raw) ||
      !isBoundedString(raw.speaker, 500, false) ||
      !isBoundedString(raw.text, 100_000, false) ||
      !isBoundedString(raw.capturedAt, 64, false) ||
      !Number.isFinite(Date.parse(raw.capturedAt)) ||
      typeof raw.source !== 'string' ||
      !TRANSCRIPT_SOURCES.has(raw.source)
    ) {
      return { ok: false, error: 'invalid_schema' };
    }
    rawEntries.push({
      id: `legacy-${i + 1}`,
      participantName: raw.speaker,
      text: raw.text,
      capturedAt: raw.capturedAt,
      source: raw.source,
    });
  }

  const cleaned = cleanRollingTranscript(rawEntries);
  if (!cleaned.entries.length) return { ok: false, error: 'invalid_schema' };
  const provider: MeetingProvider =
    data.source === 'microsoft-teams' ||
    cleaned.entries.some((entry) => entry.source.startsWith('microsoft-teams-'))
      ? 'microsoft-teams'
      : 'google-meet';
  const participantNames = new Set<string>();
  if (Array.isArray(data.participants) && data.participants.length <= 2_000) {
    for (const participant of data.participants) {
      if (!isBoundedString(participant, 500, false)) return { ok: false, error: 'invalid_schema' };
      participantNames.add(participant);
    }
  }
  for (const entry of cleaned.entries) {
    if (!entry.source.endsWith('-event')) participantNames.add(entry.participantName);
  }

  const session: MeetingSession = {
    id: crypto.randomUUID(),
    provider,
    meetingTitle: typeof data.meetingTitle === 'string' ? data.meetingTitle : undefined,
    meetingUrl: data.meetingUrl,
    meetingCode: data.meetingCode,
    captureStartedAt: typeof data.captureStartedAt === 'string' ? data.captureStartedAt : undefined,
    captureEndedAt: typeof data.captureEndedAt === 'string' ? data.captureEndedAt : undefined,
    participants: [...participantNames].map((name) => ({ name })),
    transcript: cleaned.entries as TranscriptEntry[],
  };
  await saveMeeting(session, typeof data.summary === 'string' ? data.summary : undefined);
  return {
    ok: true,
    kind: 'cleaned-export',
    removedCaptionChars: cleaned.removedCaptionChars,
    originalCaptionChars: cleaned.originalCaptionChars,
    cleanedCaptionChars: cleaned.cleanedCaptionChars,
  };
}

export async function deleteMeeting(id: string): Promise<void> {
  try {
    const index = (await loadHistory()).filter((m) => m.id !== id);
    await chrome.storage.local.set({ [HISTORY_KEY]: index });
    await chrome.storage.local.remove(MEETING_PREFIX + id);
  } catch {
    /* ignora */
  }
}

export async function setMeetingStarred(id: string, starred: boolean): Promise<void> {
  try {
    const index = (await loadHistory()).map((m) => (m.id === id ? { ...m, starred } : m));
    await chrome.storage.local.set({ [HISTORY_KEY]: index });
  } catch {
    /* ignora */
  }
}
