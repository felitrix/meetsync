import type { MeetingMarkerKind, MeetingSession, TranscriptEntry } from '../types/index';

function isChatSource(source: TranscriptEntry['source']): boolean { return source.endsWith('-chat'); }
function isEventSource(source: TranscriptEntry['source']): boolean { return source.endsWith('-event'); }

export type EvidenceInsight = {
  id: string;
  kind: MeetingMarkerKind;
  title: string;
  owner?: string;
  deadline?: string;
  entryId: string;
  capturedAt: string;
  evidence: string;
  manual: boolean;
};

const PATTERNS: Record<Exclude<MeetingMarkerKind, 'highlight'>, RegExp> = {
  decision: /\b(decid(?:i|imos|ido|ida)|ficou definido|acord(?:amos|ado)|aprovad[oa]|vamos seguir|we decided|agreed|approved|se decidi[oó])\b/i,
  action: /\b(precis(?:o|amos|a)|vou|vamos|fica(?:rei|rá)? responsável|responsável por|entregar|enviar|fazer|follow[- ]?up|action item|need to|will|tengo que|vamos a)\b/i,
  question: /\?|\b(ficou a dúvida|precisamos confirmar|em aberto|open question|need to confirm|queda por confirmar)\b/i,
};

const DEADLINE_RE = /(?:hoje|amanhã|segunda|terça|quarta|quinta|sexta|today|tomorrow|lunes|martes|miércoles|jueves|viernes|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}:\d{2})/i;

function compact(text: string, max = 180): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function latestTimestamp(entries: readonly TranscriptEntry[]): number {
  let latest = 0;
  for (const entry of entries) latest = Math.max(latest, Date.parse(entry.capturedAt) || 0);
  return latest;
}

/** Resumo local, barato e verificável do intervalo mais recente da reunião. */
export function buildCatchUp(session: MeetingSession, minutes: 5 | 10 | 15): string {
  const latest = latestTimestamp(session.transcript);
  if (!latest) return 'Ainda não há falas capturadas.';
  const cutoff = latest - minutes * 60_000;
  const entries = session.transcript.filter((entry) => {
    const at = Date.parse(entry.capturedAt) || 0;
    return at >= cutoff && !isEventSource(entry.source);
  });
  if (!entries.length) return `Nenhuma fala capturada nos últimos ${minutes} minutos.`;

  const speakers = [...new Set(entries.map((entry) => entry.participantName).filter(Boolean))];
  const lines = entries.slice(-8).map((entry) => {
    const tag = isChatSource(entry.source) ? 'chat' : 'fala';
    return `- ${entry.participantName} (${tag}): ${compact(entry.text, 220)}`;
  });
  return [
    `**O que aconteceu nos últimos ${minutes} minutos**`,
    `${entries.length} registros · ${speakers.length} participantes`,
    '',
    ...lines,
  ].join('\n');
}

function inferredKind(entry: TranscriptEntry): Exclude<MeetingMarkerKind, 'highlight'> | null {
  if (PATTERNS.decision.test(entry.text)) return 'decision';
  if (PATTERNS.action.test(entry.text)) return 'action';
  if (PATTERNS.question.test(entry.text)) return 'question';
  return null;
}

/** Extrai candidatos somente de falas existentes e devolve a evidência que originou cada item. */
export function extractEvidenceInsights(session: MeetingSession): EvidenceInsight[] {
  const manual = new Map((session.markers ?? []).map((marker) => [marker.entryId, marker]));
  const output: EvidenceInsight[] = [];

  for (const entry of session.transcript) {
    if (isEventSource(entry.source)) continue;
    const marker = manual.get(entry.id);
    const kind = marker?.kind ?? inferredKind(entry);
    if (!kind) continue;
    const deadline = entry.text.match(DEADLINE_RE)?.[0];
    output.push({
      id: marker?.id ?? `auto-${entry.id}`,
      kind,
      title: marker?.note?.trim() || compact(entry.text, 120),
      owner: kind === 'action' ? entry.participantName : undefined,
      deadline,
      entryId: entry.id,
      capturedAt: entry.capturedAt,
      evidence: compact(entry.text, 260),
      manual: !!marker,
    });
  }
  return output;
}

/** Remove identificadores comuns antes de qualquer prévia ou envio experimental à nuvem. */
export function anonymizeTranscriptText(text: string, names: readonly string[] = []): string {
  let result = text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/https?:\/\/\S+/gi, '[LINK]')
    .replace(/\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}\b/g, '[TELEFONE]')
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[CPF]')
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '[CNPJ]');
  const unique = [...new Set(names.map((name) => name.trim()).filter((name) => name.length >= 3))]
    .sort((a, b) => b.length - a.length);
  unique.forEach((name, index) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), `[PESSOA_${index + 1}]`);
  });
  return result;
}

/** Estimativa pessimista simples para bloquear antes da chamada; o relay repete a validação. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}
