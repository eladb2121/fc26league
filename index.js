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

function makeBlock(rows) {
  const header = rows[0].map(s => s.toLowerCase());
  const idx = {
    name: header.findIndex(h => /name|player|team/.test(h)),
    wins: header.findIndex(h => /win|w\b/.test(h)),
    losses: header.findIndex(h => /loss|l\b/.test(h))
  };

  const body = rows.slice(1, MAX_ROWS + 1);
  const lines = [];
  lines.push("```Name                      W   L");
  for (const r of body) {
    const name = idx.name >= 0 ? r[idx.name] : r[1] || "";
    const w = idx.wins >= 0 ? r[idx.wins] : "";
    const l = idx.losses >= 0 ? r[idx.losses] : "";
    lines.push(`${name.padEnd(24)}  ${String(w || "").padStart(2," ")}  ${String(l || "").padStart(2," ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}

  };

  const body = rows.slice(1, MAX_ROWS + 1);
  const lines = [];
  lines.push("```#  Name                      Pts   W   L");
  for (const r of body) {
    const rank = idx.rank >= 0 ? r[idx.rank] : "";
    const name = idx.name >= 0 ? r[idx.name] : r[1] || "";
    const pts  = idx.points >= 0 ? r[idx.points] : "";
    const w    = idx.wins >= 0 ? r[idx.wins] : "";
    const l    = idx.losses >= 0 ? r[idx.losses] : "";
    const rank2 = String(rank || lines.length).padStart(2, " ");
    lines.push(`${rank2}  ${pad(name, 24)}  ${String(pts || "").padStart(3," ")}  ${String(w || "").padStart(2," ")}  ${String(l || "").padStart(2," ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}

// helper: searches recursively in all frames
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

  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36");
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
