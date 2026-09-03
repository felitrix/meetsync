// Auto-teste mínimo (sem framework): roda com `npm test`.
// Cobre a única lógica com ramificação por navegador — a poda das opções de notificação que o
// Firefox recusa. Se `notificationOptions` deixar passar `priority`/`requireInteraction` no
// Firefox, o alerta de menção para de aparecer lá e este check quebra.
import assert from 'node:assert/strict';

const load = async (ua) => {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true });
  // cache-busting: cada carga reavalia IS_FIREFOX com o UA atual.
  return import(`../src/lib/ext.ts?ua=${encodeURIComponent(ua)}`);
};

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';

const opts = { type: 'basic', title: 'a', message: 'b', iconUrl: 'c', priority: 2, requireInteraction: true };

const chromeMod = await load(CHROME_UA);
assert.equal(chromeMod.IS_FIREFOX, false);
assert.deepEqual(chromeMod.notificationOptions(opts), opts, 'Chrome deve receber as opções intactas');

const ffMod = await load(FIREFOX_UA);
assert.equal(ffMod.IS_FIREFOX, true);
assert.deepEqual(
  ffMod.notificationOptions(opts),
  { type: 'basic', title: 'a', message: 'b', iconUrl: 'c' },
  'Firefox não aceita priority/requireInteraction',
);

console.log('✓ selfcheck ok');
