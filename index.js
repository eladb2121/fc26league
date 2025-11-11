import fetch from "node-fetch";
import puppeteer from "puppeteer";

const CHALLONGE_URL = process.env.CHALLONGE_URL || "https://challonge.com/LEAGUEVG/module";
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const MAX_ROWS = parseInt(process.env.MAX_ROWS || "12", 10);

if (!SLACK_WEBHOOK) {
  console.error("SLACK_WEBHOOK_URL is missing");
  process.exit(1);
}

// pad helper
function pad(str, width) {
  str = String(str ?? "");
  return str.length >= width ? str.slice(0, width - 1) + "…" : str.padEnd(width, " ");
}

// ------------ Main Wins/Losses parser ------------
function makeBlock(rows) {
  const header = rows[0].map(s => (s || "").toLowerCase().trim());
  const body = rows.slice(1, MAX_ROWS + 1);

  // 1) pick the Name column (explicit or most text-heavy)
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

  // 4) Parse each row
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

    if (!Number.isFinite(w)) w = 0;
    if (!Number.isFinite(l)) l = 0;

    return { name, w, l };
  });

  // 5) Sort by wins desc, then losses asc, then name
  parsed.sort((a, b) => b.w - a.w || a.l - b.l || a.name.localeCompare(b.name));

  // 6) Render Slack block
  const lines = [];
  lines.push("```Name                      W   L");
  for (const row of parsed) {
    lines.push(`${row.name.padEnd(24)}  ${String(row.w).padStart(2," ")}  ${String(row.l).padStart(2," ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}
// -------------------------------------------------

// recursive table extraction from frames
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

  console.log("Rows found:", rows.length);
  if (!rows || rows.length < 2) {
    const fallbackText = `Challonge leaderboard\n${CHALLONGE_URL}\nNo table found.`;
    console.log("No table found, sending fallback.");
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

  console.log("Posting to Slack...");
  const res = await fetch(SLACK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  console.log("Slack response:", res.status, text);

  if (!res.ok) {
    console.error("Slack webhook failed");
    process.exit(1);
  }
}

run().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
