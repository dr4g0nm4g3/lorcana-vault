# Lorcana Vault — Illumineer's Archive

A Disney Lorcana TCG card browser and deck builder that runs entirely in the browser,
fetching live card data from the [Lorcast API](https://api.lorcast.com).

---

## Quick start

```bash
# One-time setup — installs sql.js for local DB integration tests
npm install

# Build the app
node build.js

# Open in your browser — no server needed
open dist/lorcana-browser.html        # macOS
xdg-open dist/lorcana-browser.html   # Linux
start dist/lorcana-browser.html       # Windows
```

> **Note:** The app fetches card data from the Lorcast API on first load.
> Due to browser CORS restrictions, you need to serve the file via a local
> web server rather than opening it directly from the filesystem:
>
> ```bash
> cd dist && python -m http.server 8080
> # then visit http://localhost:8080/lorcana-browser.html
> ```

---

## Project structure

```
lorcana-vault/
│
├── src/
│   ├── lorcana.js        ← Pure business logic (source of truth)
│   │                       No DOM dependencies. Used by both the app
│   │                       (via build) and the test suite (via require).
│   │
│   ├── app.js            ← DOM-dependent application code
│   │                       Rendering, event handlers, DB queries, boot.
│   │                       Calls functions from lorcana.js.
│   │
│   ├── template.html     ← HTML shell with two placeholders:
│   │                         // $$LORCANA_LOGIC$$   ← replaced by lorcana.js
│   │                         // $$LORCANA_APP$$     ← replaced by app.js
│   │
│   └── db-helpers.js     ← Test utility: in-memory SQLite setup (no DOM)
│
├── dist/
│   └── lorcana-browser.html   ← Generated output — DO NOT EDIT DIRECTLY
│                                 Double-clickable single HTML file.
│
├── lorcana.test.js       ← Test suite (142 tests, no browser required)
├── build.js              ← Build script (no npm packages needed)
├── package.json
└── README.md
```

---

## Development workflow

### Making a change to business logic

1. Edit `src/lorcana.js`
2. Run `npm install              # one-time setup (installs sql.js)
node --test lorcana.test.js` to verify nothing broke
3. Run `node build.js` to produce the new `dist/lorcana-browser.html`

### Making a change to the UI / rendering

1. Edit `src/app.js` or `src/template.html`
2. Run `node build.js`
3. Open / refresh `dist/lorcana-browser.html`

### Watch mode (rebuilds on every save)

```bash
node build.js --watch
```

---

## Testing

Run `npm install` once, then tests work identically locally and on CI:

```bash
npm install              # one-time setup (installs sql.js)
node --test lorcana.test.js
```

The test suite covers 14 areas across 142 tests:

| Area | Description |
|------|-------------|
| `normStr` | Unicode normalisation (smart quotes, dashes, ellipsis) |
| `h` | HTML escaping |
| `cardEntry` / `sbEntry` | Deck data accessors with legacy migration |
| `migrateDeck` | Full deck format migration |
| Deck mutations | add / remove / setQty / toggleFoil for main deck |
| Sideboard mutations | add / remove / setQty / toggleFoil for sideboard |
| Statistics | totalCards, unique, avgCost, inkCounts |
| Export | formatDeckLine, buildDeckText |
| Import | parseDeckImportText (foil, sideboard section, qty formats) |
| Filter helpers | makeFilter, isStatFilterActive |
| Rarity ranking | rarityRank, highestRarity |
| Deck filter IDs | deckFilterIds (In Deck / In Sideboard filter) |
| DB integration | card_canonical dedup, filter queries, rarity art selection |

**DB integration tests** require `sql.js` to be installed:

```bash
npm install          # installs sql.js devDependency
npm install              # one-time setup (installs sql.js)
node --test lorcana.test.js   # all 142 tests including DB tests
```

Without sql.js, the DB integration suite skips gracefully — all other 141 tests still run.

---

## Architecture: single source of truth

`src/lorcana.js` is wrapped in a [UMD](https://github.com/umdjs/umd) pattern:

```js
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();   // Node: used by tests via require()
  } else {
    Object.assign(root, factory()); // Browser: functions become globals
  }
}(globalThis, function() {
  // ... all pure functions ...
  return { normStr, h, cardEntry, ... };
}));
```

This means:
- **Tests** `require('./src/lorcana.js')` and get a module object
- **The built HTML** has `lorcana.js` inlined before `app.js`, so all exports
  become global functions that `app.js` calls directly — exactly as if they
  were always defined inline

The build step is pure string concatenation using only `node:fs`. No bundler,
no transpiler, no dependencies beyond Node itself.
