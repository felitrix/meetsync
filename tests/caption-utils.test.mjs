import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptionReplayGuard,
  analyzeCaptionReplay,
  cleanRollingTranscript,
  findCaptionSegmentCut,
  mergeRollingCaption,
  parseChatHeader,
} from '../src/content/caption-utils.ts';

test('bloqueia replay em massa depois de restaurar o navegador sem bloquear conteúdo novo', () => {
  const guard = new CaptionReplayGuard(500);
  const start = Date.parse('2026-07-27T15:00:00.000Z');
  for (let i = 0; i < 120; i++) {
    guard.remember('Participante', `Legenda histórica suficientemente longa número ${i} para representar um bloco finalizado.`, start + i);
  }

  const restoredAt = start + 6 * 60_000;
  for (let i = 0; i < 120; i++) {
    assert.equal(
      guard.shouldBlock(
        'Participante',
        `Legenda histórica suficientemente longa número ${i} para representar um bloco finalizado.`,
        restoredAt,
        'resume',
      ),
      true,
    );
  }
  assert.equal(
    guard.shouldBlock('Participante', 'Conteúdo realmente novo falado enquanto a janela estava minimizada.', restoredAt, 'resume'),
    false,
  );
});

test('permite uma frase curta legítima novamente depois da janela normal de deduplicação', () => {
  const guard = new CaptionReplayGuard();
  const start = Date.parse('2026-07-27T15:00:00.000Z');
  guard.remember('Ana', 'Sim', start);
  assert.equal(guard.shouldBlock('Ana', 'sim!', start + 2_000), true);
  assert.equal(guard.shouldBlock('Ana', 'sim!', start + 5_000), false);
});

test('mantém o cache de replay limitado', () => {
  const guard = new CaptionReplayGuard(3);
  for (let i = 0; i < 10; i++) guard.remember('Ana', `frase ${i}`, i);
  assert.equal(guard.size, 3);
});

test('bloqueia bloco longo durante toda a sessao mesmo fora do modo resume', () => {
  const guard = new CaptionReplayGuard();
  const value = 'Este e um bloco longo de legenda que precisa permanecer protegido durante toda a reuniao para nao reaparecer varios minutos depois.';
  guard.remember('Ana', value, 0);
  assert.equal(guard.shouldBlock('Ana', value, 13 * 60_000, 'normal'), true);
});

test('detecta backup com replay de legendas e IDs diferentes', () => {
  const base = {
    participantName: 'Ana',
    capturedAt: '2026-07-27T15:05:00.000Z',
    source: 'google-meet-caption',
  };
  const entries = Array.from({ length: 25 }, (_, index) => ({
    ...base,
    id: String(index),
    text: index < 20
      ? 'Bloco antigo repetido durante a retomada da janela.'
      : `Uma fala realmente nova ${index}.`,
  }));
  const stats = analyzeCaptionReplay(entries);
  assert.equal(stats.captionEntries, 25);
  assert.equal(stats.duplicateEntries, 19);
  assert.equal(stats.likelyReplay, true);
});

test('não classifica poucas repetições legítimas como surto de retomada', () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    participantName: 'Ana',
    capturedAt: `2026-07-27T15:05:${String(index).padStart(2, '0')}.000Z`,
    source: 'google-meet-caption',
    text: index < 3 ? 'Tudo certo.' : `Comentário único número ${index}.`,
  }));
  assert.equal(analyzeCaptionReplay(entries).likelyReplay, false);
});

test('reconcilia janela deslizante sem repetir o trecho sobreposto', () => {
  const result = mergeRollingCaption(
    'um dois três quatro cinco seis',
    'um dois três quatro cinco seis',
    'três quatro cinco seis sete oito',
  );
  assert.equal(result.kind, 'continued');
  assert.equal(result.history, 'um dois três quatro cinco seis sete oito');
  assert.equal(result.appended, 'sete oito');
});

test('reconcilia uma janela longa no mesmo porte observado na transcrição real', () => {
  const words = Array.from({ length: 2_700 }, (_, index) => `palavra${index}`);
  const previous = words.slice(0, 2_500).join(' ');
  const current = words.slice(160).join(' ');
  const result = mergeRollingCaption(previous, previous, current);
  assert.equal(result.kind, 'continued');
  assert.equal(result.history, words.join(' '));
  assert.equal(result.appended, words.slice(2_500).join(' '));
});

test('mantém snapshot já contido no histórico como duplicata', () => {
  const result = mergeRollingCaption(
    'agora vamos analisar o anúncio e depois revisar o preço',
    'agora vamos analisar o anúncio e depois revisar o preço',
    'analisar o anúncio e depois revisar',
  );
  assert.equal(result.kind, 'unchanged');
  assert.equal(result.appended, '');
});

test('distingue uma nova fala sem sobreposição', () => {
  const result = mergeRollingCaption(
    'primeira explicação sobre o anúncio',
    'primeira explicação sobre o anúncio',
    'obrigado pela resposta',
  );
  assert.equal(result.kind, 'new');
  assert.equal(result.history, 'obrigado pela resposta');
});

test('aceita correção da palavra incompleta no fim da mesma fala', () => {
  const result = mergeRollingCaption(
    'agora podemos abrir a central de promo',
    'agora podemos abrir a central de promo',
    'agora podemos abrir a central de promoção',
  );
  assert.equal(result.kind, 'continued');
  assert.equal(result.history, 'agora podemos abrir a central de promoção');
});

test('remove AM do horário e colapsa nome duplicado no chat', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const result = parseChatHeader('Artesanato Costa Artesanato Costa 11:08 AM', now);
  assert.equal(result.name, 'Artesanato Costa');
  const captured = new Date(result.capturedAt);
  assert.equal(captured.getHours(), 11);
  assert.equal(captured.getMinutes(), 8);
});

test('converte corretamente meia-noite e meio-dia no relógio de 12 horas', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  assert.equal(new Date(parseChatHeader('Pessoa 12:05 AM', now).capturedAt).getHours(), 0);
  assert.equal(new Date(parseChatHeader('Pessoa 12:05 PM', now).capturedAt).getHours(), 12);
});

test('corta fala longa em limite de palavra ou pontuação', () => {
  const text = `${'palavra '.repeat(90)}Fim da ideia. ${'continuação '.repeat(30)}`.trim();
  const cut = findCaptionSegmentCut(text, 520, 700);
  assert.ok(cut > 250);
  assert.ok(cut <= 700);
  assert.notEqual(text[cut - 1], 'r');
});

test('limpa uma exportação antiga cumulativa sem alterar chat legítimo', () => {
  const source = 'google-meet-caption';
  const cleaned = cleanRollingTranscript([
    {
      id: '1',
      participantName: 'Ana',
      text: 'um dois três quatro cinco seis',
      capturedAt: '2026-07-22T14:00:00.000Z',
      source,
    },
    {
      id: '2',
      participantName: 'Ana',
      text: 'um dois três quatro cinco seis sete oito',
      capturedAt: '2026-07-22T14:00:02.000Z',
      source,
    },
    {
      id: '3',
      participantName: 'Ana',
      text: 'três quatro cinco seis sete oito nove dez',
      capturedAt: '2026-07-22T14:00:04.000Z',
      source,
    },
    {
      id: '4',
      participantName: 'Artesanato Costa Artesanato Costa AM',
      text: 'Mensagem única',
      capturedAt: '2026-07-22T14:00:05.000Z',
      source: 'google-meet-chat',
    },
  ]);
  const captions = cleaned.entries.filter((entry) => entry.source === source);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].text, 'um dois três quatro cinco seis sete oito nove dez');
  assert.equal(cleaned.entries.find((entry) => entry.source === 'google-meet-chat').participantName, 'Artesanato Costa');
  assert.ok(cleaned.removedCaptionChars > 0);
});

test('agrupa eventos anônimos repetidos ao limpar arquivo antigo', () => {
  const cleaned = cleanRollingTranscript([
    {
      participantName: 'Alguém',
      text: 'Alguém reagiu 👍',
      capturedAt: '2026-07-22T14:00:00.000Z',
      source: 'google-meet-event',
    },
    {
      participantName: 'Alguém',
      text: 'Alguém reagiu 👍',
      capturedAt: '2026-07-22T14:00:06.000Z',
      source: 'google-meet-event',
    },
  ]);
  assert.equal(cleaned.entries.length, 1);
});
