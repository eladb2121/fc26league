import fetch from "node-fetch";
import puppeteer from "puppeteer";

const CHALLONGE_URL = process.env.CHALLONGE_URL || "https://challonge.com/LEAGUEVG/module";
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const MAX_ROWS = parseInt(process.env.MAX_ROWS || "12", 10);

if (!SLACK_WEBHOOK) {
  console.error("SLACK_WEBHOOK_URL is missing");
  process.exit(1);
}

function pad(str, width) {
  str = String(str ?? "");
  return str.length >= width ? str.slice(0, width - 1) + "…" : str.padEnd(width, " ");
}

// ----------- NEW makeBlock (forced Wins/Losses logic) ------------
function makeBlock(rows) {
  const header = rows[0].map(s => (s || "").toLowerCase());
  const body = rows.slice(1, MAX_ROWS + 1);

  // 1) pick the Name column as the most text-heavy column
  const cols = header.length;
  let idxName = header.findIndex(h => /^(name|player|team)$/.test(h));
  if (idxName < 0) {
    let best = -1, bestLen = -1;
    for (let c = 0; c < cols; c++) {
      const len = body.reduce((acc, r) => {
        const v = (r[c] || "").toString();
        return acc + (/\D/.test(v) ? v.length : 0);
      }, 0);
      if (len > bestLen) { best = c; bestLen = len; }
    }
    idxName = best >= 0 ? best : 0;
  }

  // helpers
  const cleanNum = v => {
    const s = String(v ?? "").trim();
    if (!/^-?\d+$/.test(s)) return null;
    return parseInt(s, 10);
  };
  const isPtsHeader = h => /(pts?|point|score)/.test(h);
  const isRankHeader = h => /(rank|seed|pos|position|#)/.test(h);

  // 2) find numeric columns, exclude Name and obvious Pts or Rank columns
  const numericCols = [];
  for (let c = 0; c < cols; c++) {
    if (c === idxName) continue;
    const h = header[c] || "";
    if (isPtsHeader(h) || isRankHeader(h)) continue;

    const nums = body.map(r => cleanNum(r[c])).filter(v => v !== null);
    if (nums.length === 0) continue;

    // detect rank-like column, e.g., 1,2,3,4,...
    const isSequentialRank = nums.length >= 5 &&
      nums.every((v, i) => v === (nums[0] + i) || v === i + 1);
    if (isSequentialRank) continue;

    const maxVal = Math.max(...nums);
    const minVal = Math.min(...nums);

    // wins or losses are usually small integers, keep columns with values in 0..50
    const smallIntShare = nums.filter(v => v >= 0 && v <= 50).length / nums.length;

    numericCols.push({ c, count: nums.length, maxVal, minVal, smallIntShare });
  }

  // Prefer columns that are numeric for most rows and have small integers
  numericCols.sort((a, b) => {
    if (b.smallIntShare !== a.smallIntShare) return b.smallIntShare - a.smallIntShare;
    if (b.count !== a.count) return b.count - a.count;
    return a.maxVal - b.maxVal;
  });

  // 3) lock W and L: take the top two numeric candidates
  const idxWins = numericCols[0]?.c ?? -1;
  const idxLosses = numericCols[1]?.c ?? -1;

  // 4) build Slack block
  const lines = [];
  lines.push("```Name                      W   L");
  for (const r of body) {
    const name = (r[idxName] ?? "").toString();
    const w = idxWins >= 0 ? (r[idxWins] ?? "").toString() : "";
    const l = idxLosses >= 0 ? (r[idxLosses] ?? "").toString() : "";
    lines.push(`${name.padEnd(24)}  ${String(w).padStart(2," ")}  ${String(l).padStart(2," ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}
// ----------------------------------------------------------------

// search recursively in all frames
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
