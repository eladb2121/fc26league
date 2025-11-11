import fetch from "node-fetch";
import puppeteer from "puppeteer";

const CHALLONGE_URL = process.env.CHALLONGE_URL || "https://challonge.com/LEAGUEVG/module";
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const MAX_ROWS = parseInt(process.env.MAX_ROWS || "12", 10);

if (!SLACK_WEBHOOK) {
  console.error("SLACK_WEBHOOK_URL is missing");
  process.exit(1);
}

// helper to pad names
function pad(str, width) {
  str = String(str ?? "");
  return str.length >= width ? str.slice(0, width - 1) + "…" : str.padEnd(width, " ");
}

// ===== Simple formatter: "#  Name  Pts  W  L" =====
function makeBlock(rows) {
  const header = rows[0].map(s => String(s || "").trim().toLowerCase());
  const body = rows.slice(1);

  // pick NAME as the most text-heavy column, never a fully numeric column
  const colCount = header.length;
  let idxName = -1;
  let bestScore = -1;
  for (let c = 0; c < colCount; c++) {
    const values = body.map(r => String(r[c] ?? "").trim());
    const numericRatio = values.filter(v => /^\d+$/.test(v)).length / Math.max(values.length, 1);
    const textLen = values.reduce((acc, v) => acc + (/\D/.test(v) ? v.length : 0), 0);
    const score = (1 - numericRatio) * 1000 + textLen; // favor non numeric, then long text
    if (score > bestScore) { bestScore = score; idxName = c; }
  }

  // detect RANK if exists
  let idxRank = header.findIndex(h => h === "#" || h === "rank" || h === "pos" || h === "position");
  if (idxRank < 0) {
    // try any small integer sequential column not equal to name
    let bestSeq = -1, bestSeqIdx = -1;
    for (let c = 0; c < colCount; c++) {
      if (c === idxName) continue;
      const nums = body.map(r => parseInt(String(r[c] ?? "").trim(), 10)).filter(n => Number.isFinite(n));
      if (nums.length < Math.min(5, body.length)) continue;
      // measure how sequential it is
      let ok = 0;
      for (let i = 1; i < nums.length; i++) if (nums[i] === nums[i - 1] + 1) ok++;
      const ratio = ok / Math.max(nums.length - 1, 1);
      if (ratio > bestSeq) { bestSeq = ratio; bestSeqIdx = c; }
    }
    if (bestSeq > 0.6) idxRank = bestSeqIdx;
  }

  // detect PTS, W, L by header name only, do not guess
  const idxPts = header.findIndex(h => h === "pts" || h === "points" || h === "score");
  const idxW   = header.findIndex(h => h === "w" || h === "wins");
  const idxL   = header.findIndex(h => h === "l" || h === "losses");

  // keep order by rank if we have it
  const rowsSorted = [...body];
  if (idxRank >= 0) {
    rowsSorted.sort((a, b) => {
      const ra = parseInt(String(a[idxRank] ?? "").trim(), 10);
      const rb = parseInt(String(b[idxRank] ?? "").trim(), 10);
      if (Number.isFinite(ra) && Number.isFinite(rb)) return ra - rb;
      return 0;
    });
  }

  const lines = [];
  lines.push("```#  Name                      Pts   W   L");
  const max = Math.min(rowsSorted.length, MAX_ROWS);
  for (let i = 0; i < max; i++) {
    const r = rowsSorted[i];
    const rank = idxRank >= 0 ? String(r[idxRank] ?? "").trim() : String(i + 1);
    const name = pad(r[idxName] ?? "", 24);
    const pts  = idxPts >= 0 ? String(r[idxPts] ?? "").trim() : "";
    const w    = idxW   >= 0 ? String(r[idxW]   ?? "").trim() : "";
    const l    = idxL   >= 0 ? String(r[idxL]   ?? "").trim() : "";
    lines.push(`${rank.padStart(2, " ")}  ${name}  ${pts.padStart(3, " ")}  ${w.padStart(2, " ")}  ${l.padStart(2, " ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}

// ===== Find the standings table in this frame or children =====
async function extractRowsFromFrame(frame) {
  const rows = await frame.evaluate(() => {
    function tableToRows(t) {
      const out = [];
      for (const tr of t.querySelectorAll("tr")) {
        const cells = Array.from(tr.querySelectorAll("th,td")).map(td => td.innerText.trim());
        if (cells.length) out.push(cells);
      }
      return out;
    }
    const tables = Array.from(document.querySelectorAll("table"));
    let best = null, bestScore = -1;
    for (const t of tables) {
      const txt = t.innerText.toLowerCase();
      let s = 0;
      if (txt.includes("name") || txt.includes("player") || txt.includes("team")) s += 2;
      if (txt.includes("pts") || txt.includes("points") || txt.includes("score")) s += 1;
      if (txt.includes("wins") || /\bw\b/.test(txt)) s += 1;
      if (txt.includes("losses") || /\bl\b/.test(txt)) s += 1;
      if (txt.includes("rank") || txt.includes("#")) s += 1;
      if (s > bestScore) { best = t; bestScore = s; }
    }
    if (!best) return [];
    const rows = tableToRows(best);
    if (!rows.length) return [];

    // synthesize a header if first row is not a header
    const headerLooksReal = rows[0].some(c => /#|rank|name|player|team|pts|points|w|wins|l|loss/i.test(c));
    if (!headerLooksReal) {
      const w = rows[0].length;
      const fake = Array(w).fill("");
      if (w >= 1) fake[0] = "#";
      if (w >= 2) fake[1] = "Name";
      if (w >= 3) fake[2] = "Pts";
      if (w >= 4) fake[3] = "W";
      if (w >= 5) fake[4] = "L";
      rows.unshift(fake);
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
    const payload = { text: `Challonge leaderboard\n${CHALLONGE_URL}\nNo table found.` };
    const res = await fetch(SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error("Slack fallback failed", await res.text());
      process.exit(1);
    }
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
