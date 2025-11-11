async function extractRowsFromFrame(frame) {
  // get rows from any <table> in this frame
  const rows = await frame.evaluate(() => {
    function tableToRows(table) {
      const out = [];
      const trs = Array.from(table.querySelectorAll("tr"));
      for (const tr of trs) {
        const cells = Array.from(tr.querySelectorAll("th,td")).map(td => td.innerText.trim());
        if (cells.length) out.push(cells);
      }
      return out;
    }

    const tables = Array.from(document.querySelectorAll("table"));
    let best = null, bestScore = -1;

    for (const t of tables) {
      const txt = t.innerText.toLowerCase();
      let score = 0;
      if (txt.includes("rank") || txt.includes("#")) score += 2;
      if (txt.includes("name") || txt.includes("player") || txt.includes("team")) score += 2;
      if (txt.includes("wins") || /\bw\b/.test(txt)) score += 1;
      if (txt.includes("losses") || /\bl\b/.test(txt)) score += 1;
      if (txt.includes("points") || txt.includes("pts") || txt.includes("score")) score += 1;
      if (score > bestScore) { best = t; bestScore = score; }
    }

    if (!best && tables[0]) best = tables[0];
    if (!best) return [];

    const rows = tableToRows(best);
    if (!rows.length) return [];

    const headerHasText = rows[0].some(c => /rank|name|player|team|win|loss|pts|score|#/i.test(c));
    if (!headerHasText) {
      const width = rows[0].length;
      const fakeHeader = Array(width).fill("");
      if (width >= 1) fakeHeader[0] = "Rank";
      if (width >= 2) fakeHeader[1] = "Name";
      if (width >= 3) fakeHeader[2] = "W";
      if (width >= 4) fakeHeader[3] = "L";
      if (width >= 5) fakeHeader[4] = "Pts";
      rows.unshift(fakeHeader);
    }
    return rows;
  });

  if (rows.length) return rows;

  // try again inside nested iframes
  for (const child of frame.childFrames()) {
    const r = await extractRowsFromFrame(child);
    if (r.length) return r;
  }
  return [];
}
