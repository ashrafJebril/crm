/** Page buttons to show: first, last, current ± 1, with "gap" for skipped runs. */
export function pageWindow(page: number, pageCount: number): Array<number | "gap"> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const keep = new Set([1, pageCount, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pageCount));
  // Fill a would-be gap of a single page instead of showing "…" for it.
  if (keep.has(3) && !keep.has(2)) keep.add(2);
  if (keep.has(pageCount - 2) && !keep.has(pageCount - 1)) keep.add(pageCount - 1);
  const sorted = [...keep].sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

/** "51–100 of 120" parts for the rows on the current page. */
export function rangeLabel(page: number, pageSize: number, total: number) {
  if (total === 0) return { from: 0, to: 0, total };
  const from = (page - 1) * pageSize + 1;
  return { from, to: Math.min(page * pageSize, total), total };
}
