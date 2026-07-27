// Funções puras usadas pela captura de legendas e do chat.
// Mantidas sem dependências do Chrome/DOM para permitir testes de regressão com Node.

type TextToken = {
  value: string;
  start: number;
  end: number;
};

export type CaptionMergeResult = {
  kind: 'unchanged' | 'continued' | 'new';
  history: string;
  /** Trecho realmente novo anexado ao histórico (vazio em revisão/duplicata). */
  appended: string;
};

export type ParsedChatHeader = {
  name: string;
  capturedAt: string;
};

const CHAT_TIME_RE = /\b(\d{1,2}):(\d{2})(?:\s*([ap]m))?\b/i;
const MIN_OVERLAP_TOKENS = 4;
const MIN_OVERLAP_CHARS = 18;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeToken(token: string): string {
  return token
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeText(text: string): string {
  return collapseWhitespace(
    text
      .toLocaleLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' '),
  );
}

function tokenize(text: string): TextToken[] {
  const out: TextToken[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (match.index == null) continue;
    const raw = match[0];
    out.push({
      value: normalizeToken(raw),
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return out;
}

function sameRange(a: TextToken[], aStart: number, b: TextToken[], bStart: number, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (a[aStart + i]?.value !== b[bStart + i]?.value) return false;
  }
  return true;
}

function sameTokens(a: TextToken[], b: TextToken[]): boolean {
  return a.length === b.length && sameRange(a, 0, b, 0, a.length);
}

function commonPrefixLength(a: TextToken[], b: TextToken[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i]?.value === b[i]?.value) i++;
  return i;
}

function containsTokens(haystack: TextToken[], needle: TextToken[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (haystack[start]?.value !== needle[0]?.value) continue;
    if (sameRange(haystack, start, needle, 0, needle.length)) return true;
  }
  return false;
}

function overlapChars(tokens: TextToken[], length: number): number {
  if (length <= 0) return 0;
  return (tokens[length - 1]?.end ?? 0) - (tokens[0]?.start ?? 0);
}

function isMeaningfulOverlap(tokens: TextToken[], length: number): boolean {
  return length >= MIN_OVERLAP_TOKENS || overlapChars(tokens, length) >= MIN_OVERLAP_CHARS;
}

function suffixPrefixOverlap(previous: TextToken[], current: TextToken[]): number {
  const limit = Math.min(previous.length, current.length);
  for (let length = limit; length > 0; length--) {
    if (!isMeaningfulOverlap(current, length)) continue;
    if (sameRange(previous, previous.length - length, current, 0, length)) return length;
  }
  return 0;
}

function appendText(base: string, tail: string): string {
  const a = base.trimEnd();
  const b = tail.trimStart();
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

function replaceHistorySuffix(history: string, previous: TextToken[], replacement: string): string | null {
  const historyTokens = tokenize(history);
  if (previous.length > historyTokens.length) return null;
  const startToken = historyTokens.length - previous.length;
  if (!sameRange(historyTokens, startToken, previous, 0, previous.length)) return null;
  const startChar = historyTokens[startToken]?.start ?? history.length;
  return appendText(history.slice(0, startChar), replacement);
}

/**
 * Reconcilia uma janela de legenda deslizante com o histórico já observado.
 *
 * O Meet pode trocar:
 *   "a b c d e f" -> "c d e f g h"
 * A saída correta é "a b c d e f g h", e não duas falas quase iguais.
 */
export function mergeRollingCaption(
  historyText: string,
  previousSnapshotText: string,
  currentSnapshotText: string,
): CaptionMergeResult {
  const history = collapseWhitespace(historyText);
  const previous = collapseWhitespace(previousSnapshotText);
  const current = collapseWhitespace(currentSnapshotText);
  if (!current) return { kind: 'unchanged', history, appended: '' };
  if (!previous) return { kind: 'continued', history: current, appended: current };

  const previousTokens = tokenize(previous);
  const currentTokens = tokenize(current);
  if (currentTokens.length === 0) return { kind: 'unchanged', history, appended: '' };

  if (sameTokens(previousTokens, currentTokens)) {
    const revised = replaceHistorySuffix(history, previousTokens, current);
    return { kind: 'unchanged', history: revised ?? history, appended: '' };
  }

  // Crescimento cumulativo normal: snapshot anterior é prefixo do atual.
  if (
    previousTokens.length < currentTokens.length &&
    sameRange(currentTokens, 0, previousTokens, 0, previousTokens.length)
  ) {
    const tailStart = currentTokens[previousTokens.length]?.start ?? current.length;
    const tail = current.slice(tailStart).trim();
    return { kind: 'continued', history: appendText(history, tail), appended: tail };
  }

  // Janela deslizante: o final anterior reaparece no começo do snapshot atual.
  const overlap = suffixPrefixOverlap(previousTokens, currentTokens);
  if (overlap > 0) {
    const tailStart = currentTokens[overlap]?.start ?? current.length;
    const tail = current.slice(tailStart).trim();
    return {
      kind: tail ? 'continued' : 'unchanged',
      history: appendText(history, tail),
      appended: tail,
    };
  }

  // Snapshot temporariamente menor/antigo: não duplica nem apaga o histórico.
  if (containsTokens(previousTokens, currentTokens) || containsTokens(tokenize(history), currentTokens)) {
    return { kind: 'unchanged', history, appended: '' };
  }

  // Revisão do reconhecimento no fim da mesma fala.
  const common = commonPrefixLength(previousTokens, currentTokens);
  const shorter = Math.min(previousTokens.length, currentTokens.length);
  if (
    common > 0 &&
    isMeaningfulOverlap(currentTokens, common) &&
    common >= Math.floor(shorter * 0.65)
  ) {
    const revised = replaceHistorySuffix(history, previousTokens, current);
    if (revised != null) return { kind: 'continued', history: revised, appended: '' };
  }

  // O Meet frequentemente corrige apenas a palavra incompleta no final ("promo" -> "promoção").
  const previousNormalized = normalizeText(previous);
  const currentNormalized = normalizeText(current);
  const charLimit = Math.min(previousNormalized.length, currentNormalized.length);
  let commonChars = 0;
  while (
    commonChars < charLimit &&
    previousNormalized[commonChars] === currentNormalized[commonChars]
  ) {
    commonChars++;
  }
  const shorterChars = Math.min(previousNormalized.length, currentNormalized.length);
  if (
    shorterChars >= 12 &&
    commonChars >= Math.min(40, Math.floor(shorterChars * 0.8))
  ) {
    const revised = replaceHistorySuffix(history, previousTokens, current);
    if (revised != null) return { kind: 'continued', history: revised, appended: '' };
  }

  return { kind: 'new', history: current, appended: current };
}

/** Escolhe um corte legível para não criar um único balão enorme durante falas longas. */
export function findCaptionSegmentCut(text: string, target = 520, maximum = 700): number {
  if (text.length <= maximum) return text.length;
  const min = Math.min(Math.floor(target * 0.55), text.length);
  const max = Math.min(maximum, text.length);
  const window = text.slice(min, max);
  const punctuation = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
    window.lastIndexOf('; '),
  );
  if (punctuation >= 0) return min + punctuation + 1;
  const whitespace = text.lastIndexOf(' ', max);
  return whitespace > min ? whitespace : max;
}

function collapseRepeatedName(name: string): string {
  const words = collapseWhitespace(name).split(' ').filter(Boolean);
  if (words.length < 2 || words.length % 2 !== 0) return words.join(' ');
  const half = words.length / 2;
  const left = words.slice(0, half).map(normalizeToken);
  const right = words.slice(half).map(normalizeToken);
  return left.every((word, i) => word === right[i]) ? words.slice(0, half).join(' ') : words.join(' ');
}

/** Separa nome e horário do header do chat, incluindo relógio de 12 horas com AM/PM. */
export function parseChatHeader(headerText: string, now = new Date()): ParsedChatHeader {
  const header = collapseWhitespace(headerText);
  const match = header.match(CHAT_TIME_RE);
  let capturedAt = new Date(now).toISOString();
  let name = header;

  if (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const period = match[3]?.toLocaleLowerCase();
    if (period) {
      hour %= 12;
      if (period === 'pm') hour += 12;
    }
    const captured = new Date(now);
    captured.setHours(hour, minute, 0, 0);
    capturedAt = captured.toISOString();
    name = collapseWhitespace(header.replace(match[0], ''));
  }

  name = name.replace(/^[·•|,\-–—\s]+|[·•|,\-–—\s]+$/g, '');
  name = collapseRepeatedName(name);
  return { name, capturedAt };
}

export type CleanableTranscriptEntry = {
  id?: string;
  participantName: string;
  participantAvatarUrl?: string;
  text: string;
  capturedAt: string;
  source: string;
};

export type TranscriptCleaningResult = {
  entries: Array<Required<Pick<CleanableTranscriptEntry, 'id'>> & Omit<CleanableTranscriptEntry, 'id'>>;
  originalCaptionChars: number;
  cleanedCaptionChars: number;
  removedCaptionChars: number;
  originalEntries: number;
  cleanedEntries: number;
};

type CleaningStream = {
  name: string;
  source: string;
  historyText: string;
  lastSnapshotText: string;
  segmentStart: number;
  currentIndex: number | null;
  currentOpenedAt: number;
  lastSeenAt: number;
};

const CLEANER_REATTACH_MS = 12_000;
const CLEANER_SEGMENT_MAX = 700;
const CLEANER_SEGMENT_AGE_MS = 25_000;

function normalizeImportedName(name: string): string {
  return collapseRepeatedName(collapseWhitespace(name).replace(/\s+(?:AM|PM)$/i, ''));
}

function safeTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Limpa transcrições geradas pelas versões antigas, que salvavam cada snapshot cumulativo inteiro.
 * É pura e não altera o arquivo original: o chamador recebe uma nova lista pronta para importar.
 */
export function cleanRollingTranscript(
  input: readonly CleanableTranscriptEntry[],
): TranscriptCleaningResult {
  const ordered = input
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => safeTime(a.entry.capturedAt) - safeTime(b.entry.capturedAt) || a.order - b.order);
  const output: TranscriptCleaningResult['entries'] = [];
  const streamsBySpeaker = new Map<string, CleaningStream[]>();
  const recentEvents = new Map<string, number>();
  let generatedId = 0;
  let originalCaptionChars = 0;

  const nextId = (base?: string) => {
    generatedId++;
    const safeBase = (base || 'legacy').slice(0, 120);
    return `${safeBase}-clean-${generatedId}`;
  };

  const createStream = (entry: CleanableTranscriptEntry, name: string, now: number): CleaningStream => {
    const stream: CleaningStream = {
      name,
      source: entry.source,
      historyText: '',
      lastSnapshotText: '',
      segmentStart: 0,
      currentIndex: null,
      currentOpenedAt: now,
      lastSeenAt: now,
    };
    const key = `${entry.source}\u0000${name}`;
    const streams = streamsBySpeaker.get(key) ?? [];
    streams.push(stream);
    streamsBySpeaker.set(key, streams.slice(-40));
    return stream;
  };

  const findStream = (entry: CleanableTranscriptEntry, name: string, now: number) => {
    const key = `${entry.source}\u0000${name}`;
    const streams = streamsBySpeaker.get(key) ?? [];
    for (let i = streams.length - 1; i >= 0; i--) {
      const candidate = streams[i]!;
      const probe = mergeRollingCaption(candidate.historyText, candidate.lastSnapshotText, entry.text);
      if (probe.kind === 'new') continue;
      const recent = now - candidate.lastSeenAt <= CLEANER_REATTACH_MS;
      const strongOverlap = candidate.lastSnapshotText.length >= 80 && entry.text.length >= 80;
      if (recent || strongOverlap) return candidate;
    }
    return undefined;
  };

  const emitStream = (stream: CleaningStream, entry: CleanableTranscriptEntry, now: number) => {
    while (stream.segmentStart < stream.historyText.length) {
      while (stream.historyText[stream.segmentStart] === ' ') stream.segmentStart++;
      const pending = stream.historyText.slice(stream.segmentStart);
      if (!pending) break;
      const cut = findCaptionSegmentCut(pending, 520, CLEANER_SEGMENT_MAX);
      const text = pending.slice(0, cut).trim();
      if (!text) break;

      if (stream.currentIndex == null) {
        stream.currentIndex = output.length;
        stream.currentOpenedAt = now;
        output.push({
          id: nextId(entry.id),
          participantName: stream.name,
          participantAvatarUrl: entry.participantAvatarUrl,
          text,
          capturedAt: entry.capturedAt,
          source: stream.source,
        });
      } else {
        const current = output[stream.currentIndex]!;
        current.text = text;
        if (entry.participantAvatarUrl) current.participantAvatarUrl = entry.participantAvatarUrl;
      }

      if (cut < pending.length) {
        stream.segmentStart += cut;
        stream.currentIndex = null;
        continue;
      }
      break;
    }

    if (
      stream.currentIndex != null &&
      output[stream.currentIndex]!.text.length >= 60 &&
      now - stream.currentOpenedAt >= CLEANER_SEGMENT_AGE_MS
    ) {
      stream.segmentStart = stream.historyText.length;
      stream.currentIndex = null;
    }
  };

  for (const { entry } of ordered) {
    const text = collapseWhitespace(entry.text);
    if (!text) continue;
    const name = normalizeImportedName(entry.participantName) || 'Participante';
    const now = safeTime(entry.capturedAt);

    if (!entry.source.endsWith('-caption')) {
      if (entry.source.endsWith('-event')) {
        const eventKey = `${entry.source}\u0000${name}\u0000${normalizeText(text)}`;
        const previous = recentEvents.get(eventKey);
        if (previous != null && now - previous <= 10_000) continue;
        recentEvents.set(eventKey, now);
      }
      output.push({
        id: entry.id || nextId(),
        participantName: name,
        participantAvatarUrl: entry.participantAvatarUrl,
        text,
        capturedAt: entry.capturedAt,
        source: entry.source,
      });
      continue;
    }

    originalCaptionChars += text.length;
    let stream = findStream(entry, name, now) ?? createStream(entry, name, now);
    let merged = mergeRollingCaption(stream.historyText, stream.lastSnapshotText, text);
    if (merged.kind === 'new') {
      stream = createStream(entry, name, now);
      merged = mergeRollingCaption('', '', text);
    }
    stream.historyText = merged.history;
    stream.lastSnapshotText = text;
    stream.lastSeenAt = now;
    stream.segmentStart = Math.min(stream.segmentStart, stream.historyText.length);
    emitStream(stream, entry, now);
  }

  output.sort((a, b) => safeTime(a.capturedAt) - safeTime(b.capturedAt));
  const cleanedCaptionChars = output
    .filter((entry) => entry.source.endsWith('-caption'))
    .reduce((sum, entry) => sum + entry.text.length, 0);
  return {
    entries: output,
    originalCaptionChars,
    cleanedCaptionChars,
    removedCaptionChars: Math.max(0, originalCaptionChars - cleanedCaptionChars),
    originalEntries: input.length,
    cleanedEntries: output.length,
  };
}
