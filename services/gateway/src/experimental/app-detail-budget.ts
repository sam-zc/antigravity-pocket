import type { AppActivity } from '@pocket/protocol';
/** Deterministic aggregate omission; identity/order are never dropped. Also reserves room for persistence metadata. */
export function budgetActivityDetails<T extends { activity?: AppActivity }>(
  rows: T[],
): T[] {
  const base = rows.map((row) =>
    row.activity?.detail
      ? {
          ...row,
          activity: {
            ...row.activity,
            detail: undefined,
            detailOmission: 'window_budget' as const,
          },
        }
      : row,
  );
  let remaining = Math.max(
    0,
    Math.min(4096, 24000 - Buffer.byteLength(JSON.stringify(base)) - 512),
  );
  return rows.map((row, index) => {
    if (!row.activity?.detail) return row;
    const size = Buffer.byteLength(JSON.stringify(row.activity.detail));
    if (size > remaining) return base[index]!;
    remaining -= size;
    return row;
  });
}
