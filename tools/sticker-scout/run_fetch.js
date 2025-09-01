console.log('[sticker-scout:fetch] boot');
const { main } = require('./scan_fetch');
main().catch((e) => {
  console.error('Fatal:', e?.stack || e);
  process.exit(1);
});
