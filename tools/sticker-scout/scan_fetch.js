const fs = require('fs');
const path = require('path');

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

// ---------- pacing ----------
function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
class Pace {
  constructor(c) {
    this.c = c;
    this.last = 0;
    this.window = [];
  }
  async wait() {
    const { minDelayMs, maxDelayMs, jitterMs, requestsPerMinute } = this.c;
    const now = Date.now(),
      base = rand(minDelayMs, maxDelayMs) + rand(0, jitterMs),
      since = now - this.last;
    if (since < base) await sleep(base - since);
    this.last = Date.now();
    if (requestsPerMinute > 0) {
      const cut = Date.now() - 60000;
      this.window = this.window.filter((t) => t >= cut);
      if (this.window.length >= requestsPerMinute) {
        const waitFor = 60000 - (Date.now() - this.window[0]) + 25;
        await sleep(waitFor);
      }
      this.window.push(Date.now());
    }
  }
}

// ---------- URL & mapping ----------
function toUnits(x) {
  const f = CFG.FETCH?.priceFactor ?? 100;
  if (x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * f) : null;
}
function normalizeBaseUrl(str) {
  if (!str) return null;
  const t = String(str).trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('//')) return 'https:' + t;
  if (t.startsWith('/')) return 'https://skinsmonkey.com' + t;
  if (/^skinsmonkey\.com/i.test(t)) return 'https://' + t;
  return 'https://' + t;
}
function buildUrl({ baseUrl, appId, sort, limit, offset, minCents, maxCents, tradeLock }) {
  const u = new URL(normalizeBaseUrl(baseUrl));
  u.searchParams.set('appId', String(appId));
  u.searchParams.set('sort', sort);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('offset', String(offset));
  if (minCents != null) u.searchParams.set('priceMin', String(minCents));
  if (maxCents != null) u.searchParams.set('priceMax', String(maxCents));
  if (tradeLock != null) u.searchParams.set('tradeLock', String(tradeLock));
  return u.toString();
}
async function nodeFetchJson(url) {
  log('GET', url);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'StickerScout/1.0 (+Homework)',
      Referer: 'https://skinsmonkey.com/trade',
      Origin: 'https://skinsmonkey.com',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(CFG.FETCH?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err._status = res.status;
    err._body = text;
    throw err;
  }
  return res.json();
}
function extractItemsArray(json) {
  if (!json) return [];
  if (Array.isArray(json.assets)) return json.assets;
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.data)) return json.data;
  if (json.data && Array.isArray(json.data.items)) return json.data.items;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json.inventory)) return json.inventory;
  return [];
}
function mapItem(o) {
  if (!o || typeof o !== 'object') return null;
  const name =
    o.name || o.market_hash_name || o.marketName || o.title || o.fullName || o.asset?.name || '';
  let cents =
    (typeof o.price_cents === 'number' && o.price_cents) ||
    (typeof o.priceCents === 'number' && o.priceCents) ||
    (typeof o.price === 'number' && o.price > 100 ? o.price : null) ||
    (typeof o.list_price === 'number' && o.list_price > 100 ? o.list_price : null) ||
    (typeof o.sell_price === 'number' && o.sell_price > 100 ? o.sell_price : null);
  const price =
    cents != null
      ? cents / (CFG.FETCH?.priceFactor ?? 100)
      : typeof o.price === 'number'
      ? o.price
      : null;

  let stickers = [];
  const cand =
    o.stickers ||
    o.appliedStickers ||
    o.applied_stickers ||
    o.attributes?.applied_stickers ||
    o.asset?.stickers ||
    o.details?.stickers ||
    o.meta?.stickers;
  if (Array.isArray(cand)) {
    stickers = cand
      .map((s) => (s && (s.marketName || s.name || s.title || s.text || s.stickerName)) || '')
      .filter(Boolean);
  }
  return { name, price, stickers };
}

// ---------- fetch via page session (same cookies/tokens as DOM) ----------
async function pageSessionFetch(browser, url) {
  if (!browser) throw new Error('No browser for session fetch');
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  if (!/skinsmonkey\.com\/trade/.test(page.url())) {
    await page.goto(CFG.TARGET?.startUrl || 'https://skinsmonkey.com/trade', {
      waitUntil: ['domcontentloaded', 'networkidle2'],
    });
  }
  const headers = CFG.FETCH?.headers || {};
  return await page.evaluate(
    async (u, hdrs) => {
      const r = await fetch(u, {
        credentials: 'include',
        mode: 'cors',
        headers: hdrs,
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) return await r.json();
      return await r.json();
    },
    url,
    headers
  );
}

// ---------- main ----------
async function main() {
  const { FETCH, FILTERS, OUTPUT, PROFIT, POLITENESS, BROWSER } = CFG;
  if (!FETCH?.enabled) throw new Error('FETCH mode disabled in config');

  const outDir = path.resolve(process.cwd(), OUTPUT.dir || 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const minCents = toUnits(FILTERS.minPrice);
  const maxCents = toUnits(FILTERS.maxPrice);

  log('starting fetch scan', {
    limit: FETCH.limit,
    maxPages: Math.min(FETCH.maxPages, POLITENESS.maxPagesPerRun),
    minCents,
    maxCents,
  });

  // (1) optional browser session upfront (makes API behave like DOM)
  let browser = null;
  if (FETCH.forceBrowserSession) {
    if (!puppeteer) throw new Error('Install puppeteer to use forceBrowserSession');
    browser = BROWSER?.connectWSEndpoint
      ? await puppeteer.connect({ browserWSEndpoint: BROWSER.connectWSEndpoint })
      : await puppeteer.launch({
          headless: BROWSER?.headless ?? false,
          defaultViewport: BROWSER?.viewport || { width: 1440, height: 900 },
          args: BROWSER?.args || ['--no-sandbox', '--disable-setuid-sandbox'],
          executablePath: BROWSER?.executablePath || undefined,
        });
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.goto(CFG.TARGET?.startUrl || 'https://skinsmonkey.com/trade', {
      waitUntil: ['domcontentloaded', 'networkidle2'],
    });
    const cookies = await page.cookies().catch(() => []);
    log('session cookies:', cookies.map((c) => c.name).join(', ') || '(none)');
  }

  // (2) getter: node fetch else fallback to page session on 401/402/403/429
  const shouldFallback = (x) => [401, 402, 403, 429].includes(x) || x === 'AbortError';
  const getJSON = async (url) => {
    if (FETCH.forceBrowserSession) return await pageSessionFetch(browser, url);
    try {
      return await nodeFetchJson(url);
    } catch (e) {
      if (FETCH.useBrowserSessionOnFail && shouldFallback(e._status || e.name)) {
        if (!browser) {
          if (!puppeteer) throw new Error('Install puppeteer to enable browser-session fallback');
          browser = BROWSER?.connectWSEndpoint
            ? await puppeteer.connect({ browserWSEndpoint: BROWSER.connectWSEndpoint })
            : await puppeteer.launch({
                headless: BROWSER?.headless ?? false,
                defaultViewport: BROWSER?.viewport || { width: 1440, height: 900 },
                args: BROWSER?.args || ['--no-sandbox', '--disable-setuid-sandbox'],
                executablePath: BROWSER?.executablePath || undefined,
              });
        }
        return await pageSessionFetch(browser, url);
      }
      throw e;
    }
  };

  const pace = new Pace(POLITENESS);
  const seen = new Set();
  const DEDUPE = CFG.OUTPUT?.dedupe === true; // default: no dedupe (show all)
  const hits = [];
  let consecutiveErrors = 0;

  const emit = (it) => {
    const key = it._key || `${it.name}::${it.price}::${(it.stickers || []).join('|')}`;
    if (DEDUPE) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    //const okP = priceMatch(it.price, FILTERS.minPrice, FILTERS.maxPrice);
    //const okS = stickerMatch(it.stickers,
    // {
    // mode: FILTERS.stickerMode,
    // terms: FILTERS.stickerTerms,
    // regex:
    //   FILTERS.stickerMode === 'regex' && FILTERS.stickerRegex
    //     ? new RegExp(FILTERS.stickerRegex, 'i')
    //     : null,
    //  minCount: FILTERS.minStickerCount,
    // });
    const okP = true;
    const okS = true;
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

  const maxPages = Math.min(FETCH.maxPages, POLITENESS.maxPagesPerRun);
  for (let p = 0; p < maxPages; p++) {
    const offset = FETCH.startOffset + p * FETCH.limit;
    const url = buildUrl({
      baseUrl: FETCH.baseUrl,
      appId: FETCH.appId,
      sort: FETCH.sort,
      limit: FETCH.limit,
      offset,
      minCents:
        FILTERS.minPrice != null
          ? Math.round(FILTERS.minPrice * (FETCH.priceFactor || 100))
          : minCents,
      maxCents:
        FILTERS.maxPrice != null
          ? Math.round(FILTERS.maxPrice * (FETCH.priceFactor || 100))
          : maxCents,
      tradeLock: FETCH.tradeLock,
    });

    let json;
    try {
      json = await getJSON(url);
      consecutiveErrors = 0;
    } catch (e) {
      log('fetch error:', e);
      const status = e?._status;
      if (shouldFallback(status)) {
        // fallback to page-session fetch once, then continue
        try {
          json = await pageSessionFetch(browser, url);
        } catch (e2) {
          consecutiveErrors++;
          if (consecutiveErrors >= POLITENESS.maxConsecutiveErrors) break;
          continue;
        }
      } else {
        consecutiveErrors++;
        if (consecutiveErrors >= POLITENESS.maxConsecutiveErrors) break;
        continue;
      }
    }

    // ---------- SkinsMonkey shape FIRST (assets -> one row per weapon) ----------
    if (json && Array.isArray(json.assets)) {
      const arr = json.assets;
      log(`page ${p + 1}: got ${arr.length} containers (offset=${offset})`);

      const toPrice = (obj) => {
        const f = FETCH.priceFactor || 100;
        // Prefer explicit cents fields; else treat dollar-ish fields as dollars
        const cents =
          (typeof obj?.price_cents === 'number' && obj.price_cents) ??
          (typeof obj?.priceCents === 'number' && obj.priceCents) ??
          (typeof obj?.list_price === 'number' && obj.list_price) ??
          (typeof obj?.sell_price === 'number' && obj.sell_price) ??
          (typeof obj?.min_price === 'number' && obj.min_price) ??
          (typeof obj?.minPrice === 'number' && Math.round(obj.minPrice * f)) ??
          (typeof obj?.price === 'number' && obj.price > 100 ? obj.price : null) ??
          (typeof obj?.item?.price === 'number' && Math.round(obj.item.price * f));
        return cents != null ? cents / f : null;
      };
      const toStickerNames = (cand) => {
        const arr = Array.isArray(cand) ? cand : [];
        return arr
          .map((s) => (s && (s.marketName || s.name || s.title || s.text || s.stickerName)) || '')
          .filter(Boolean);
      };
      const toName = (obj) =>
        obj?.item?.marketName ||
        obj?.item?.name ||
        obj?.item?.market_hash_name ||
        obj?.marketName ||
        obj?.name ||
        obj?.title ||
        obj?.asset?.name ||
        'Unknown Item';

      const emitAsset = (asset, idx) => {
        const name = toName(asset);
        const price = toPrice(asset) ?? toPrice(asset.item || {}) ?? null;
        const stickers =
          toStickerNames(asset.stickers) ||
          toStickerNames(asset.item?.stickers) ||
          toStickerNames(asset.item?.appliedStickers) ||
          toStickerNames(asset.item?.applied_stickers) ||
          toStickerNames(asset.details?.stickers);
        const row = { name, price, stickers };
        if (row.name) emit({ ...row, _key: `${offset}:${idx}:${name}` });
      };

      for (let i = 0; i < arr.length; i++) {
        const asset = arr[i];
        // Some responses are "containers" that hold listings in `items`
        if (Array.isArray(asset?.items) && asset.items.length) {
          for (let j = 0; j < asset.items.length; j++) {
            const item = asset.items[j];
            emitAsset(item, `${i}.${j}`);
          }
        } else {
          emitAsset(asset, i);
        }
      }
      // pagination end condition for this page
      if (arr.length < FETCH.limit) break;
      continue; // <---- CRITICAL: skip the generic mapping below
    }

    // ---------- Generic shapes (fallback) ----------
    const arr = extractItemsArray(json); // items, data.items, results, etc.
    log(`page ${p + 1}: got ${arr.length} items (offset=${offset})`);
    if (!arr.length) break;

    for (const raw of arr) {
      const m = mapItem(raw);
      if (m && m.name) emit(m);
    }
    if (arr.length < FETCH.limit) break;
  }

  hits.sort((a, b) => (b.profit?.roi ?? -Infinity) - (a.profit?.roi ?? -Infinity));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `skinsmonkey-fetch-${ts}.json`);
  const csvPath = path.join(outDir, `skinsmonkey-fetch-${ts}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify(hits, null, 2), 'utf8');
  fs.writeFileSync(
    csvPath,
    [
      'name,price,stickers,roi,absProfit',
      ...hits.map(
        (x) =>
          `"${x.name.replace(/"/g, '""')}",${x.price ?? ''},"${(x.stickers || [])
            .join(' | ')
            .replace(/"/g, '""')}",${x.profit?.roi ?? ''},${x.profit?.absolute ?? ''}`
      ),
    ].join('\n'),
    'utf8'
  );

  log(`Done. Hits: ${hits.length}`);
  log('Saved:', jsonPath);
  log('Saved:', csvPath);

  if (browser) await browser.close().catch(() => {});
}

module.exports = { main };
