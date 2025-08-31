
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
