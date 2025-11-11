import fetch from "node-fetch";
import puppeteer from "puppeteer";

const CHALLONGE_URL = process.env.CHALLONGE_URL || "https://challonge.com/LEAGUEVG/module";
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const MAX_ROWS = parseInt(process.env.MAX_ROWS || "12", 10);

if (!SLACK_WEBHOOK) {
  console.error("SLACK_WEBHOOK_URL is missing");
  process.exit(1);
}

// format exactly: "#  Name                      Pts   W   L"
function makeBlock(rows) {
  const hdr = rows[0].map(s => String(s || "").trim().toLowerCase());

  // lock columns to these titles, but be tolerant of spacing
  const idx = {
    rank:  hdr.findIndex(h => h === "#" || h === "rank" || h === "pos" || h === "position"),
    name:  hdr.findIndex(h => h === "name" || h === "player" || h === "team"),
    pts:   hdr.findIndex(h => h === "pts" || h === "points"),
    w:     hdr.findIndex(h => h === "w" || h === "wins"),
    l:     hdr.findIndex(h => h === "l" || h === "losses"),
  };

  // if any are missing, fall back to reasonable guesses by label
  const colCount = hdr.length;
  const need = k => idx[k] < 0;
  if (need("name"))  idx.name = Math.max(0, hdr.findIndex(h => /name|player|team/.test(h)));
  if (need("pts"))   idx.pts  = hdr.findIndex(h => /(pts|points|score)/.test(h));
  if (need("w"))     idx.w    = hdr.findIndex(h => /(^|[^a-z])w(in|ins)?$/.test(h));
  if (need("l"))     idx.l    = hdr.findIndex(h => /(^|[^a-z])l(oss|osses)?$/.test(h));
  if (need("rank"))  idx.rank = hdr.findIndex(h => /(rank|pos|position|#)/.test(h));

  // render
  const body = rows.slice(1, 1 + Math.min(MAX_ROWS, rows.length - 1));
  const lines = [];
  lines.push("```#  Name                      Pts   W   L");
  for (const r of body) {
    const rank = idx.rank >= 0 && r[idx.rank] != null ? String(r[idx.rank]).trim() : "";
    const name = idx.name >= 0 && r[idx.name] != null ? String(r[idx.name]) : "";
    const pts  = idx.pts  >= 0 && r[idx.pts]  != null ? String(r[idx.pts]).trim()  : "";
    const w    = idx.w    >= 0 && r[idx.w]    != null ? String(r[idx.w]).trim()    : "";
    const l    = idx.l    >= 0 && r[idx.l]    != null ? String(r[idx.l]).trim()    : "";
    lines.push(`${rank.toString().padStart(2," ")}  ${name.padEnd(24)}  ${pts.padStart(3," ")}  ${w.padStart(2," ")}  ${l.padStart(2," ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}

// find the best-looking standings table in this frame or its children
async function extractRowsFromFrame(frame) {
  const rows = await frame.evaluate(() => {
    function tableToRows(table) {
      const out = [];
      for (const tr of table.querySelectorAll("tr")) {
        const cells = Array.from(tr.querySelectorAll("th,td")).map(td => td.innerText.trim());
        if (cells.length) out.push(cells);
      }
      return out;
    }

    const tables = Array.from(document.querySelectorAll("table"));
    let best = null, scoreBest = -1;
    for (const t of tables) {
      const txt = t.innerText.toLowerCase();
      let s = 0;
      if (txt.includes("name") || txt.includes("player") || txt.includes("team")) s += 2;
      if (txt.includes("pts") || txt.includes("points") || txt.includes("score")) s += 1;
      if (txt.includes("wins") || /\bw\b/.test(txt)) s += 1;
      if (txt.includes("losses") || /\bl\b/.test(txt)) s += 1;
      if (txt.includes("rank") || txt.includes("#")) s += 1;
      if (s > scoreBest) { best = t; scoreBest = s; }
    }

    if (!best) return [];

    const rows = tableToRows(best);
    if (!rows.length) return [];

    // if the first row is not a header, synthesize a simple header
    const headerLooksReal = rows[0].some(c => /#|rank|name|player|team|pts|points|w|wins|l|loss/i.test(c));
    if (!headerLooksReal) {
      const width = rows[0].length;
      const fake = Array(width).fill("");
      if (width >= 1) fake[0] = "#";
      if (width >= 2) fake[1] = "Name";
      if (width >= 3) fake[2] = "Pts";
      if (width >= 4) fake[3] = "W";
      if (width >= 5) fake[4] = "L";
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

  // always send something so it never looks like a no-op
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
