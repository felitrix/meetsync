import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeHistoryRetention,
  selectHistoryIdsToKeep,
} from '../src/services/retention-utils.ts';

test('normaliza retenção inválida para 40', () => {
  assert.equal(normalizeHistoryRetention(20), 20);
  assert.equal(normalizeHistoryRetention(15), 40);
  assert.equal(normalizeHistoryRetention('10'), 40);
});

test('mantém favoritos além do limite e as reuniões comuns mais recentes', () => {
  const index = [
    { id: 'newest', starred: false },
    { id: 'favorite-old', starred: true },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `regular-${i}`, starred: false })),
  ];
  const keep = selectHistoryIdsToKeep(index, 10);
  assert.equal(keep.has('favorite-old'), true);
  assert.equal(keep.has('newest'), true);
  assert.equal(keep.has('regular-8'), true);
  assert.equal(keep.has('regular-9'), false);
  assert.equal(keep.size, 11);
});
