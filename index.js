function makeBlock(rows) {
  const header = rows[0].map(s => (s || "").toLowerCase());
  const body = rows.slice(1, MAX_ROWS + 1);

  // header indexes
  const idx = {
    name:   header.findIndex(h => /^(name|player|team)$/.test(h)),
    wins:   header.findIndex(h => /^(w|win|wins)$/.test(h)),
    losses: header.findIndex(h => /^(l|loss|losses)$/.test(h)),
    pts:    header.findIndex(h => /(pts?|point|score)/.test(h))
  };

  // fallback for name: pick the most text-heavy column
  if (idx.name < 0) {
    let best = -1, bestLen = -1;
    const cols = header.length;
    for (let c = 0; c < cols; c++) {
      const len = body.reduce((acc, r) => {
        const v = (r[c] || "").toString().trim();
        return acc + (/\D/.test(v) ? v.length : 0);
      }, 0);
      if (len > bestLen) { best = c; bestLen = len; }
    }
    idx.name = best >= 0 ? best : 0;
  }

  // numeric helper
  const isNum = v => /^\d+$/.test((v ?? "").toString().trim());
  const numericScore = col => body.reduce((s, r) => s + (isNum(r[col]) ? 1 : 0), 0);

  // fallback for wins and losses: choose two most numeric columns, excluding name and pts
  if (idx.wins < 0 || idx.losses < 0) {
    const candidates = header.map((_, c) => c)
      .filter(c => c !== idx.name && c !== idx.pts);
    const ranked = candidates
      .map(c => ({ c, s: numericScore(c) }))
      .sort((a, b) => b.s - a.s)
      .map(o => o.c);

    if (idx.wins < 0 && ranked[0] != null) idx.wins = ranked[0];
    if (idx.losses < 0 && ranked[1] != null) idx.losses = ranked[1];
  }

  // safety: never let wins or losses use the pts column
  if (idx.pts >= 0) {
    if (idx.wins === idx.pts) idx.wins = -1;
    if (idx.losses === idx.pts) idx.losses = -1;
  }

  // if still missing one, try nearby numeric columns
  if (idx.wins < 0 || idx.losses < 0) {
    const cols = header.length;
    for (let c = 0; c < cols; c++) {
      if (c === idx.name || c === idx.pts) continue;
      if (idx.wins < 0 && numericScore(c) > 0) { idx.wins = c; continue; }
      if (idx.losses < 0 && numericScore(c) > 0) { idx.losses = c; break; }
    }
  }

  // build Slack block
  const lines = [];
  lines.push("```Name                      W   L");
  for (const r of body) {
    const name = (r[idx.name] ?? "").toString();
    const w = (r[idx.wins] ?? "").toString();
    const l = (r[idx.losses] ?? "").toString();
    lines.push(`${name.padEnd(24)}  ${w.padStart(2," ")}  ${l.padStart(2," ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}
