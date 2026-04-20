/**
 * Sharefy — scrapers.js
 * Inspirado no Torrentio: APIs JSON confiáveis + sources de tracker.
 */

const axios   = require("axios");
const cheerio = require("cheerio");

const TIMEOUT = 12000;

const http = axios.create({
  timeout: TIMEOUT,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/html, */*",
  },
});

// Trackers: crítico para o Stremio resolver os torrents
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://p4p.arenabg.com:1337/announce",
  "udp://tracker.moeking.me:6969/announce",
  "udp://9.rarbg.com:2810/announce",
];

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
function quality(s) {
  if (!s) return "";
  if (/2160p|4K|UHD/i.test(s))  return "2160p";
  if (/1080p/i.test(s))         return "1080p";
  if (/720p/i.test(s))          return "720p";
  if (/480p/i.test(s))          return "480p";
  if (/360p/i.test(s))          return "360p";
  return "";
}

function validHash(h) {
  if (!h) return null;
  h = String(h).replace(/^.*btih:/i, "").trim().toLowerCase();
  if (/^[a-f0-9]{40}$/.test(h)) return h;
  return null;
}

function hashFromMagnet(m) {
  const r = (m || "").match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
  return r ? r[1].toLowerCase() : null;
}

function formatSize(bytes) {
  if (!bytes) return "";
  const gb = +bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(+bytes/1e6).toFixed(0)} MB`;
}

function buildStream(source, title, q, seeds, hash, size) {
  const h = validHash(hash);
  if (!h) return null;

  const q2    = q || quality(title) || "";
  const name  = q2 ? `Sharefy ${q2}\n${source}` : `Sharefy\n${source}`;
  const info  = [];
  if (title) info.push(`📄 ${title.length > 70 ? title.slice(0,67)+"…" : title}`);
  if (size)  info.push(`💾 ${size}`);
  info.push(`👥 ${seeds || 0}`);

  return {
    name,
    title:    info.join("\n"),
    infoHash: h,
    sources:  TRACKERS.map(t => `tracker:${t}`).concat([`dht:${h}`]),
    behaviorHints: {
      bingeGroup: `sharefy|${q2 || "unknown"}`,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Scrapers
// ──────────────────────────────────────────────────────────────────────────

async function yts(imdbId) {
  const bases = [
    "https://www6.yts-official.to",
    "https://yts.mx",
    "https://yts.am",
  ];

  for (const base of bases) {
    try {
      const { data } = await http.get(`${base}/api/v2/list_movies.json?query_term=${imdbId}&limit=20&sort_by=seeds&order_by=desc`);
      if (!data?.data?.movies?.length) continue;
      const out = [];
      for (const m of data.data.movies) {
        for (const t of (m.torrents || [])) {
          const s = buildStream("YTS", m.title_long, t.quality, t.seeds, t.hash, t.size);
          if (s) out.push(s);
        }
      }
      console.log(`[YTS] ${out.length} via ${base}`);
      return out;
    } catch (e) {
      console.warn(`[YTS] ${base}: ${e.message}`);
    }
  }

  return [];
}

async function eztv(imdbId, season, episode) {
  const id = imdbId.replace("tt","");
  const urls = [
    `https://eztv.re/api/get-torrents?imdb_id=${id}&limit=40`,
    `https://eztv.tf/api/get-torrents?imdb_id=${id}&limit=40`,
    `https://eztv.wf/api/get-torrents?imdb_id=${id}&limit=40`,
  ];
  for (const url of urls) {
    try {
      const { data } = await http.get(url);
      if (!data?.torrents?.length) continue;
      let list = data.torrents;
      if (season != null && episode != null) {
        list = list.filter(t => {
          const m = (t.title||"").match(/S(\d+)E(\d+)/i);
          return m && +m[1]===season && +m[2]===episode;
        });
      }
      const out = list.slice(0,20).map(t =>
        buildStream("EZTV", t.title, quality(t.title), t.seeds, t.hash, formatSize(t.size_bytes))
      ).filter(Boolean);
      console.log(`[EZTV] ${out.length}`);
      return out;
    } catch { continue; }
  }
  return [];
}

async function tpb(query) {
  try {
    const { data } = await http.get(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=200`);
    if (!Array.isArray(data) || data[0]?.name === "No results returned") return [];
    const out = data.slice(0,15).map(t =>
      buildStream("TPB", t.name, quality(t.name), +t.seeders, t.info_hash, formatSize(t.size))
    ).filter(Boolean);
    console.log(`[TPB] ${out.length}`);
    return out;
  } catch (e) { console.warn(`[TPB] ${e.message}`); return []; }
}

async function torrentsCsv(query) {
  try {
    const { data } = await http.get(`https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=15&type=torrent`);
    const list = data?.torrents || (Array.isArray(data) ? data : []);
    const out = list.slice(0,15).map(t =>
      buildStream("TorrCSV", t.name, quality(t.name), t.seeders, t.infohash||t.hash, formatSize(t.size_bytes))
    ).filter(Boolean);
    console.log(`[TorrCSV] ${out.length}`);
    return out;
  } catch (e) { console.warn(`[TorrCSV] ${e.message}`); return []; }
}

async function bitsearch(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(`https://bitsearch.to/api/v1/search?q=${encodeURIComponent(query)}&sort=seeders`, {
      signal: controller.signal,
      headers: {
        "User-Agent": http.defaults.headers["User-Agent"],
        "Accept": "application/json, */*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const list = data?.results || data?.data || [];
    const out = list.slice(0,15).map(t => {
      const name = t.name || t.title || "";
      const h = t.infohash || t.infoHash || t.hash || hashFromMagnet(t.magnet);
      const bytes = t.stats?.size || t.size;
      return buildStream("Bitsearch", name, quality(name), t.stats?.seeders || t.seeders || 0, h, formatSize(bytes));
    }).filter(Boolean);
    console.log(`[Bitsearch] ${out.length}`);
    return out;
  } catch (e) {
    console.warn(`[Bitsearch] ${e.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function ext(query) {
  try {
    const { data } = await http.get(`https://ext.to/api/v1/search?q=${encodeURIComponent(query)}&sort=seeders&order=desc`);
    const list = data?.results || data?.torrents || (Array.isArray(data) ? data : []);
    const out = list.slice(0,15).map(t => {
      const name = t.name || t.title || "";
      const h = t.hash || t.infohash || t.info_hash || hashFromMagnet(t.magnet);
      return buildStream("EXT", name, quality(name), t.seeders || t.seeds || 0, h, t.size);
    }).filter(Boolean);
    console.log(`[EXT] ${out.length}`);
    return out;
  } catch (e) { console.warn(`[EXT] ${e.message}`); return []; }
}

async function x1337(query) {
  const bases = [
    "https://www.1377x.to",
  ];

  for (const base of bases) {
    try {
      const { data } = await http.get(`${base}/search/${encodeURIComponent(query)}/1/`);
      const $ = cheerio.load(data);
      const rows = $("table.table-list tbody tr").toArray().slice(0,6);
      if (!rows.length) continue;

      const items = rows.map(r => ({
        href:  base + ($(r).find("td.name a").eq(1).attr("href")||""),
        name:  $(r).find("td.name a").eq(1).text().trim(),
        seeds: +$(r).find("td.seeds").text().replace(/\D/g,"") || 0,
        size:  $(r).find("td.size").text().trim().split("\n")[0],
      })).filter(i => i.href && i.name);

      const out = (await Promise.all(items.map(async i => {
        try {
          const { data: d } = await http.get(i.href);
          const mag = cheerio.load(d)('a[href^="magnet:"]').attr("href");
          if (!mag) return null;
          return buildStream("1377x", i.name, quality(i.name), i.seeds, hashFromMagnet(mag), i.size);
        } catch { return null; }
      }))).filter(Boolean);

      console.log(`[1377x] ${out.length} via ${base}`);
      return out;
    } catch (e) {
      console.warn(`[1377x] ${base}: ${e.message}`);
    }
  }

  return [];
}

// ──────────────────────────────────────────────────────────────────────────
// Resolve title via Cinemeta (Stremio's own metadata API)
// ──────────────────────────────────────────────────────────────────────────
async function resolveTitle(imdbId, type) {
  const urls = [
    `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
    `https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`,
    `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`,
  ];
  for (const url of urls) {
    try {
      const { data } = await http.get(url);
      if (data?.meta?.name) return { title: data.meta.name, year: String(data.meta.year||"") };
    } catch {}
  }
  return { title: imdbId, year: "" };
}

// ──────────────────────────────────────────────────────────────────────────
// MASTER
// ──────────────────────────────────────────────────────────────────────────
async function scrapeAll(imdbId, isSeries, season, episode) {
  const type = isSeries ? "series" : "movie";
  const { title, year } = await resolveTitle(imdbId, type);

  const query = isSeries
    ? `${title} S${String(season).padStart(2,"0")}E${String(episode).padStart(2,"0")}`
    : `${title} ${year}`.trim();

  console.log(`\n[Sharefy] Query: "${query}" (${imdbId})`);

  const tasks = isSeries
    ? [ eztv(imdbId, season, episode), tpb(query), torrentsCsv(query), bitsearch(query), ext(query), x1337(query) ]
    : [ yts(imdbId), tpb(query), torrentsCsv(query), bitsearch(query), ext(query), x1337(query) ];

  const results = await Promise.allSettled(tasks);
  const all     = results.flatMap(r => r.status === "fulfilled" ? r.value : []);

  // Dedup por infoHash
  const seen = new Set();
  const unique = all.filter(s => {
    if (seen.has(s.infoHash)) return false;
    seen.add(s.infoHash);
    return true;
  });

  // Ordenar por qualidade > seeders
  const Q = { "2160p":0, "1080p":1, "720p":2, "480p":3, "360p":4 };
  unique.sort((a, b) => {
    const qa = Q[a.name.match(/\d+p/)?.[0]] ?? 9;
    const qb = Q[b.name.match(/\d+p/)?.[0]] ?? 9;
    return qa - qb;
  });

  console.log(`[Sharefy] Total: ${unique.length} streams`);
  return unique;
}

module.exports = { scrapeAll };
