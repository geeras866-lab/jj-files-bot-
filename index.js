const fs = require("fs");
const path = require("path");
const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_KEY;
const CHANNEL_ID = "3905680085";
const EXPORT_DIR = path.join(__dirname, "export");

function norm(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/&apos;|&#39;|'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseSizeMBFromText(text) {
  const s = String(text || "");
  const gb = s.match(/(\d+(?:\.\d+)?)\s*gb/i);
  if (gb) return parseFloat(gb[1]) * 1024;
  const mb = s.match(/(\d+(?:\.\d+)?)\s*mb/i);
  if (mb) return parseFloat(mb[1]);
  return null;
}

function extractRes(text) {
  const m = String(text || "").match(/\b(2160p|4k|1080p|720p|576p|480p|360p|240p)\b/i);
  return m ? m[1].toLowerCase().replace("4k", "2160p") : "";
}

function supabaseReq(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL.replace(/\/+$/, "") + apiPath);
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request(
      { hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
          resolve(data ? JSON.parse(data) : null);
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseHtmlFiles() {
  if (!fs.existsSync(EXPORT_DIR)) throw new Error("export/ folder kanipinchaledu!");
  const files = fs.readdirSync(EXPORT_DIR).filter((f) => /^messages\d*\.html$/i.test(f));
  if (!files.length) throw new Error("export/ folder lo messages.html files levu!");

  const mediaList = [];
  const validMsgIds = new Set();

  for (const file of files) {
    const html = fs.readFileSync(path.join(EXPORT_DIR, file), "utf8");
    const blocks = html.split('<div class="message ');
    for (const b of blocks) {
      const idMatch = b.match(/id="message(\d+)"/);
      if (!idMatch) continue;
      const msgId = Number(idMatch[1]);
      validMsgIds.add(msgId);

      if (!b.includes("media_file") && !b.includes("media_video")) continue;

      const titleMatch = b.match(/<div class="title bold">\s*([\s\S]*?)\s*<\/div>/);
      const statusMatch = b.match(/<div class="status details">\s*([\s\S]*?)\s*<\/div>/);
      const textMatch = b.match(/<div class="text">\s*([\s\S]*?)\s*<\/div>/);

      const fileName = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, " ").trim() : "";
      const status = statusMatch ? statusMatch[1].replace(/<[^>]+>/g, " ").trim() : "";
      const caption = textMatch ? textMatch[1].replace(/<[^>]+>/g, " ").trim() : "";

      const sizeMB = parseSizeMBFromText(status) || parseSizeMBFromText(caption) || 0;
      if (sizeMB < 50) continue;

      const combined = `${fileName} ${caption}`;
      mediaList.push({
        msgId,
        sizeMB,
        normText: norm(combined),
        res: extractRes(combined),
        isHevc: /hevc|x265|h\.?265/i.test(combined)
      });
    }
  }
  return { mediaList, validMsgIds, fileCount: files.length };
}

function scoreCandidate(cand, movieTitleNorm, movieYear, versionQuality) {
  let score = 0;
  if (!cand.normText.includes(movieTitleNorm)) return -1;
  score += 50;
  if (movieYear && cand.normText.includes(String(movieYear))) score += 20;

  const vRes = extractRes(versionQuality);
  if (vRes && cand.res === vRes) score += 30;
  else if (vRes && cand.res && cand.res !== vRes) score -= 20;

  const vHevc = /hevc|x265|h\.?265/i.test(versionQuality);
  if (vHevc === cand.isHevc) score += 10;

  const vSizeMB = parseSizeMBFromText(versionQuality);
  if (vSizeMB && cand.sizeMB) {
    const diffRatio = Math.abs(cand.sizeMB - vSizeMB) / Math.max(vSizeMB, 1);
    if (diffRatio <= 0.12) score += 40;
    else if (diffRatio <= 0.25) score += 20;
    else if (diffRatio > 0.5) score -= 15;
  }
  return score;
}

async function run() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Render lo SUPABASE_URL or SUPABASE_KEY missing!");
  }

  console.log("Scanning export/ HTML files...");
  const { mediaList, validMsgIds, fileCount } = parseHtmlFiles();
  console.log(`Found ${fileCount} HTML files, ${validMsgIds.size} messages, ${mediaList.length} movie files.`);

  const movies = await supabaseReq("GET", "/rest/v1/movies?select=id,title,release_year&limit=5000");
  const versions = await supabaseReq("GET", "/rest/v1/movie_versions?select=id,movie_id,quality,viewing_url&limit=10000");

  const movieMap = new Map(movies.map((m) => [String(m.id), m]));
  const usedMsgIdsPerMovie = new Map();

  let alreadyValid = 0, updated = 0, notFound = 0;

  for (const v of versions) {
    const existingMatch = String(v.viewing_url || "").match(/\/c\/\d+\/(\d+)/);
    const existingId = existingMatch ? Number(existingMatch[1]) : null;

    if (existingId && validMsgIds.has(existingId)) {
      alreadyValid++;
      continue;
    }

    const movie = movieMap.get(String(v.movie_id));
    if (!movie) { notFound++; continue; }

    const titleNorm = norm(movie.title);
    const usedSet = usedMsgIdsPerMovie.get(String(v.movie_id)) || new Set();

    let best = null, bestScore = -1;
    for (const cand of mediaList) {
      if (usedSet.has(cand.msgId)) continue;
      const sc = scoreCandidate(cand, titleNorm, movie.release_year, v.quality);
      if (sc > bestScore) {
        bestScore = sc;
        best = cand;
      }
    }

    if (!best || bestScore < 50) {
      notFound++;
      continue;
    }

    usedSet.add(best.msgId);
    usedMsgIdsPerMovie.set(String(v.movie_id), usedSet);
    const newUrl = `https://t.me/c/${CHANNEL_ID}/${best.msgId}`;

    await supabaseReq("PATCH", `/rest/v1/movie_versions?id=eq.${v.id}`, { viewing_url: newUrl });
    console.log(`[UPDATED] Version ${v.id} (${movie.title} - ${v.quality}) -> #${best.msgId}`);
    updated++;
  }

  console.log(`DONE! Already Valid: ${alreadyValid} | Updated: ${updated} | Not Matched: ${notFound}`);
}

run().catch((err) => {
  console.error("FIX-LINKS ERROR:", err.message);
  process.exit(0); // Bot start avvadaniki block cheyakunda
});
