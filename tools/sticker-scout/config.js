
module.exports = {
  TARGET: {
    // How we pick the right tab/page automatically
    urlHint: 'skinsmonkey.com/trade', // keep as-is
  },

  // Filters you want by default (no CLI – just edit here)
  FILTERS: {
    minPrice: 2,           // number | null
    maxPrice: 65,         // number | null
    stickerMode: 'any',    // 'any' | 'all' | 'regex'
    stickerTerms: ['Holo', 'stockholm'], // used for 'any' or 'all'
    stickerRegex: null,    // e.g. '(Holo|Foil)' (case-insensitive)
    minStickerCount: 1,
  },

  // Profit model – tune or disable
  PROFIT: {
    enabled: true,
    baseSpreadGain: 0.35,  // +35%
    stickerUplift: 0.25,   // +25%
    steamFee: 0.15,        // -15%
    saleDiscount: 0.35,    // -35%
    hardcodeCut: 0.10,     // -10%
  },

  // Scrolling over virtualized list
  SCROLL: {
    maxBatches: 40,
    perBatchPx: 1100,
    waitBetweenMs: 500,
    earlyStopIfNoNew: 4,
  },

  // Output behavior
  OUTPUT: {
    dir: 'out',
    streamHits: true,   // print HIT lines immediately
    saveJSON: true,
    saveCSV: true,
    sortBy: 'roi',      // 'roi' | 'price' | 'none'
  },

  // Browser setup – swap to connect if you want to attach to an existing Chrome
  BROWSER: {
    headless: true,
    connectWSEndpoint: null, // e.g. 'ws://127.0.0.1:9222/devtools/browser/<id>'
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },

  // CSS selectors tuned for skinsmonkey.com/trade (based on your screenshot)
  SELECTORS: {
    card: '.item-card',
    gunImg: '.item-card__image, .item-image.item-card__image, .item-thumb img',
    name: '.item-card__title, .itemName',
    stickerImgs: '.item-card__stickers img[alt], .item-card-stickers img[alt]',
    price: '.item-card__price.item-price, .item-price.item-card__price',
    scrollContainer: '.inventory-grid-row, .vue-recycle-scroller__item-view',
  },
};
