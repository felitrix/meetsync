// Camada fina de compatibilidade entre navegadores.
//
// No Firefox o namespace `chrome` existe apenas como alias baseado em callbacks; a API com
// Promises vive em `browser`. Como este projeto usa `chrome.*` com `await` em todo lugar,
// apontamos `chrome` para `browser` quando estamos no Firefox. Importar este módulo ANTES de
// qualquer outro é suficiente (os imports ES executam na ordem de declaração).

declare global {
  var browser: typeof chrome | undefined;
}

/** Estamos rodando no Firefox? (o Chrome 148+ também expõe `browser`, então usamos o UA.) */
export const IS_FIREFOX = /\bFirefox\//.test(
  (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? '',
);

if (IS_FIREFOX && globalThis.browser) {
  (globalThis as unknown as { chrome: typeof chrome }).chrome = globalThis.browser;
}

/**
 * Opções de notificação aceitas pelo navegador atual. O Firefox só implementa
 * type/title/message/iconUrl e RECUSA (schema estrito) `priority`/`requireInteraction`.
 */
export function notificationOptions<T extends Record<string, unknown>>(opts: T): T {
  if (!IS_FIREFOX) return opts;
  const { priority: _priority, requireInteraction: _requireInteraction, ...rest } = opts;
  return rest as T;
}
