module.exports = {
  TARGET: {
    //  name: 'SkinsMonkey',
    startUrl: 'https://skinsmonkey.com/trade',
    navigateIfEmpty: true,
  },

  // Filters you want by default (no CLI – just edit here)
  FILTERS: {
    minPrice: 0.5, // number | null
    maxPrice: 59, // number | null
    stickerMode: 'any', // 'any' | 'all' | 'regex'
    stickerTerms: [], // used for 'any' or 'all'
    stickerRegex: null, // e.g. '(Holo|Foil)' (case-insensitive)
    minStickerCount: 1,
  },

  // Profit model – tune or disable
  PROFIT: {
    enabled: true,
    baseSpreadGain: 0.35, // +35%
    stickerUplift: 0.25, // +25%
    steamFee: 0.15, // -15%
    saleDiscount: 0.35, // -35%
    hardcodeCut: 0.1, // -10%
  },

  SCROLL: {
    maxBatches: 40,
    perBatchPx: 1100,
    waitBetweenMs: 500,
    earlyStopIfNoNew: 4,
  },

  // Output behavior
  OUTPUT: {
    dir: 'out',
    streamHits: true, // print HIT lines immediately
    saveJSON: true,
    saveCSV: true,
    sortBy: 'roi', // 'roi' | 'price' | 'none'
    debugFirstN: 10,
  },
  FAST: {
    enabled: true, // set false to disable
    discoveryMs: 4000, //FETCH TIMER 4 sec
    endpointMatch: /(inventory|items|market|trade|list|search)/i,
    pageParam: 'page', // look forword to this param in URLs
    sizeParam: 'size', // getting size
    pageSize: 60,
    maxPages: 40,
    saveSample: true, //taking saved data
  },

  BROWSER: {
    headless: true,
    connectWSEndpoint: null, // e.g. 'ws://127.0.0.1:9222/devtools/browser/<id>'
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },

  SELECTORS: {
    card: '.item-card',
    gunImg: '.item-card__image, .item-image.item-card__image, .item-thumb img',
    name: '.item-card__title, .itemName',
    stickerImgs: '.item-card__stickers img, .item-card-stickers img, [class*="sticker"] img',
    price: '.item-card__price.item-price, .item-price.item-card__price',
    scrollContainer: '.inventory-grid-row, .vue-recycle-scroller__item-view',
  },
  // FAST_FETCH: direct API scanner
  FETCH: {
    enabled: true,
    baseUrl: 'https://skinsmonkey.com/api/inventory',
    appId: 730,
    sort: 'price-desc', // or 'price-asc'
    limit: 60, // as observed
    maxPages: 180, // safety cap
    useServerPriceFilters: true, // adds priceMin/priceMax to query if you set min/max
    priceFactor: 100, // API uses cents: 5900 => $59.00
    tradeLock: 7,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      accept: 'application/json,text/plain,*/*',
    },
    startOffset: 0, // where to begin (offset is multiples of limit)
  },

  POLITENESS: {
    minDelayMs: 800, // base delay between requests
    maxDelayMs: 1500, // randomize between min..max
    jitterMs: 300, // extra tiny jitter
    requestsPerMinute: 20, // soft cap; tool paces itself
    maxPagesPerRun: 40, // hard cap for a single run
    stopOnHttp: [401, 402, 403, 429], // halt immediately on these
    backoffMs: 4000, // brief backoff for 429 before one retry
    maxConsecutiveErrors: 1, // trip the breaker if errors repeat
    dryRun: false, // true → print URLs only, don’t fetch
  },
};
