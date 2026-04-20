/**
 * StreamBR Finder — scrapers.js
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

function looksBlockedByCloudflare(html) {
  return /Just a moment|cf-chl|challenge-platform|Enable JavaScript and cookies/i.test(String(html || ""));
}

function formatSize(bytes) {
  if (!bytes) return "";
  const gb = +bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(+bytes/1e6).toFixed(0)} MB`;
}

function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleTokens(s) {
  const normalized = normalizeText(s);
  return normalized ? normalized.split(/\s+/) : [];
}

const RELEASE_MARKERS = new Set([
  "2160p", "1080p", "720p", "480p", "360p",
  "4k", "uhd", "hdr", "hdr10", "dv", "dovi", "imax",
  "bluray", "blu", "ray", "brrip", "bdrip", "dvdrip", "hdrip",
  "web", "webdl", "webrip", "hdtv", "cam", "hdcam", "hdts", "ts",
  "remux", "x264", "x265", "h264", "h265", "hevc", "avc",
  "aac", "ac3", "eac3", "dts", "truehd", "atmos",
  "dual", "audio", "multi", "dubbed", "subbed", "subs",
  "proper", "repack", "rerip", "internal", "limited",
  "yify", "yts", "rarbg",
]);

const EDITION_TOKENS = new Set([
  "extended", "unrated", "remastered", "theatrical", "directors",
  "director", "cut", "edition", "final", "special", "collector",
  "collectors", "anniversary", "restored",
]);

const COLLECTION_TOKENS = new Set([
  "collection", "collections", "trilogy", "duology", "quadrilogy",
  "saga", "pack", "complete",
]);

const LEADING_NOISE_TOKENS = new Set([
  "www", "yts", "mx", "am", "lt", "yify", "rarbg", "tgx",
  "torrentgalaxy", "ettv", "eztv",
]);

function isYearToken(token) {
  return /^(19|20)\d{2}$/.test(token);
}

function isReleaseMarker(token) {
  return isYearToken(token) || RELEASE_MARKERS.has(token) || /^s\d{1,2}e\d{1,2}$/.test(token);
}

function sameTokens(a, b) {
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

function containsTokens(tokens, expected) {
  if (!expected.length || tokens.length < expected.length) return false;

  for (let i = 0; i <= tokens.length - expected.length; i++) {
    if (expected.every((token, j) => tokens[i + j] === token)) return true;
  }

  return false;
}

function endsWithTokens(tokens, expected) {
  if (tokens.length < expected.length) return false;
  const start = tokens.length - expected.length;
  return expected.every((token, i) => tokens[start + i] === token);
}

function removeLeadingNoise(tokens) {
  let start = 0;
  while (start < tokens.length && LEADING_NOISE_TOKENS.has(tokens[start])) start++;
  return tokens.slice(start);
}

function removeTrailingEdition(tokens) {
  const out = tokens.slice();
  while (out.length && EDITION_TOKENS.has(out[out.length - 1])) out.pop();
  return out;
}

function baseTitleTokens(tokens) {
  const clean = removeLeadingNoise(tokens);
  const markerAt = clean.findIndex(isReleaseMarker);
  return markerAt === -1 ? clean : clean.slice(0, markerAt);
}

function createResultMatcher(expectedTitle, expectedYear, opts = {}) {
  const expected = titleTokens(expectedTitle);
  if (!expected.length || /^tt\d+$/i.test(String(expectedTitle || ""))) return () => true;

  const year = String(expectedYear || "").match(/\d{4}/)?.[0] || "";
  const numericTitleTokens = new Set(expected.filter(isYearToken));
  const isSeries = !!opts.isSeries;
  const hasEpisode = opts.season != null && opts.episode != null;
  const season = hasEpisode ? Number(opts.season) : NaN;
  const episode = hasEpisode ? Number(opts.episode) : NaN;
  const episodeCode = hasEpisode && Number.isFinite(season) && Number.isFinite(episode)
    ? `s${String(season).padStart(2, "0")}e${String(episode).padStart(2, "0")}`
    : "";

  return (candidateTitle) => {
    const raw = String(candidateTitle || "");
    const tokens = titleTokens(raw);
    if (!tokens.length || !containsTokens(tokens, expected)) return false;

    if (episodeCode && !tokens.includes(episodeCode)) return false;

    if (!isSeries && tokens.some(token => COLLECTION_TOKENS.has(token))) return false;

    if (!isSeries && year) {
      const years = tokens.filter(token => isYearToken(token) && !numericTitleTokens.has(token));
      if (years.length && !years.every(candidateYear => candidateYear === year)) return false;
    }

    const clean = removeLeadingNoise(tokens);
    if (sameTokens(clean.slice(0, expected.length), expected)) {
      const rest = clean.slice(expected.length);
      const markerAt = rest.findIndex(isReleaseMarker);
      const titleTail = markerAt === -1 ? rest : rest.slice(0, markerAt);
      if (titleTail.every(token => EDITION_TOKENS.has(token))) return true;
    }

    const base = baseTitleTokens(tokens);
    if (sameTokens(base, expected)) return true;

    const withoutEdition = removeTrailingEdition(base);
    if (sameTokens(withoutEdition, expected)) return true;

    // Accept branded variants like "Marvels The Avengers 2012" when the year confirms it.
    return !isSeries
      && year
      && tokens.includes(year)
      && withoutEdition.length <= expected.length + 2
      && endsWithTokens(withoutEdition, expected);
  };
}

function filterByExpectedTitle(list, matcher, getName) {
  return list.filter(item => matcher(getName(item)));
}

function buildStream(source, title, q, seeds, hash, size) {
  const h = validHash(hash);
  if (!h) return null;

  const q2    = q || quality(title) || "";
  const name  = q2 ? `StreamBR Finder ${q2}\n${source}` : `StreamBR Finder\n${source}`;
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
      bingeGroup: `streambr-finder|${q2 || "unknown"}`,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Scrapers
// ──────────────────────────────────────────────────────────────────────────

async function yts(imdbId, matcher) {
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
      for (const m of filterByExpectedTitle(data.data.movies, matcher, m => m.title_long || m.title || "")) {
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

async function eztv(imdbId, season, episode, matcher) {
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
      list = filterByExpectedTitle(list, matcher, t => t.title || "");
      const out = list.slice(0,20).map(t =>
        buildStream("EZTV", t.title, quality(t.title), t.seeds, t.hash, formatSize(t.size_bytes))
      ).filter(Boolean);
      console.log(`[EZTV] ${out.length}`);
      return out;
    } catch { continue; }
  }
  return [];
}

async function tpb(query, matcher) {
  try {
    const { data } = await http.get(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=200`);
    if (!Array.isArray(data) || data[0]?.name === "No results returned") return [];
    const out = filterByExpectedTitle(data, matcher, t => t.name || "").slice(0,15).map(t =>
      buildStream("TPB", t.name, quality(t.name), +t.seeders, t.info_hash, formatSize(t.size))
    ).filter(Boolean);
    console.log(`[TPB] ${out.length}`);
    return out;
  } catch (e) { console.warn(`[TPB] ${e.message}`); return []; }
}

async function torrentsCsv(query, matcher) {
  try {
    const { data } = await http.get(`https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=30&type=torrent`);
    const list = data?.torrents || (Array.isArray(data) ? data : []);
    const out = filterByExpectedTitle(list, matcher, t => t.name || "").slice(0,15).map(t =>
      buildStream("TorrCSV", t.name, quality(t.name), t.seeders, t.infohash||t.hash, formatSize(t.size_bytes))
    ).filter(Boolean);
    console.log(`[TorrCSV] ${out.length}`);
    return out;
  } catch (e) { console.warn(`[TorrCSV] ${e.message}`); return []; }
}

async function bitsearch(query, matcher) {
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
    const out = filterByExpectedTitle(list, matcher, t => t.name || t.title || "").slice(0,15).map(t => {
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

function parseExtSearchRows(html, matcher) {
  const $ = cheerio.load(html);
  const rows = $("table tbody tr").toArray();

  return rows.map(row => {
    const links = $(row).find("a").toArray().map(a => ({
      href: $(a).attr("href") || "",
      text: $(a).text().replace(/\s+/g, " ").trim(),
    }));

    const titleLink = links.find(link =>
      link.text &&
      link.href &&
      !/imdb/i.test(link.text) &&
      !/^\/(?:browse|user|users|tag|tags)\b/i.test(link.href)
    );

    if (!titleLink || !matcher(titleLink.text)) return null;

    const rowText = $(row).text().replace(/\s+/g, " ").trim();
    const seeds = +(rowText.match(/\bSeeds\s+(\d+)/i)?.[1] || rowText.match(/\bfile_upload\s+(\d+)/i)?.[1] || 0);
    const size = rowText.match(/\bSize\s+([\d.]+\s*[KMGT]B)/i)?.[1]
      || rowText.match(/\bstorage\s+([\d.]+\s*[KMGT]B)/i)?.[1]
      || "";

    return {
      name: titleLink.text,
      href: new URL(titleLink.href, "https://ext.to").href,
      seeds,
      size,
    };
  }).filter(Boolean);
}

async function extDetailHash(url) {
  const { data, status } = await http.get(url, {
    validateStatus: status => status < 500,
    headers: {
      "Referer": "https://ext.to/",
    },
  });

  if (status === 403 || looksBlockedByCloudflare(data)) return null;

  const $ = cheerio.load(data);
  const magnet = $('a[href^="magnet:"]').attr("href")
    || String(data).match(/magnet:\?xt=urn:btih:[^"'<>\s]+/i)?.[0];

  return hashFromMagnet(magnet)
    || String(data).match(/Torrent hash:\s*([a-fA-F0-9]{40})/i)?.[1]?.toLowerCase()
    || null;
}

async function ext(query, matcher) {
  try {
    const url = `https://ext.to/browse/?order=desc&q=${encodeURIComponent(query)}&sort=seeds`;
    const { data, status } = await http.get(url, {
      validateStatus: status => status < 500,
      headers: {
        "Referer": "https://ext.to/",
      },
    });

    if (status === 403 || looksBlockedByCloudflare(data)) {
      console.warn(`[EXT] blocked by site (${status})`);
      return [];
    }

    const items = parseExtSearchRows(data, matcher).slice(0, 8);
    const out = (await Promise.all(items.map(async item => {
      try {
        const h = await extDetailHash(item.href);
        return buildStream("EXT", item.name, quality(item.name), item.seeds, h, item.size);
      } catch {
        return null;
      }
    }))).filter(Boolean);

    console.log(`[EXT] ${out.length}`);
    return out;
  } catch (e) { console.warn(`[EXT] ${e.message}`); return []; }
}

async function x1337(query, matcher) {
  const bases = [
    "https://www.1377x.to",
  ];

  for (const base of bases) {
    try {
      const { data } = await http.get(`${base}/search/${encodeURIComponent(query)}/1/`);
      const $ = cheerio.load(data);
      const rows = $("table.table-list tbody tr").toArray().slice(0,20);
      if (!rows.length) continue;

      const items = rows.map(r => ({
        href:  base + ($(r).find("td.name a").eq(1).attr("href")||""),
        name:  $(r).find("td.name a").eq(1).text().trim(),
        seeds: +$(r).find("td.seeds").text().replace(/\D/g,"") || 0,
        size:  $(r).find("td.size").text().trim().split("\n")[0],
      })).filter(i => i.href && i.name && matcher(i.name)).slice(0,6);

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
  const matcher = createResultMatcher(title, year, { isSeries, season, episode });

  console.log(`\n[StreamBR Finder] Query: "${query}" (${imdbId})`);

  const tasks = isSeries
    ? [ eztv(imdbId, season, episode, matcher), tpb(query, matcher), torrentsCsv(query, matcher), bitsearch(query, matcher), ext(query, matcher), x1337(query, matcher) ]
    : [ yts(imdbId, matcher), tpb(query, matcher), torrentsCsv(query, matcher), bitsearch(query, matcher), ext(query, matcher), x1337(query, matcher) ];

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

  console.log(`[StreamBR Finder] Total: ${unique.length} streams`);
  return unique;
}

module.exports = { scrapeAll };
