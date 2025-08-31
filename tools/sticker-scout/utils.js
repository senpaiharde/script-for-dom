

function normalizeSpaces(s = '') {
  return s.replace(/\s+/g, ' ').trim();
}

function parsePrice(text = '') {
  if (!text) return null;
  let cleaned = text.replace(/[^\d.,]/g, '').trim();
  cleaned = cleaned.replace(/[.,]+$/, '');
  if (!cleaned) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  const decimalIdx = Math.max(lastDot, lastComma);

  if (decimalIdx === -1) {
    const num = Number(cleaned.replace(/[.,]/g, ''));
    return Number.isFinite(num) ? num : null;
  }
  const intPart = cleaned.slice(0, decimalIdx).replace(/[.,]/g, '');
  const fracPart = cleaned.slice(decimalIdx + 1);
  const val = Number(intPart + '.' + fracPart);
  return Number.isFinite(val) ? val : null;
}

function priceMatch(price, min, max) {
  if (price == null) return false;
  if (min != null && price < min) return false;
  if (max != null && price > max) return false;
  return true;
}

function stickerMatch(stickers, { mode, terms, regex, minCount }) {
  if (!stickers || stickers.length < (minCount || 0)) return false;
  const lower = stickers.map((s) => s.toLowerCase());

  if (mode === 'regex' && regex) {
    let rx = regex instanceof RegExp ? regex : null;
    if (!rx) {
      try {
        rx = new RegExp(regex, 'i');
      } catch {}
    }
    return rx ? stickers.some((s) => rx.test(s)) : false;
  }

  if (!terms || terms.length === 0) return true;
  if (mode === 'all') {
    return terms.every((t) => lower.some((s) => s.includes(String(t).toLowerCase())));
  }
  // 'any'
  return terms.some((t) => lower.some((s) => s.includes(String(t).toLowerCase())));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function estimateProfit(buyPrice, PROFIT) {
  if (!PROFIT?.enabled || !Number.isFinite(buyPrice)) return null;
  const target = buyPrice * (1 + PROFIT.baseSpreadGain + PROFIT.stickerUplift);
  const netAfterSteam = target * (1 - PROFIT.steamFee);
  const afterDiscounts = netAfterSteam * (1 - PROFIT.saleDiscount);
  const afterHardcut = afterDiscounts * (1 - PROFIT.hardcodeCut);
  return {
    target,
    netAfterSteam,
    afterDiscounts,
    afterHardcut,
    absolute: round2(afterHardcut - buyPrice),
    roi: round4((afterHardcut - buyPrice) / buyPrice),
  };
}

module.exports = {
  normalizeSpaces,
  parsePrice,
  priceMatch,
  stickerMatch,
  estimateProfit,
};
