
const { main } = require('./scan');

main().catch((err) => {
  console.error('Fatal:', err?.stack || err);
  process.exit(1);
});
