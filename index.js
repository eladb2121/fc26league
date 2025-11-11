import fetch from "node-fetch";
import puppeteer from "puppeteer";

const CHALLONGE_URL = process.env.CHALLONGE_URL || "https://challonge.com/LEAGUEVG/module";
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const MAX_ROWS = parseInt(process.env.MAX_ROWS || "12", 10);

if (!SLACK_WEBHOOK) {
  console.error("SLACK_WEBHOOK_URL is missing");
  process.exit(1);
}

// only Wins and Losses
function makeBlock(rows) {
  const header = rows[0].map(s => (s || "").toLowerCase());
  const body = rows.slice(1, MAX_ROWS + 1);

  // try to find columns by header text
  let idxName   = header.findIndex(h => /name|player|team/.test(h));
  let idxWins   = header.findIndex(h => /\bwin(s)?\b|^w$/.test(h));
  let idxLosses = header.findIndex(h => /\bloss(es)?\b|^l$/.test(h));

  // fallbacks
  const cols = header.length;
  if (idxName < 0) {
    let best = -1, bestLen = -1;
    for (let c = 0; c < cols; c++) {
      const len = body.reduce((acc, r) => {
        const v = (r[c] || "").toString().trim();
        return acc + (/\D/.test(v) ? v.length : 0);
      }, 0);
      if (len > bestLen) { best = c; bestLen = len; }
    }
    idxName = best >= 0 ? best : 0;
  }
  if (idxWins < 0 || idxLosses < 0) {
    const numericScore = col => body.reduce((s, r) => s + (/^\d+$/.test((r[col] || "").toString().trim()) ? 1 : 0), 0);
    const scores = Array.from({ length: cols }, (_, c) => ({ c, s: numericScore(c) }))
      .sort((a, b) => b.s - a.s)
      .map(o => o.c)
      .filter(c => c !== idxName);
    if (idxWins < 0 && scores[0] != null) idxWins = scores[0];
    if (idxLosses < 0 && scores[1] != null) idxLosses = scores[1];
  }

  const lines = [];
  lines.push("```Name                      W   L");
  for (const r of body) {
    const name = (r[idxName] ?? "").toString();
    const w = (r[idxWins] ?? "").toString();
    const l = (r[idxLosses] ?? "").toString();
    lines.push(`${name.padEnd(24)}  ${w.padStart(2," ")}  ${l.padStart(2," ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}

// search recursively in all frames for a table
async function extractRowsFromFrame(frame) {
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

  for (const child of frame.childFrames()) {
    const r = await extractRowsFromFrame(child);
    if (r.length) return r;
  }
  return [];
}

async function run() {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();

  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit(537.36) Chrome/124 Safari/537.36");
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page.goto(CHALLONGE_URL, { waitUntil: "networkidle2", timeout: 60000 });

  await new Promise(r => setTimeout(r, 4000));

  let rows = await extractRowsFromFrame(page.mainFrame());
  if (!rows.length) {
    await new Promise(r => setTimeout(r, 4000));
    rows = await extractRowsFromFrame(page.mainFrame());
  }

  await browser.close();

  if (!rows || rows.length < 2) {
    const fallbackText = `Challonge leaderboard\n${CHALLONGE_URL}\nNo table found.`;
    await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: fallbackText })
    });
    return;
  }

  const block = makeBlock(rows);
  const title = "*Daily Challonge leaderboard*";
  const payload = { text: `${title}\n${block}\n${CHALLONGE_URL}` };

  const res = await fetch(SLACK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    console.error("Slack webhook failed", await res.text());
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
