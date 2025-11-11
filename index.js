function makeBlock(rows) {
  // lock to exact headers
  const header = rows[0].map(s => (s || "").toLowerCase().trim());
  const body = rows.slice(1, MAX_ROWS + 1);

  const idx = {
    rank: header.findIndex(h => h === "#" || h === "rank" || h === "pos" || h === "position"),
    name: header.findIndex(h => h === "name" || h === "player" || h === "team"),
    pts:  header.findIndex(h => h === "pts" || h === "points"),
    w:    header.findIndex(h => h === "w" || h === "wins"),
    l:    header.findIndex(h => h === "l" || h === "losses")
  };

  // keep order by rank if present and numeric
  const rowsSorted = [...body];
  if (idx.rank >= 0) {
    rowsSorted.sort((a, b) => {
      const ra = parseInt((a[idx.rank] ?? "").toString().trim(), 10);
      const rb = parseInt((b[idx.rank] ?? "").toString().trim(), 10);
      if (Number.isFinite(ra) && Number.isFinite(rb)) return ra - rb;
      return 0;
    });
  }

  const lines = [];
  lines.push("```#  Name                      Pts   W   L");
  for (const r of rowsSorted) {
    const rank = idx.rank >= 0 ? (r[idx.rank] ?? "").toString().trim() : "";
    const name = idx.name >= 0 ? (r[idx.name] ?? "").toString() : "";
    const pts  = idx.pts  >= 0 ? (r[idx.pts]  ?? "").toString().trim() : "";
    const w    = idx.w    >= 0 ? (r[idx.w]    ?? "").toString().trim() : "";
    const l    = idx.l    >= 0 ? (r[idx.l]    ?? "").toString().trim() : "";

    lines.push(
      `${rank.toString().padStart(2, " ")}  ${name.padEnd(24)}  ${pts.padStart(3, " ")}  ${w.padStart(2, " ")}  ${l.padStart(2, " ")}`
    );
  }
  lines.push("```");
  return lines.join("\n");
}
