// Fast scanner: uses SkinsMonkey public inventory API with limit/offset + priceMin/Max
const fs = require('fs');
const path = require('path');

// Use full puppeteer if available; fall back to puppeteer-core (only if browser session needed)
let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch {
  try {
    puppeteer = require('puppeteer-core');
  } catch {}
}

const CFG = require('./config');
const { normalizeSpaces, stickerMatch, priceMatch, estimateProfit } = require('./utils');

const log = (...a) => console.log('[sticker-scout:fetch]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toCents(x) {
  if (x == null) return null;
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function buildUrl({ baseUrl, appId, sort, limit, offset, minCents, maxCents, tradeLock }) {
  const u = new URL(baseUrl);
  u.searchParams.set('appId', String(appId));
  u.searchParams.set('sort', sort);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('offset', String(offset));
  if (minCents != null) u.searchParams.set('priceMin', String(minCents));
  if (maxCents != null) u.searchParams.set('priceMax', String(maxCents));
  if (tradeLock != null) u.searchParams.set('tradeLock', String(tradeLock));
  return u.toString();
}

// Map unknown API item → {name, price (USD), stickers[]}
function mapItem(o) {
  if (!o || typeof o !== 'object') return null;

  const name =
    o.name || o.market_hash_name || o.marketName || o.title || o.fullName || o.asset?.name || '';

  // price may be cents (int) or dollars (float). Prefer cents-like fields.
  let cents =
    (typeof o.price_cents === 'number' && o.price_cents) ||
    (typeof o.priceCents === 'number' && o.priceCents) ||
    (typeof o.price === 'number' && o.price > 100 ? o.price : null) ||
    (typeof o.list_price === 'number' && o.list_price > 100 ? o.list_price : null) ||
    (typeof o.sell_price === 'number' && o.sell_price > 100 ? o.sell_price : null);

  // fallback: price is already dollars
  let price =
    (cents != null ? cents / 100 : null) ?? (typeof o.price === 'number' ? o.price : null);

  // stickers likely as array of objects with name/title
  let stickers = [];
  const candArrs = [
    o.stickers,
    o.appliedStickers,
    o.applied_stickers,
    o.attributes?.applied_stickers,
    o.asset?.stickers,
    o.details?.stickers,
    o.meta?.stickers,
  ].filter(Boolean);

  if (candArrs.length) {
    stickers = (candArrs[0] || [])
      .map((s) => (s && (s.name || s.title || s.text || s.stickerName)) || '')
      .filter(Boolean);
  }

  return { name, price, stickers };
}

// Find where the items array lives in the response
function extractItemsArray(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.data)) return json.data;
  if (json.data && Array.isArray(json.data.items)) return json.data.items;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json.inventory)) return json.inventory;
  return [];
}

// Node fetch with headers. If 403 and configured, caller may retry via pageSessionFetch.
async function nodeFetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StickerScout/1.0',
      Referer: 'https://skinsmonkey.com/trade',
      Origin: 'https://skinsmonkey.com',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err._body = text;
    err._status = res.status;
    throw err;
  }
  return res.json();
}

// Use the page’s session (bypasses CF/CORS). Requires puppeteer.
async function pageSessionFetch(browser, url) {
  if (!puppeteer || !browser) throw new Error('No browser available for session fetch');
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  await page
    .goto('https://skinsmonkey.com/trade', { waitUntil: ['domcontentloaded', 'networkidle2'] })
    .catch(() => {});
  return await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  }, url);
}

async function main() {
  const { FETCH, FILTERS, OUTPUT, PROFIT, BROWSER } = CFG;
  if (!FETCH?.enabled) throw new Error('FETCH mode disabled in config');

  // Prepare output
  const outDir = path.resolve(process.cwd(), OUTPUT.dir || 'out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `skinsmonkey-fetch-${ts}.json`);
  const csvPath = path.join(outDir, `skinsmonkey-fetch-${ts}.csv`);

  // Server-side price filter (convert dollars→cents)
  const minCents = toCents(FILTERS.minPrice);
  const maxCents = toCents(FILTERS.maxPrice);

  log('starting fetch scan', { limit: FETCH.limit, maxPages: FETCH.maxPages, minCents, maxCents });

  let browser = null;
  let usedBrowserSession = false;

  const seen = new Set();
  const hits = [];

  const emit = (it) => {
    const key = `${it.name}::${it.price}::${(it.stickers || []).join('|')}`;
    if (seen.has(key)) return;
    seen.add(key);

    const okP = priceMatch(it.price, FILTERS.minPrice, FILTERS.maxPrice);
    const okS = stickerMatch(it.stickers, {
      mode: FILTERS.stickerMode,
      terms: FILTERS.stickerTerms,
      regex:
        FILTERS.stickerMode === 'regex' && FILTERS.stickerRegex
          ? new RegExp(FILTERS.stickerRegex, 'i')
          : null,
      minCount: FILTERS.minStickerCount,
    });

    if (okP && okS) {
      const profit = estimateProfit(it.price, PROFIT);
      const hit = {
        name: normalizeSpaces(it.name),
        price: it.price,
        stickers: it.stickers,
        profit,
      };
      hits.push(hit);
      if (OUTPUT.streamHits) console.log(JSON.stringify({ type: 'HIT', data: hit }));
    }
  };

  try {
    for (let p = 0; p < FETCH.maxPages; p++) {
      const offset = p * FETCH.limit;
      const url = buildUrl({
        baseUrl: FETCH.baseUrl,
        appId: FETCH.appId,
        sort: FETCH.sort,
        limit: FETCH.limit,
        offset,
        minCents,
        maxCents,
         tradeLock: FETCH.tradeLock
      });

      let json;
      try {
        json = await nodeFetchJson(url);
      } catch (e) {
        // If blocked and configured, fall back to browser session fetch once
        if (FETCH.useBrowserSessionOnFail && e._status === 403) {
          if (!browser) {
            if (!puppeteer)
              throw new Error('Install puppeteer to enable browser-session fetch fallback');
            browser = BROWSER?.connectWSEndpoint
              ? await puppeteer.connect({ browserWSEndpoint: BROWSER.connectWSEndpoint })
              : await puppeteer.launch({
                  headless: BROWSER?.headless ?? true,
                  defaultViewport: BROWSER?.viewport || { width: 1440, height: 900 },
                  args: BROWSER?.args || ['--no-sandbox', '--disable-setuid-sandbox'],
                  executablePath: BROWSER?.executablePath || undefined,
                });
            usedBrowserSession = true;
            log('403 from API – switching to browser-session fetch');
          }
          json = await pageSessionFetch(browser, url);
        } else {
          throw e;
        }
      }

      const arr = extractItemsArray(json);
      log(`page ${p + 1}: got ${arr.length} items (offset=${offset})`);
      if (!arr.length) break;

      for (const raw of arr) {
        const m = mapItem(raw);
        if (m && m.name) emit(m);
      }

      await sleep(100);
    }

    // sorting and saving into my json data !
    if ((OUTPUT.sortBy || 'roi') === 'roi') {
      hits.sort((a, b) => (b.profit?.roi ?? -Infinity) - (a.profit?.roi ?? -Infinity));
    } else if (OUTPUT.sortBy === 'price') {
      hits.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    }

    if (OUTPUT.saveJSON) fs.writeFileSync(jsonPath, JSON.stringify(hits, null, 2), 'utf8');
    if (OUTPUT.saveCSV) {
      const header = ['name', 'price', 'stickers', 'roi', 'absProfit'].join(',');
      const rows = hits.map((x) =>
        [
          `"${x.name.replace(/"/g, '""')}"`,
          x.price ?? '',
          `"${(x.stickers || []).join(' | ').replace(/"/g, '""')}"`,
          x.profit?.roi ?? '',
          x.profit?.absolute ?? '',
        ].join(',')
      );
      fs.writeFileSync(csvPath, [header, ...rows].join('\n'), 'utf8');
    }

    log(`Done. Hits: ${hits.length}`);
    if (OUTPUT.saveJSON) log('Saved:', jsonPath);
    if (OUTPUT.saveCSV) log('Saved:', csvPath);
    if (usedBrowserSession && browser) await browser.close().catch(() => {});
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

module.exports = { main };
