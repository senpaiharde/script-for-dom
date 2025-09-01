const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const CFG = require('./config');
const {
  normalizeSpaces,
  parsePrice,
  priceMatch,
  stickerMatch,
  estimateProfit,
} = require('./utils');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // already added earlier

async function discoverApi(page, CFG) {
  const hits = [];
  function onResponse(res) {
    const url = res.url();
    if (!CFG.FAST.endpointMatch.test(url)) return;
    if (!/json|javascript|text/i.test(res.headers()['content-type'] || '')) return;
    hits.push(res);
  }
  page.on('response', onResponse);

  await sleep(CFG.FAST.discoveryMs);

  page.off('response', onResponse);

  const last = hits[hits.length - 1];
  if (!last) return null;

  try {
    const data = await last.json();
    const endpoint = last.url();

    return { endpoint, sample: data };
  } catch {
    return null;
  }
}

async function fetchJsonInPage(page, url) {
  return await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (ct.includes('application/json')) return await r.json();
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      return { _raw: text };
    }
  }, url);
}

function buildPagedUrls(baseUrl, { pageParam, sizeParam, pageSize, maxPages }) {
  const urls = [];
  for (let p = 1; p <= maxPages; p++) {
    const u = new URL(baseUrl);
    if (!u.searchParams.has(pageParam)) u.searchParams.set(pageParam, String(p));
    if (sizeParam) u.searchParams.set(sizeParam, String(pageSize));
    urls.push(u.toString());
  }
  return urls;
}

function mapUnknownJsonToItems(json) {
  const items = [];

  const tryPush = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const name = obj.name || obj.title || obj.itemName || obj.market_hash_name || '';
    const price = Number(obj.price || obj.amount || obj.sell_price || obj.list_price);
    let stickers = [];

    const candArrays = [
      obj.stickers,
      obj.Stickers,
      obj.assets?.stickers,
      obj.meta?.stickers,
      obj.details?.stickers,
    ].filter(Boolean);
    if (candArrays.length) {
      stickers = (candArrays[0] || []).map((s) => s.name || s.text || s.title).filter(Boolean);
    }

    if (name) items.push({ name, priceText: String(price || ''), stickers });
  };

  // Walk arrays at top-level
  if (Array.isArray(json)) json.forEach(tryPush);
  if (json && typeof json === 'object') {
    for (const k of Object.keys(json)) {
      const v = json[k];
      if (Array.isArray(v)) v.forEach(tryPush);
    }
  }

  return items;
}

async function pickMarketPage(browser, urlHint, SELECTORS) {
  const pages = await browser.pages();
  const scored = await Promise.all(
    pages.map(async (p) => {
      const url = p.url() || '';
      let score = 0;
      if (url.includes(urlHint)) score += 5;
      if (/skinsmonkey\.com\/trade/.test(url)) score += 3;
      try {
        const count = await p.evaluate(
          (sel) => document.querySelectorAll(sel).length,
          SELECTORS.card
        );
        if (count > 8) score += 4;
        else if (count > 0) score += 2;
      } catch {}
      return { p, url, score };
    })
  );
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0]?.p;
  if (!winner) throw new Error('No candidate page found – open the Trade page in a tab first.');
  await winner.bringToFront();
  return winner;
}

async function getScrollContainer(page, SELECTORS) {
  return await page.evaluateHandle((sel) => {
    const cands = document.querySelectorAll(sel.scrollContainer);
    for (const el of cands) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY)) return el;
    }
    return document.scrollingElement || document.body;
  }, SELECTORS);
}

async function extractVisible(page, SELECTORS) {
  return await page.evaluate((SELECTORS) => {
    const cards = Array.from(document.querySelectorAll(SELECTORS.card));
    return cards.map((card) => {
      const img = card.querySelector(SELECTORS.gunImg);
      const nameEl = card.querySelector(SELECTORS.name);
      const priceEl = card.querySelector(SELECTORS.price);
      const stickerImgs = Array.from(card.querySelectorAll(SELECTORS.stickerImgs));

      const name =
        (img && (img.getAttribute('alt') || '').trim()) ||
        (nameEl && (nameEl.textContent || '').trim()) ||
        '';

      const priceText = priceEl && priceEl.textContent ? priceEl.textContent.trim() : '';

      const stickers = stickerImgs
        .map((im) => (im.getAttribute('alt') || '').trim())
        .filter(Boolean);

      const sig = name + '::' + priceText + '::' + stickers.join('|');
      return { name, priceText, stickers, _sig: sig };
    });
  }, SELECTORS);
}

async function autoScrollAndStream(page, containerHandle, onBatch, SCROLL) {
  let lastSeenCount = 0;
  let noNew = 0;

  for (let i = 0; i < SCROLL.maxBatches; i++) {
    await page.evaluate(
      (container, dy) => {
        (container || window).scrollBy
          ? (container || window).scrollBy(0, dy)
          : (container.scrollTop = (container.scrollTop || 0) + dy);
      },
      containerHandle,
      SCROLL.perBatchPx
    );

    await page.waitForTimeout(SCROLL.waitBetweenMs);

    const batch = await extractVisible(page, CFG.SELECTORS);
    await onBatch(batch);

    const currentCount = batch.length;
    if (currentCount <= lastSeenCount) noNew++;
    else {
      noNew = 0;
      lastSeenCount = currentCount;
    }

    if (noNew >= SCROLL.earlyStopIfNoNew) break;
  }
}

async function main() {
  const { TARGET, FILTERS, PROFIT, SCROLL, OUTPUT, BROWSER, SELECTORS } = CFG;

  const browser = BROWSER.connectWSEndpoint
    ? await puppeteer.connect({ browserWSEndpoint: BROWSER.connectWSEndpoint })
    : await puppeteer.launch({
        headless: BROWSER.headless,
        defaultViewport: BROWSER.viewport,
        args: BROWSER.args,
      });

  try {
    const page = await pickMarketPage(browser, TARGET.urlHint, SELECTORS);
    await page.waitForSelector(SELECTORS.card, { timeout: 15000 }).catch(() => {});

    // compile regex once (if any)
    const stickerRegex =
      FILTERS.stickerMode === 'regex' && FILTERS.stickerRegex
        ? new RegExp(FILTERS.stickerRegex, 'i')
        : null;

    const seen = new Set();
    const hits = [];

    const outDir = path.resolve(process.cwd(), OUTPUT.dir);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(outDir, `skinsmonkey-${ts}.json`);
    const csvPath = path.join(outDir, `skinsmonkey-${ts}.csv`);

    const emit = (item) => {
      if (seen.has(item._sig)) return;
      seen.add(item._sig);

      const price = parsePrice(item.priceText);
      const okP = priceMatch(price, FILTERS.minPrice, FILTERS.maxPrice);
      const okS = stickerMatch(item.stickers, {
        mode: FILTERS.stickerMode,
        terms: FILTERS.stickerTerms,
        regex: stickerRegex,
        minCount: FILTERS.minStickerCount,
      });

      if (okP && okS) {
        const profit = estimateProfit(price, PROFIT);
        const hit = {
          name: normalizeSpaces(item.name),
          price,
          stickers: item.stickers,
          profit,
        };
        hits.push(hit);
        if (OUTPUT.streamHits) {
          console.log(JSON.stringify({ type: 'HIT', data: hit }));
        }
      }
    };

    let fastDone = false;
    if (CFG.FAST.enabled) {
      const found = await discoverApi(page, CFG);
      if (found?.endpoint) {
        if (CFG.FAST.saveSample) {
          const outDir = path.resolve(process.cwd(), CFG.OUTPUT.dir);
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
          const samplePath = path.join(outDir, 'api-sample.json');
          fs.writeFileSync(samplePath, JSON.stringify(found.sample, null, 2), 'utf8');
          console.log('  Saved API sample →', samplePath);
        }

        const urls = buildPagedUrls(found.endpoint, CFG.FAST);
        const seenSigs = new Set();

        for (const url of urls) {
          let json;
          try {
            json = await fetchJsonInPage(page, url);
          } catch {
            break;
          }

          const batch = mapUnknownJsonToItems(json);
          if (!batch.length) break;

          for (const it of batch) {
            const sig = `${it.name}::${it.priceText}::${(it.stickers || []).join('|')}`;
            if (seenSigs.has(sig)) continue;
            seenSigs.add(sig);

            const item = {
              name: it.name,
              priceText: it.priceText,
              stickers: it.stickers,
              _sig: sig,
            };
            emit(item);
          }
        }

        fastDone = true;
      }
    }

    if (!fastDone) {
      (await extractVisible(page, SELECTORS)).forEach(emit);

      const container = await getScrollContainer(page, SELECTORS);
      await autoScrollAndStream(
        page,
        container,
        async (batch) => {
          batch.forEach(emit);
        },
        SCROLL,
        SELECTORS
      );
    }

    // First screen:
    (await extractVisible(page, SELECTORS)).forEach(emit);

    // Scroll and stream:
    const container = await getScrollContainer(page, SELECTORS);
    await autoScrollAndStream(
      page,
      container,
      async (batch) => {
        batch.forEach(emit);
      },
      SCROLL
    );

    // Sort + save
    if (OUTPUT.sortBy === 'roi') {
      hits.sort((a, b) => (b.profit?.roi ?? -Infinity) - (a.profit?.roi ?? -Infinity));
    } else if (OUTPUT.sortBy === 'price') {
      hits.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    }

    if (OUTPUT.saveJSON) {
      fs.writeFileSync(jsonPath, JSON.stringify(hits, null, 2), 'utf8');
    }
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

    console.log(` Done. Hits: ${hits.length}`);
    if (OUTPUT.saveJSON) console.log('Saved:', jsonPath);
    if (OUTPUT.saveCSV) console.log('Saved:', csvPath);
  } finally {
    if (!BROWSER.connectWSEndpoint) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { main };
