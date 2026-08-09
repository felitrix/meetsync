// Regras puras de retenção do histórico, separadas do chrome.storage para teste com Node.

export const HISTORY_RETENTION_OPTIONS = [10, 20, 40] as const;
export type HistoryRetentionCount = (typeof HISTORY_RETENTION_OPTIONS)[number];

export function normalizeHistoryRetention(value: unknown): HistoryRetentionCount {
  return HISTORY_RETENTION_OPTIONS.includes(value as HistoryRetentionCount)
    ? (value as HistoryRetentionCount)
    : 40;
}

/**
 * Mantém os favoritos independentemente do limite e também as N reuniões não favoritas mais
 * recentes. A ordem original (mais nova primeiro) é preservada.
 */
export function selectHistoryIdsToKeep<T extends { id: string; starred: boolean }>(
  index: readonly T[],
  requestedLimit: unknown,
): Set<string> {
  const limit = normalizeHistoryRetention(requestedLimit);
  const favoriteIds = new Set(index.filter((item) => item.starred).map((item) => item.id));
  const keep = new Set(favoriteIds);
  let remaining = limit;
  for (const item of index) {
    if (keep.has(item.id)) continue;
    if (remaining <= 0) break;
    keep.add(item.id);
    remaining--;
  }
  return keep;
}
