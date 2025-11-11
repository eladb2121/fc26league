import fetch from "node-fetch";
import puppeteer from "puppeteer";

const CHALLONGE_URL = process.env.CHALLONGE_URL || "https://challonge.com/LEAGUEVG/module";
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
// show everyone
const MAX_ROWS = parseInt(process.env.MAX_ROWS || "9999", 10);

if (!SLACK_WEBHOOK) {
  console.error("SLACK_WEBHOOK_URL is missing");
  process.exit(1);
}

function pad(str, width) {
  str = String(str ?? "");
  return str.length >= width ? str.slice(0, width - 1) + "…" : str.padEnd(width, " ");
}

/* ===================== table formatting: Name + W L T ===================== */
function makeBlock(rows) {
  const header = rows[0].map(s => String(s || "").trim().toLowerCase());
  const body = rows.slice(1);

  // choose Name column as most text heavy
  let idxName = header.findIndex(h => /^(name|player|team)$/.test(h));
  if (idxName < 0) {
    let best = -1, bestLen = -1;
    for (let c = 0; c < header.length; c++) {
      const len = body.reduce((acc, r) => {
        const v = String(r[c] ?? "");
        return acc + (/\D/.test(v) ? v.length : 0);
      }, 0);
      if (len > bestLen) { best = c; bestLen = len; }
    }
    idxName = best >= 0 ? best : 0;
  }

  // detect explicit W L T columns
  let idxW = header.findIndex(h => /^(w|wins)$/.test(h));
  let idxL = header.findIndex(h => /^(l|loss|losses)$/.test(h));
  let idxT = header.findIndex(h => /^(t|tie|ties|draw|draws)$/.test(h));

  // detect combined "4 - 1 - 0"
  let idxRecord = -1;
  if (idxW < 0 || idxL < 0) {
    const looksLikeWLT = v => /^\s*\d+\s*-\s*\d+\s*-\s*\d+\s*$/.test(String(v || ""));
    for (let c = 0; c < header.length; c++) {
      if (c === idxName) continue;
      const rate = body.reduce((n, r) => n + (looksLikeWLT(r[c]) ? 1 : 0), 0) / Math.max(body.length, 1);
      if (rate > 0.6) { idxRecord = c; break; }
    }
  }

  const limited = body.slice(0, MAX_ROWS);

  const lines = [];
  lines.push("```Name                      W   L   T");
  for (const r of limited) {
    const name = String(r[idxName] ?? "").trim();
    let w = 0, l = 0, t = 0;

    if (idxRecord >= 0) {
      const m = String(r[idxRecord] || "").match(/(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/);
      if (m) { w = parseInt(m[1], 10); l = parseInt(m[2], 10); t = parseInt(m[3], 10); }
    } else {
      if (idxW >= 0) w = parseInt(String(r[idxW] ?? "0").trim(), 10) || 0;
      if (idxL >= 0) l = parseInt(String(r[idxL] ?? "0").trim(), 10) || 0;
      if (idxT >= 0) t = parseInt(String(r[idxT] ?? "0").trim(), 10) || 0;
    }

    lines.push(`${pad(name, 24)}  ${String(w).padStart(2," ")}  ${String(l).padStart(2," ")}  ${String(t).padStart(2," ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}
/* ======================================================================== */

/* find the standings table in a frame, return rows and a way to click next */
async function scrapeCurrentPage(frame) {
  return await frame.evaluate(() => {
    function tableToRows(t) {
      const out = [];
      for (const tr of t.querySelectorAll("tr")) {
        const cells = Array.from(tr.querySelectorAll("th,td")).map(td => td.innerText.trim());
        if (cells.length) out.push(cells);
      }
      return out;
    }

    const tables = Array.from(document.querySelectorAll("table"));
    let best = null, score = -1;
    for (const t of tables) {
      const txt = t.innerText.toLowerCase();
      let s = 0;
      if (txt.includes("name") || txt.includes("player") || txt.includes("team")) s += 2;
      if (txt.includes("w") || txt.includes("wins")) s += 1;
      if (txt.includes("l") || txt.includes("loss")) s += 1;
      if (txt.includes("tie") || txt.includes("draw") || txt.includes(" t ")) s += 1;
      if (txt.includes("-") && /\d+\s*-\s*\d+/.test(txt)) s += 1;
      if (s > score) { score = s; best = t; }
    }
    if (!best) return { rows: [], hasNext: false, nextSelector: null };

    const rows = tableToRows(best);
    if (!rows.length) return { rows: [], hasNext: false, nextSelector: null };

    const headerLooksReal = rows[0].some(c => /name|player|team|w|wins|l|loss|t|tie|draw/i.test(c));
    if (!headerLooksReal) {
      const w = rows[0].length;
      const fake = Array(w).fill("");
      if (w >= 1) fake[0] = "Name";
      if (w >= 2) fake[1] = "W";
      if (w >= 3) fake[2] = "L";
      if (w >= 4) fake[3] = "T";
      rows.unshift(fake);
    }

    // try to find a next button in common Challonge pagers
    let nextSel = null;
    const candidates = [
      "a[rel='next']",
      "li.next a",
      ".pagination a.next",
      ".pager a.next",
      "a:contains('Next')"
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && !el.classList.contains("disabled") && !el.closest("li")?.classList.contains("disabled")) {
        nextSel = sel;
        break;
      }
    }
    const hasNext = !!nextSel;
    return { rows, hasNext, nextSelector: nextSel };
  });
}

/* walk frames to find the one that contains the standings table */
function findTargetFrame(page) {
  const frames = page.frames();
  return frames.find(f => f.url().includes("challonge") || f.url().includes("module")) || page.mainFrame();
}

/* collect all pages by clicking next until it disappears */
async function collectAllRows(page) {
  const target = findTargetFrame(page);
  let allRows = [];
  let headerAdded = false;

  for (let i = 0; i < 20; i++) { // hard cap to avoid infinite loop
    const { rows, hasNext, nextSelector } = await scrapeCurrentPage(target);
    if (!rows.length) break;

    if (!headerAdded) {
      allRows.push(rows[0]); // header
      headerAdded = true;
    }
    for (const r of rows.slice(1)) allRows.push(r);

    if (!hasNext) break;

    // try clicking next inside the frame
    const clicked = await target.evaluate(selector => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }, nextSelector);

    if (!clicked) break;

    // wait a bit for content to change
    await new Promise(r => setTimeout(r, 1200));
  }

  return allRows;
}

async function run() {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit(537.36) Chrome/124 Safari/537.36");
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page.goto(CHALLONGE_URL, { waitUntil: "networkidle2", timeout: 60000 });

  await new Promise(r => setTimeout(r, 3000));

  const rows = await collectAllRows(page);
  await browser.close();

  const text = rows && rows.length >= 2
    ? `*Daily Challonge leaderboard*\n${makeBlock(rows)}\n${CHALLONGE_URL}`
    : `Challonge leaderboard\n${CHALLONGE_URL}\nNo table found.`;

  const res = await fetch(SLACK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
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
