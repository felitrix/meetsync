import assert from 'node:assert/strict';
import test from 'node:test';
import { BudgetLedger } from '../companion/relay-budget.mjs';

const limits = { dailyCalls: 5, meetingCalls: 2, inputPerCall: 16_000, outputPerCall: 1_200 };

function ledger(dateRef, initial) {
  const writes = [];
  return { writes, value: new BudgetLedger({ limits, initial, today: () => dateRef.value, persist: (state) => writes.push(state) }) };
}

test('reserva antes da chamada e bloqueia a terceira chamada da mesma reunião', () => {
  const date = { value: '2026-08-06' };
  const { value, writes } = ledger(date);
  value.reserve('m1', 100, 200);
  value.reserve('m1', 100, 200);
  assert.throws(() => value.reserve('m1', 100, 200), (error) => error.code === 'MEETING_LIMIT');
  assert.equal(writes.length, 2);
  assert.equal(value.snapshot().calls, 2);
});

test('bloqueia limites de entrada, saída e total diário', () => {
  const date = { value: '2026-08-06' };
  const { value } = ledger(date);
  assert.throws(() => value.reserve('large', 16_001, 1), (error) => error.code === 'INPUT_LIMIT');
  assert.throws(() => value.reserve('large', 1, 1_201), (error) => error.code === 'OUTPUT_LIMIT');
  for (let i = 0; i < 5; i++) value.reserve(`m${i}`, 1, 1);
  assert.throws(() => value.reserve('m6', 1, 1), (error) => error.code === 'DAILY_LIMIT');
});

test('vira o dia sem reaproveitar o saldo anterior', () => {
  const date = { value: '2026-08-06' };
  const { value } = ledger(date);
  value.reserve('m1', 100, 200);
  date.value = '2026-08-07';
  assert.equal(value.snapshot().calls, 0);
  value.reserve('m1', 100, 200);
  assert.equal(value.snapshot().calls, 1);
});
