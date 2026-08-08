import assert from 'node:assert/strict';
import test from 'node:test';

import { anonymizeTranscriptText, buildCatchUp, estimateTokens, extractEvidenceInsights } from '../src/services/meeting-insights.ts';

const base = {
  id: 'm1', provider: 'google-meet', meetingCode: 'abc-defg-hij', meetingUrl: '', participants: [],
};

test('o que perdi limita o intervalo e preserva a origem das falas', () => {
  const session = { ...base, transcript: [
    { id: 'a', participantName: 'Ana', text: 'fala antiga', capturedAt: '2026-08-06T10:00:00Z', source: 'google-meet-caption' },
    { id: 'b', participantName: 'Bia', text: 'fala recente', capturedAt: '2026-08-06T10:09:00Z', source: 'google-meet-caption' },
  ] };
  const result = buildCatchUp(session, 5);
  assert.match(result, /Bia \(fala\): fala recente/);
  assert.doesNotMatch(result, /fala antiga/);
});

test('decisões e ações sempre apontam para uma fala existente', () => {
  const session = { ...base, markers: [{ id: 'mk', entryId: 'a', kind: 'highlight', createdAt: '2026-08-06T10:00:01Z' }], transcript: [
    { id: 'a', participantName: 'Ana', text: 'Vamos seguir com a opção B.', capturedAt: '2026-08-06T10:00:00Z', source: 'google-meet-caption' },
    { id: 'b', participantName: 'Bia', text: 'Eu vou enviar o arquivo amanhã.', capturedAt: '2026-08-06T10:01:00Z', source: 'google-meet-caption' },
  ] };
  const items = extractEvidenceInsights(session);
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => session.transcript.some((entry) => entry.id === item.entryId)));
  assert.equal(items[0].manual, true);
  assert.equal(items[1].owner, 'Bia');
  assert.equal(items[1].deadline?.toLowerCase(), 'amanhã');
});

test('anonimiza dados comuns e nomes antes do envio', () => {
  const input = 'Ana: veja https://exemplo.com e ana@empresa.com, CPF 123.456.789-00.';
  const result = anonymizeTranscriptText(input, ['Ana']);
  assert.doesNotMatch(result, /Ana|exemplo\.com|ana@empresa|123\.456/);
  assert.match(result, /\[PESSOA_1\]|\[EMAIL\]|\[LINK\]|\[CPF\]/);
  assert.ok(estimateTokens(result) >= Math.ceil(result.length / 3));
});
