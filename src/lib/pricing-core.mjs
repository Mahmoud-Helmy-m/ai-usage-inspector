// Provider-neutral cost primitives. Every provider's pricing module produces the
// same cost object — { input, output, cacheWrite, cacheRead, total } in USD — so
// the viewer's cards/charts work identically regardless of which AI tool the
// usage came from. Per-token rates and the usage-field mapping live in each
// provider's own pricing.mjs.

export const M = 1_000_000;

export function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function addCost(a, b) {
  const out = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
  const source =
    a.source === "estimated" || b.source === "estimated"
      ? "estimated"
      : b.source || a.source;
  if (source) out.source = source;
  if (a.estimated || b.estimated) out.estimated = true;
  // Which part was the guess — the rate or the token counts — so the UI can say.
  if (a.estimatedRate || b.estimatedRate) out.estimatedRate = true;
  // The rate-table revision the parts were worked out under, and the latest
  // revision that corrected any of their models' rates (see claude/pricing.mjs).
  // `relabels`: the revision that stopped labelling a part like these wrongly (see store.mjs).
  for (const key of ["rates", "supersedes", "relabels"]) {
    const values = [a[key], b[key]].filter((n) => typeof n === "number");
    if (values.length) out[key] = Math.max(...values);
  }
  return out;
}
