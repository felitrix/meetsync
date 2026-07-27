import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findCaptionSegmentCut,
  mergeRollingCaption,
  parseChatHeader,
} from '../src/content/caption-utils.ts';

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
