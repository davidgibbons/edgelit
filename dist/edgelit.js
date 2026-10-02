// HACS registers only this file, so it loads the cards. The query string HACS
// adds to bust caches (?hacstag=…) is passed on, or browsers would keep stale
// copies of the cards after an update.
const v = new URL(import.meta.url).search;
await Promise.all([import(`./edgelit-panel-card.js${v}`), import(`./edgelit-hosts-card.js${v}`), import(`./edgelit-energy-card.js${v}`)]);
