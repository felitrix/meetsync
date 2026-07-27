// Captura das legendas do Google Meet — MÓDULO ISOLADO e de maior risco (§14, RNF-022).
//
// >>> AJUSTE AQUI quando o DOM do Meet mudar <<<
// Todos os seletores e heurísticas ficam concentrados neste arquivo para facilitar manutenção.
//
// Estratégia (sem depender de classes ofuscadas):
//  1. Localizar o container de legendas pelo aria-label ("Legendas"/"Captions").
//  2. Observar mutações nesse container (subtree + characterData), com coleta limitada por tempo.
//  3. Para cada "linha de fala" visível, extrair (nome, texto) por heurística de leaves.
//  4. Reconciliar a janela cumulativa/deslizante do Meet num fluxo sem repetição.
//  5. Dividir monólogos longos em blocos legíveis com horário progressivo.

import { store, cryptoRandomId } from '@/services/store';
import type { TranscriptEntry } from '@/types';
import { avatarFromCaptionRow, resolveSelfName } from './participant-resolver';
import { findCaptionSegmentCut, mergeRollingCaption } from './caption-utils';

// Seletores confirmados ao vivo (Meet PT-BR, jun/2026). O `jsname`/`jscontroller` são os
// mais estáveis; as classes ofuscadas (a4cQT etc.) ficam como último fallback.
const SELECTORS = {
  // Botão que liga/desliga legendas (toolbar inferior). jsname="RrG0hf" é específico do toggle
  // (evita casar com "Tipo de legenda", que é um combobox).
  captionsButton: [
    'button[jsname="RrG0hf"]',
    'button[aria-label*="Ativar legenda" i]',
    'button[aria-label*="Desativar legenda" i]',
    'button[aria-label*="turn on captions" i]',
    'button[aria-label*="turn off captions" i]',
  ],
  // Região onde o texto das legendas é exibido (só existe quando as legendas estão ligadas).
  captionContainer: [
    'div[role="region"][aria-label*="Legenda" i]',
    'div[role="region"][aria-label*="Caption" i]',
    'div[jscontroller="KPn5nb"]',
    '.a4cQT', // fallback frágil
  ],
};

const HARVEST_INTERVAL_MS = 180;
const MAX_SEGMENT_CHARS = 700;
const MAX_SEGMENT_AGE_MS = 25_000;
const MIN_TIMED_SEGMENT_CHARS = 60;
const STREAM_REATTACH_MS = 12_000;
const MIN_TEXT_LEN = 1;

type OpenSegment = {
  id: string;
  capturedAt: string;
  openedAt: number;
  emittedText: string;
  avatarUrl?: string;
};

type CaptionStream = {
  name: string;
  historyText: string;
  lastSnapshotText: string;
  segmentStart: number;
  currentSegment: OpenSegment | null;
  lastSeenAt: number;
};

/**
 * Texto "limpo" de um nó de legenda: ignora ícones (Material Symbols em <i>), elementos
 * decorativos (aria-hidden) e qualquer coisa dentro de botões/controles. Evita que ligaduras
 * de ícone (ex.: "arrow_downward") e rótulos de botões vazem para a transcrição.
 */
function cleanCaptionText(root: Element): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.tagName === 'I') return NodeFilter.FILTER_REJECT; // ícone
      if (p.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
      if (p.closest('button,[role="button"]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let out = '';
  let n = walker.nextNode();
  while (n) {
    out += ' ' + (n.textContent ?? '');
    n = walker.nextNode();
  }
  return out.replace(/\s+/g, ' ').trim();
}

function isElementUsable(el: Element): boolean {
  if (!el.isConnected) return false;
  if (el.closest('[hidden],[aria-hidden="true"]')) return false;
  const html = el as HTMLElement;
  if (html.style.display === 'none' || html.style.visibility === 'hidden') return false;
  try {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  } catch {
    // Alguns ambientes de teste não implementam getComputedStyle por completo.
  }
  return true;
}

function queryAny(selectors: string[], usableOnly = false): Element | null {
  for (const sel of selectors) {
    try {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (!usableOnly || isElementUsable(el)) return el;
      }
    } catch {
      /* seletor inválido em algum navegador — ignora */
    }
  }
  return null;
}

/** O botão de legendas está marcado como ativo? */
function isCaptionsButtonOn(btn: Element | null): boolean {
  if (!btn) return false;
  const pressed = btn.getAttribute('aria-pressed');
  if (pressed != null) return pressed === 'true';
  return false;
}

export class CaptionCapture {
  private observer: MutationObserver | null = null;
  private debounceId: number | null = null;
  private stateTimer: number | null = null;
  private container: Element | null = null;
  private rowToStream = new WeakMap<Element, CaptionStream>();
  private streamsBySpeaker = new Map<string, CaptionStream[]>();
  private running = false;

  start() {
    if (this.running) return;
    this.running = true;
    // Verifica periodicamente o estado das legendas (ligadas/desligadas) e (re)liga o observer.
    this.stateTimer = window.setInterval(() => this.syncCaptionState(), 1000);
    this.syncCaptionState();
  }

  stop() {
    this.running = false;
    this.detachObserver();
    if (this.stateTimer !== null) clearInterval(this.stateTimer);
    this.stateTimer = null;
    this.container = null;
    this.rowToStream = new WeakMap();
    this.streamsBySpeaker.clear();
  }

  /** Tenta ligar as legendas do Meet automaticamente (RF-036). Não desliga se já estiverem on. */
  tryEnableCaptions(): boolean {
    if (queryAny(SELECTORS.captionContainer, true) != null) return true; // já ligadas
    const btn = queryAny(SELECTORS.captionsButton, true) as HTMLElement | null;
    if (btn) {
      btn.click();
      return true;
    }
    // Fallback: atalho de teclado "c" do Meet.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    return false;
  }

  /** Alterna manualmente as legendas (botão CC do MeetSync — RF-020). */
  toggleCaptions() {
    const btn = queryAny(SELECTORS.captionsButton, true) as HTMLElement | null;
    if (btn) {
      btn.click();
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    }
    // Reavalia logo após o clique.
    window.setTimeout(() => this.syncCaptionState(), 400);
  }

  /** Detecta se legendas estão ativas e liga/desliga a captura conforme (RF-039/040). */
  private syncCaptionState() {
    const btn = queryAny(SELECTORS.captionsButton, true);
    const container = queryAny(SELECTORS.captionContainer, true);
    const on = isCaptionsButtonOn(btn) || container != null;

    store.setCaptionsOn(on);

    if (on && container) {
      if (this.container !== container) {
        this.detachObserver();
        this.container = container;
        this.attachObserver(container);
      }
      if (store.get().inMeeting) {
        store.setCaptureStartedAt(new Date().toISOString());
        if (store.get().captureStatus !== 'processing') store.setCaptureStatus('capturing');
      }
      this.harvest(); // leitura inicial
    } else {
      this.detachObserver();
      this.container = null;
      // Fecha falas abertas ao desligar legendas (mantém continuidade ao religar — RF-041).
      this.rowToStream = new WeakMap();
      if (store.get().inMeeting && store.get().captureStatus !== 'processing') {
        store.setCaptureStatus('waiting');
      }
    }
  }

  private attachObserver(container: Element) {
    this.observer = new MutationObserver(() => this.scheduleHarvest());
    this.observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  private detachObserver() {
    this.observer?.disconnect();
    this.observer = null;
    if (this.debounceId !== null) clearTimeout(this.debounceId);
    this.debounceId = null;
  }

  private scheduleHarvest() {
    // Throttle, não debounce de borda final: fala contínua não pode adiar a coleta indefinidamente.
    if (this.debounceId !== null) return;
    this.debounceId = window.setTimeout(() => {
      this.debounceId = null;
      this.harvest();
    }, HARVEST_INTERVAL_MS);
  }

  /** Lê as linhas de legenda atualmente visíveis e atualiza a transcrição. */
  private harvest() {
    if (!this.container || !isElementUsable(this.container)) {
      this.syncCaptionState();
      return;
    }
    const rows = this.findRows(this.container);
    for (const row of rows) {
      const parsed = this.parseRow(row);
      if (!parsed || parsed.text.length < MIN_TEXT_LEN) continue;

      // "Você" → nome configurado (resolvido aqui para manter dedup e downstream consistentes).
      parsed.name = resolveSelfName(parsed.name, store.get().settings.selfName);
      const name = parsed.name || 'Participante';
      const now = Date.now();
      let stream = this.rowToStream.get(row);

      if (!stream || stream.name !== name) {
        stream = this.findReattachStream(name, parsed.text, now);
        if (!stream || stream.name !== name) stream = this.createStream(name);
        this.rowToStream.set(row, stream);
      }

      let merged = mergeRollingCaption(stream.historyText, stream.lastSnapshotText, parsed.text);
      if (merged.kind === 'new') {
        // O Meet reciclou o mesmo nó para outra fala sem sobreposição textual.
        stream = this.createStream(name);
        this.rowToStream.set(row, stream);
        merged = mergeRollingCaption('', '', parsed.text);
      }

      stream.historyText = merged.history;
      stream.lastSnapshotText = parsed.text;
      stream.lastSeenAt = now;
      stream.segmentStart = Math.min(stream.segmentStart, stream.historyText.length);
      this.touchStream(stream);
      this.emitReadableSegments(stream, parsed.avatarUrl, now);
    }
  }

  private createStream(name: string): CaptionStream {
    return {
      name,
      historyText: '',
      lastSnapshotText: '',
      segmentStart: 0,
      currentSegment: null,
      lastSeenAt: Date.now(),
    };
  }

  /**
   * Reassocia um nó recriado pelo Meet ao fluxo anterior. Para textos longos, a sobreposição é
   * uma assinatura forte mesmo depois de vários minutos; para textos curtos, exigimos proximidade.
   */
  private findReattachStream(name: string, snapshot: string, now: number): CaptionStream | undefined {
    const streams = this.streamsBySpeaker.get(name) ?? [];
    for (let i = streams.length - 1; i >= 0; i--) {
      const candidate = streams[i]!;
      const probe = mergeRollingCaption(candidate.historyText, candidate.lastSnapshotText, snapshot);
      if (probe.kind === 'new') continue;
      const recent = now - candidate.lastSeenAt <= STREAM_REATTACH_MS;
      const strongLongOverlap =
        candidate.lastSnapshotText.length >= 80 && snapshot.length >= 80;
      if (recent || strongLongOverlap) return candidate;
    }
    return undefined;
  }

  private touchStream(stream: CaptionStream) {
    const streams = this.streamsBySpeaker.get(stream.name) ?? [];
    const previousIndex = streams.indexOf(stream);
    if (previousIndex >= 0) streams.splice(previousIndex, 1);
    streams.push(stream);
    if (streams.length > 40) streams.splice(0, streams.length - 40);
    this.streamsBySpeaker.set(stream.name, streams);
  }

  /**
   * Divide uma fala longa em blocos legíveis. Assim o usuário vê progresso contínuo e o horário
   * não fica preso no início de um monólogo de 10–15 minutos.
   */
  private emitReadableSegments(stream: CaptionStream, avatarUrl: string | undefined, now: number) {
    while (stream.segmentStart < stream.historyText.length) {
      while (stream.historyText[stream.segmentStart] === ' ') stream.segmentStart++;
      const pending = stream.historyText.slice(stream.segmentStart);
      if (!pending) break;

      const cut = findCaptionSegmentCut(pending, 520, MAX_SEGMENT_CHARS);
      const text = pending.slice(0, cut).trim();
      if (!text) break;
      this.upsertSegment(stream, text, avatarUrl, now);

      if (cut >= pending.length) break;
      stream.segmentStart += cut;
      stream.currentSegment = null;
    }

    const current = stream.currentSegment;
    if (
      current &&
      current.emittedText.length >= MIN_TIMED_SEGMENT_CHARS &&
      now - current.openedAt >= MAX_SEGMENT_AGE_MS
    ) {
      stream.segmentStart = stream.historyText.length;
      stream.currentSegment = null;
    }
  }

  private upsertSegment(stream: CaptionStream, text: string, avatarUrl: string | undefined, now: number) {
    let segment = stream.currentSegment;
    if (!segment) {
      segment = {
        id: cryptoRandomId(),
        capturedAt: new Date(now).toISOString(),
        openedAt: now,
        emittedText: '',
        avatarUrl,
      };
      stream.currentSegment = segment;
    }
    if (segment.emittedText === text && segment.avatarUrl === avatarUrl) return;
    segment.emittedText = text;
    segment.avatarUrl = avatarUrl;

    const entry: TranscriptEntry = {
      id: segment.id,
      participantName: stream.name,
      participantAvatarUrl: avatarUrl,
      text,
      capturedAt: segment.capturedAt,
      source: 'google-meet-caption',
    };
    store.upsertEntry(entry);
  }

  /**
   * Identifica as "linhas de fala" por ESTRUTURA, não por classe (classes do Meet são ofuscadas).
   * Cada fala é um filho direto da região de legendas que contém um avatar (<img>).
   * Botões/controles do Meet (ex.: "ir para o fim") NÃO têm avatar, então são ignorados.
   */
  private findRows(container: Element): Element[] {
    const imgs = Array.from(container.querySelectorAll('img'));
    const rows = new Set<Element>();

    for (const img of imgs) {
      // Ignora imagens dentro de botões/controles.
      if (img.closest('button,[role="button"]')) continue;
      let row: Element = img;
      while (row.parentElement && row.parentElement !== container) {
        row = row.parentElement;
      }
      if (row !== container && cleanCaptionText(row).length > 0) rows.add(row);
    }
    return Array.from(rows);
  }

  private findNameBlock(img: Element, boundary: Element): Element | null {
    let block = img.parentElement;
    while (block && block !== boundary) {
      if (cleanCaptionText(block).length > 0) return block;
      block = block.parentElement;
    }
    return null;
  }

  private removeSpeakerName(full: string, name: string): string {
    if (!name) return full;
    if (full.startsWith(name)) return full.slice(name.length).trim();
    return full.replace(name, '').trim();
  }

  /**
   * Extrai nome e fala de um bloco. Estrutura observada: o sub-bloco que contém o avatar
   * também contém o NOME; a fala é o restante do texto do bloco. Sem depender de classes.
   * Usa cleanCaptionText() para nunca incluir texto de ícones/botões (ex.: "arrow_downward").
   */
  private parseRow(row: Element): { name: string; text: string; avatarUrl?: string } | null {
    const full = cleanCaptionText(row);
    if (!full) return null;

    let name = '';
    const img = row.querySelector('img');
    if (img) {
      const nb = this.findNameBlock(img, row);
      if (nb && nb !== row) name = cleanCaptionText(nb);
    }

    const text = this.removeSpeakerName(full, name);

    if (!text) return null; // só o nome, fala ainda não começou
    return { name, text, avatarUrl: avatarFromCaptionRow(row) };
  }
}
