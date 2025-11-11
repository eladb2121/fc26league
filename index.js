function makeBlock(rows) {
  const header = rows[0].map(s => (s || "").toLowerCase().trim());
  const body = rows.slice(1, MAX_ROWS + 1);

  // 1) Name column, pick explicit, else most text-heavy
  let idxName = header.findIndex(h => /^(name|player|team)$/.test(h));
  if (idxName < 0) {
    let best = -1, bestLen = -1;
    for (let c = 0; c < header.length; c++) {
      const len = body.reduce((acc, r) => {
        const v = (r[c] || "").toString();
        return acc + (/\D/.test(v) ? v.length : 0);
      }, 0);
      if (len > bestLen) { best = c; bestLen = len; }
    }
    idxName = best >= 0 ? best : 0;
  }

  // 2) Try explicit W and L headers
  let idxWins   = header.findIndex(h => /^(w|win|wins)$/.test(h));
  let idxLosses = header.findIndex(h => /^(l|loss|losses)$/.test(h));

  // 3) If not found, look for a combined record column like "4-1" or "4 : 1"
  let idxRecord = -1;
  if (idxWins < 0 || idxLosses < 0) {
    const looksLikeRecord = v => /^\s*\d+\s*[-:]\s*\d+\s*$/.test(String(v || ""));
    for (let c = 0; c < header.length; c++) {
      if (c === idxName) continue;
      const hitRate = body.reduce((n, r) => n + (looksLikeRecord(r[c]) ? 1 : 0), 0) / body.length;
      if (hitRate > 0.6) { idxRecord = c; break; } // majority of rows look like W-L
    }
  }

  // 4) Build normalized rows with wins, losses
  const parsed = body.map(r => {
    const name = (r[idxName] ?? "").toString().trim();

    let w = null, l = null;
    if (idxRecord >= 0) {
      const m = String(r[idxRecord] || "").match(/(\d+)\s*[-:]\s*(\d+)/);
      if (m) { w = parseInt(m[1], 10); l = parseInt(m[2], 10); }
    } else {
      if (idxWins >= 0)   w = parseInt(String(r[idxWins]   || "").trim(), 10);
      if (idxLosses >= 0) l = parseInt(String(r[idxLosses] || "").trim(), 10);
    }

    // fallback to zero if parsing failed
    if (!Number.isFinite(w)) w = 0;
    if (!Number.isFinite(l)) l = 0;

    return { name, w, l };
  });

  // 5) Sort by wins desc, then losses asc, then name
  parsed.sort((a, b) => b.w - a.w || a.l - b.l || a.name.localeCompare(b.name));

  // 6) Render
  const lines = [];
  lines.push("```Name                      W   L");
  for (const row of parsed) {
    lines.push(`${row.name.padEnd(24)}  ${String(row.w).padStart(2," ")}  ${String(row.l).padStart(2," ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}
