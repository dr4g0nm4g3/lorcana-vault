// ─────────────────────────────────────────────────────────────────────────────
// lorcana.js  —  Pure business logic for Lorcana Vault
//
// UMD wrapper: works as module.exports in Node (for tests) and as plain
// globals in the browser (when inlined by the build step). No imports, no
// DOM dependencies. Every function here must be pure and side-effect free.
// ─────────────────────────────────────────────────────────────────────────────
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    // Node / CommonJS — used by the test suite
    module.exports = factory();
  } else {
    // Browser — attach everything as globals on window
    const exports = factory();
    Object.assign(root, exports);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
'use strict';

// ── Rotation constants ────────────────────────────────────────────────────────
// Sets 1–4 rotated out of Core Constructed when Set 9 (Fabled) released.
// The Lorcast API does not update legalities.core to reflect rotation, so we
// derive legality ourselves from set_code.
// Promo sets (cp, P2, D23, P1) are treated as rotated since their source cards
// are from sets 1–4; if a promo was reprinted in a legal set it will have a
// separate card entry with that set's code.
const ROTATED_SET_CODES = new Set(['1','2','3','4','cp','P1','D23']);

// SQL expression: true when the card (or any printing of the same name/version)
// has at least one printing in a non-rotated set.
// Used in runQ / drunQ / selectAll WHERE clauses.
const CORE_LEGAL_SQL =
  `EXISTS(SELECT 1 FROM cards p WHERE p.name=card_canonical.name AND COALESCE(p.version,'')=COALESCE(card_canonical.version,'') AND p.set_code NOT IN('1','2','3','4','cp','P1','D23'))`;

// ── Rarity constants ──────────────────────────────────────────────────────────

const RARITY_ORDER = ['Iconic','Epic','Enchanted','Legendary','Super_rare','Rare','Uncommon','Common','Promo'];

// SQL expression for ranking rarities (used in buildFrom and drunQ / runQ)
const RARITY_RANK = "CASE rarity WHEN 'Iconic' THEN 0 WHEN 'Epic' THEN 1 WHEN 'Enchanted' THEN 2 WHEN 'Legendary' THEN 3 WHEN 'Super_rare' THEN 4 WHEN 'Rare' THEN 5 WHEN 'Uncommon' THEN 6 ELSE 7 END";

/** Return the numeric rank for a rarity string (lower = rarer / higher priority). */
function rarityRank(rarity) {
  const idx = RARITY_ORDER.indexOf(rarity);
  return idx === -1 ? 99 : idx;
}

/** Given an array of rarity strings, return the one with highest priority. */
function highestRarity(rarities) {
  return rarities.reduce((best, r) =>
    rarityRank(r) < rarityRank(best) ? r : best
  );
}

// ── String utilities ──────────────────────────────────────────────────────────

/**
 * Normalise Unicode punctuation variants to plain ASCII so that card names
 * differing only in smart-quote / apostrophe encoding are treated as the same.
 */
function normStr(s) {
  if (!s) return null;
  return s
    .replace(/[\u2018\u2019\u02BC\u02B9\u0060\u00B4\uFF07]/g, "'")
    .replace(/[\u201C\u201D\u00AB\u00BB\uFF02]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/[\u2026]/g, '...')
    .trim() || null;
}

/** HTML-escape a value for safe insertion into markup. */
function h(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Filter factory ────────────────────────────────────────────────────────────

/**
 * Create a blank filter state object matching the shape used by runQ / drunQ.
 * Callers may pass overrides for any field.
 */
function makeFilter(overrides) {
  return Object.assign({
    ink: new Set(), rarity: new Set(), type: new Set(), typeExact: new Set(),
    classification: new Set(), set: new Set(), keywords: new Set(),
    inkwell: null, cmin: 0, cmax: 10,
    lmin: null, lmax: null, smin: null, smax: null, wmin: null, wmax: null,
    q: '', format: null,
  }, overrides || {});
}

/**
 * Returns true when the stat slider range is not at its full default (i.e. the
 * filter is actively constraining results). Matches the logic in updStat().
 */
function isStatFilterActive(mn, mx, stat) {
  const maxVal = stat === 'l' ? 4 : 10;
  return !(mn === 0 && mx === maxVal);
}

// ── Query builder helpers ─────────────────────────────────────────────────────

/**
 * Returns [fromClause, fromParams].
 *
 * No rarity filter → card_canonical (one canonical row per card).
 * Rarity filter active → derived table that picks the highest-priority
 * matching-rarity print per card, ranked by RARITY_RANK then id.
 */
function buildFrom(rarities) {
  if (!rarities || rarities.size === 0) return ['card_canonical', []];
  const NORM = "REPLACE(REPLACE(REPLACE(name,char(8217),char(39)),char(8216),char(39)),char(700),char(39))";
  const ph = [...rarities].map(() => '?').join(',');
  const sql = `(
    SELECT c.* FROM cards c
    WHERE c.rarity IN(${ph})
      AND c.id=(
        SELECT c2.id FROM cards c2
        WHERE ${NORM.replace(/name/g, 'c2.name')}=${NORM.replace(/name/g, 'c.name')}
          AND COALESCE(c2.version,'')=COALESCE(c.version,'')
          AND c2.rarity IN(${ph})
        ORDER BY ${RARITY_RANK.replace(/rarity/g, 'c2.rarity')},c2.id
        LIMIT 1
      )
  ) card_canonical`;
  const r = [...rarities];
  return [sql, [...r, ...r]];
}

/**
 * Given a deck and a filter mode ('deck' | 'sideboard' | null), return the Set
 * of card IDs that should be shown. null means no restriction.
 */
function deckFilterIds(deck, mode) {
  if (!mode) return null;
  const pool = mode === 'sideboard' ? (deck.sideboard || {}) : deck.cards;
  return new Set(Object.keys(pool));
}

// ── Deck data model ───────────────────────────────────────────────────────────

/**
 * Safely read a card entry from deck.cards, migrating legacy plain-number
 * values to {qty, foil} on the fly. Returns null when absent.
 */
function cardEntry(deck, id) {
  const v = deck.cards[id];
  if (v === undefined) return null;
  if (typeof v === 'number') return { qty: v, foil: false };
  return v;
}

/**
 * Safely read a card entry from deck.sideboard, with the same migration logic.
 */
function sbEntry(deck, id) {
  if (!deck.sideboard) deck.sideboard = {};
  const v = deck.sideboard[id];
  if (v === undefined) return null;
  if (typeof v === 'number') return { qty: v, foil: false };
  return v;
}

/**
 * Ensure a deck has all required fields and all card values are in the
 * {qty, foil} format. Mutates in place and returns the deck.
 */
function migrateDeck(d) {
  if (!d.sideboard) d.sideboard = {};
  Object.entries(d.cards).forEach(([id, v]) => {
    if (typeof v === 'number') d.cards[id] = { qty: v, foil: false };
  });
  Object.entries(d.sideboard).forEach(([id, v]) => {
    if (typeof v === 'number') d.sideboard[id] = { qty: v, foil: false };
  });
  return d;
}

// ── Main deck mutations ───────────────────────────────────────────────────────

function addCardToDeck(deck, cardId) {
  const e = cardEntry(deck, cardId);
  deck.cards[cardId] = e ? { qty: e.qty + 1, foil: e.foil } : { qty: 1, foil: false };
}

function removeCardFromDeck(deck, cardId) {
  const e = cardEntry(deck, cardId);
  if (!e) return;
  if (e.qty > 1) deck.cards[cardId] = { qty: e.qty - 1, foil: e.foil };
  else delete deck.cards[cardId];
}

function setCardQty(deck, cardId, qty) {
  qty = parseInt(qty) || 0;
  if (qty <= 0) delete deck.cards[cardId];
  else { const e = cardEntry(deck, cardId); deck.cards[cardId] = { qty, foil: e ? e.foil : false }; }
}

function toggleCardFoil(deck, cardId) {
  const e = cardEntry(deck, cardId);
  if (!e) return;
  deck.cards[cardId] = { qty: e.qty, foil: !e.foil };
}

// ── Sideboard mutations ───────────────────────────────────────────────────────

function addCardToSideboard(deck, cardId) {
  if (!deck.sideboard) deck.sideboard = {};
  const e = sbEntry(deck, cardId);
  deck.sideboard[cardId] = e ? { qty: e.qty + 1, foil: e.foil } : { qty: 1, foil: false };
}

function removeCardFromSideboard(deck, cardId) {
  const e = sbEntry(deck, cardId);
  if (!e) return;
  if (e.qty > 1) deck.sideboard[cardId] = { qty: e.qty - 1, foil: e.foil };
  else delete deck.sideboard[cardId];
}

function setSideboardCardQty(deck, cardId, qty) {
  qty = parseInt(qty) || 0;
  if (qty <= 0) delete deck.sideboard[cardId];
  else { const e = sbEntry(deck, cardId); deck.sideboard[cardId] = { qty, foil: e ? e.foil : false }; }
}

function toggleSideboardFoil(deck, cardId) {
  const e = sbEntry(deck, cardId);
  if (!e) return;
  deck.sideboard[cardId] = { qty: e.qty, foil: !e.foil };
}

// ── Deck statistics ───────────────────────────────────────────────────────────

function deckTotalCards(deck) {
  return Object.values(deck.cards).reduce((s, v) => s + (+(v?.qty ?? v) || 0), 0);
}

function sideboardTotalCards(deck) {
  return Object.values(deck.sideboard || {}).reduce((s, v) => s + (+(v?.qty ?? v) || 0), 0);
}

function deckUniqueCards(deck) {
  return Object.keys(deck.cards).length;
}

/** Weighted average ink cost. cardData: { [id]: { cost } }. Returns null for empty. */
function deckAvgCost(deck, cardData) {
  let totalCost = 0, count = 0;
  Object.entries(deck.cards).forEach(([id, v]) => {
    const e = typeof v === 'number' ? { qty: v } : v;
    const c = cardData[id];
    if (c && c.cost != null) { totalCost += c.cost * e.qty; count += e.qty; }
  });
  return count > 0 ? totalCost / count : null;
}

/** Ink distribution for deck.cards. cardData: { [id]: { ink } }. */
function deckInkCounts(deck, cardData) {
  const counts = {};
  Object.entries(deck.cards).forEach(([id, v]) => {
    const e = typeof v === 'number' ? { qty: v } : v;
    const c = cardData[id];
    if (c?.ink) counts[c.ink] = (counts[c.ink] || 0) + e.qty;
  });
  return counts;
}

// ── Export / import ───────────────────────────────────────────────────────────

/** Format one card entry as a text line. cardData must have { name, version? }. */
function formatDeckLine(id, v, cardData) {
  const c = cardData[id];
  if (!c) return '';
  const e = typeof v === 'number' ? { qty: v, foil: false } : v;
  return `${e.qty}x ${c.name}${c.version ? ' - ' + c.version : ''}${e.foil ? ' (foil)' : ''}`;
}

/** Full export text for a deck including optional sideboard section. */
function buildDeckText(deck, cardData) {
  const mainLines = Object.entries(deck.cards)
    .map(([id, v]) => formatDeckLine(id, v, cardData)).filter(Boolean).join('\n');
  const sbLines = Object.entries(deck.sideboard || {})
    .map(([id, v]) => formatDeckLine(id, v, cardData)).filter(Boolean).join('\n');
  return mainLines + (sbLines ? '\n\nSideboard:\n' + sbLines : '');
}

/**
 * Parse a deck-list text string into import directives.
 * Each directive: { name, version|null, qty, foil, target: 'deck'|'sideboard' }
 */
function parseDeckImportText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const directives = [];
  let isSB = false;
  for (const line of lines) {
    if (/^sideboard:?$/i.test(line)) { isSB = true; continue; }
    const m = line.match(/^(?:(\d+)\s*[xX×]\s*)?(.+)$/);
    if (!m) continue;
    const qty = parseInt(m[1] || '1');
    const rawFoil = /\(foil\)/i.test(m[2]);
    const raw = m[2].replace(/\(foil\)/i, '').trim();
    const di = raw.indexOf(' - ');
    const name = di > -1 ? raw.substring(0, di).trim() : raw;
    const version = di > -1 ? raw.substring(di + 3).trim() : null;
    directives.push({ name, version, qty, foil: rawFoil, target: isSB ? 'sideboard' : 'deck' });
  }
  return directives;
}

// ── Card export helpers ───────────────────────────────────────────────────────

/** Escape a string for safe HTML insertion. */
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format a card's rules text for HTML display.
 * Converts {I}/{E}/{S} symbols, newlines to <br>, and bolds leading keywords.
 */
function fmtRules(t) {
  if (!t) return '';
  return escHtml(t)
    .replace(/\{I\}/g, '<span class="sym cost-sym">◆</span>')
    .replace(/\{E\}/g, '<span class="sym">⟳</span>')
    .replace(/\{S\}/g, '<span class="sym">✦</span>')
    .replace(/\n/g, '<br>')
    .replace(/(^|<br>)([A-Z][A-Z ,'\-]+?)(?=\s|\()/g, '$1<b>$2</b>');
}

const EXPORT_INK_COLOR = {
  Amber:'#b45309', Amethyst:'#7c3aed', Emerald:'#059669',
  Ruby:'#dc2626',  Sapphire:'#2563eb', Steel:'#475569',
};

/**
 * Build the HTML for a single card row in the deck card export.
 * @param {object} c  - card data row from the DB (name, version, ink, cost, etc.)
 * @param {{qty:number, foil:boolean}} e - deck entry
 * @returns {string} HTML string for one card-row div
 */
function buildCardRowHtml(c, e) {
  if (!c) return '';
  let types, classes;
  try { types = JSON.parse(c.types || '[]'); } catch { types = []; }
  try { classes = JSON.parse(c.classes || '[]'); } catch { classes = []; }
  const inkColor = EXPORT_INK_COLOR[c.ink] || '#888';
  const isChar = types.includes('Character');
  const isLoc  = types.includes('Location');
  const hasStats = c.str != null || c.wil != null || c.lore != null;
  const qty  = e.qty > 1 ? `<span class="qty">×${e.qty}</span>` : '';
  const foil = e.foil ? `<span class="foil">✦ Foil</span>` : '';

  return `<div class="card-row">
  <div class="card-header">
    <div class="card-title">
      <span class="card-name">${escHtml(c.name)}</span>${c.version ? `<span class="card-ver">${escHtml(c.version)}</span>` : ''}
      ${qty}${foil}
    </div>
    <div class="card-meta">
      ${c.ink ? `<span class="ink-badge" style="background:${inkColor}">${escHtml(c.ink)}</span>` : ''}
      ${c.cost != null ? `<span class="stat-chip"><span class="sym cost-sym">◆</span>${c.cost}</span>` : ''}
      <span class="stat-chip">${c.inkwell ? 'Inkable' : 'Non-inkable'}</span>
      <span class="type-chip">${types.map(escHtml).join(' · ')}</span>
      ${classes.length ? `<span class="type-chip cls">${classes.map(escHtml).join(', ')}</span>` : ''}
      ${isChar && hasStats ? `
        ${c.str  != null ? `<span class="stat-chip">STR <b>${c.str}</b></span>`  : ''}
        ${c.wil  != null ? `<span class="stat-chip">WIL <b>${c.wil}</b></span>`  : ''}
        ${c.lore != null ? `<span class="stat-chip">◆${c.lore}</span>`           : ''}
      ` : ''}
      ${isLoc && c.move_cost != null ? `<span class="stat-chip">Move <b>${c.move_cost}</b></span>` : ''}
      ${isLoc && c.lore != null ? `<span class="stat-chip">◆${c.lore}</span>` : ''}
    </div>
  </div>
  ${c.ctxt   ? `<div class="rules-text">${fmtRules(c.ctxt)}</div>`           : ''}
  ${c.flavor ? `<div class="flavor-text">"${escHtml(c.flavor)}"</div>` : ''}
</div>`;
}

/**
 * Build a plain-text block for a single card, optimised for AI consumption.
 * Symbols: [I] = ink cost, [E] = exert, [S] = lore pip
 * One card per block; blocks are separated by "---" by the caller.
 *
 * @param {object} c  - card row from DB (name, version, ink, inkwell, cost,
 *                      types, classes, str, wil, lore, move_cost, ctxt, flavor)
 * @param {{qty:number, foil:boolean}} e - deck entry
 * @returns {string}
 */
function buildCardText(c, e) {
  if (!c) return '';
  let types, classes;
  try { types = JSON.parse(c.types || '[]'); } catch { types = []; }
  try { classes = JSON.parse(c.classes || '[]'); } catch { classes = []; }

  const isChar  = types.includes('Character');
  const isLoc   = types.includes('Location');
  const isAction = types.includes('Action');
  const isItem  = types.includes('Item');

  const lines = [];

  // Header
  const title = c.version ? `${c.name} - ${c.version}` : c.name;
  lines.push(`=== ${title} ===`);

  // Deck context
  const deckCtx = [`Qty: ${e.qty}`];
  if (e.foil) deckCtx.push('Foil: Yes');
  lines.push(deckCtx.join('  '));

  // Core stats
  const stats = [];
  if (c.ink)       stats.push(`Ink: ${c.ink}`);
  if (c.cost != null) stats.push(`Cost: ${c.cost}[I]`);
  stats.push(`Inkable: ${c.inkwell ? 'Yes' : 'No'}`);
  if (c.rarity)    stats.push(`Rarity: ${c.rarity.replace('_', ' ')}`);
  lines.push(stats.join('  '));

  // Type line
  const typeLine = [];
  if (types.length)   typeLine.push(`Type: ${types.join(', ')}`);
  if (classes.length) typeLine.push(`Class: ${classes.join(', ')}`);
  if (typeLine.length) lines.push(typeLine.join('  '));

  // Combat / location stats
  const combatStats = [];
  if (isChar) {
    if (c.str  != null) combatStats.push(`STR: ${c.str}`);
    if (c.wil  != null) combatStats.push(`WIL: ${c.wil}`);
    if (c.lore != null) combatStats.push(`Lore: ${c.lore}[S]`);
  }
  if (isLoc) {
    if (c.move_cost != null) combatStats.push(`Move: ${c.move_cost}[I]`);
    if (c.lore      != null) combatStats.push(`Lore: ${c.lore}[S]`);
  }
  if (combatStats.length) lines.push(combatStats.join('  '));

  // Rules text — symbols replaced with readable tokens
  if (c.ctxt) {
    lines.push('');
    const rules = c.ctxt
      .replace(/\{I\}/g, '[I]')
      .replace(/\{E\}/g, '[E]')
      .replace(/\{S\}/g, '[S]');
    lines.push(rules);
  }

  // Flavor text
  if (c.flavor) {
    lines.push('');
    lines.push(`Flavor: "${c.flavor}"`);
  }

  return lines.join('\n');
}

/**
 * Build the full plain-text AI export for a deck.
 * Cards sorted by cost then name; sideboard in a separate section.
 *
 * @param {object} deck     - deck object with .cards and .sideboard
 * @param {object} cardData - map of id → card row (from DB)
 * @returns {string}
 */
function buildDeckCardText(deck, cardData) {
  if (!deck) return '';

  const sortFn = ([ia], [ib]) => {
    const ca = cardData[ia], cb = cardData[ib];
    return (ca?.cost ?? 99) - (cb?.cost ?? 99)
      || (ca?.name || '').localeCompare(cb?.name || '');
  };

  const toEntry = ([id, v]) => [id, typeof v === 'number' ? { qty: v, foil: false } : v];

  const mainEntries = Object.entries(deck.cards).map(toEntry).sort(sortFn);
  const sbEntries   = Object.entries(deck.sideboard || {}).map(toEntry).sort(sortFn);

  const mainTotal = mainEntries.reduce((s, [, e]) => s + e.qty, 0);

  const mainBlocks = mainEntries
    .map(([id, e]) => buildCardText(cardData[id], e))
    .filter(Boolean);

  const header = [
    `DECK: ${deck.name}`,
    `Cards: ${mainTotal}`,
    '='.repeat(60),
  ].join('\n');

  let out = header + '\n\n' + mainBlocks.join('\n\n---\n\n');

  if (sbEntries.length) {
    const sbTotal = sbEntries.reduce((s, [, e]) => s + e.qty, 0);
    const sbBlocks = sbEntries
      .map(([id, e]) => buildCardText(cardData[id], e))
      .filter(Boolean);

    out += '\n\n' + '='.repeat(60) + '\n';
    out += `SIDEBOARD: ${sbTotal} card${sbTotal !== 1 ? 's' : ''}\n`;
    out += '='.repeat(60) + '\n\n';
    out += sbBlocks.join('\n\n---\n\n');
  }

  return out;
}

// ── Print swapping ────────────────────────────────────────────────────────────

/**
 * Swap a card in deck.cards to a different printing of the same card.
 * Removes oldId and inserts newId with qty/foil preserved.
 * If newId already exists in the deck the quantities are merged.
 * No-op when oldId === newId or oldId is not in the deck.
 */
function swapCardPrint(deck, oldId, newId) {
  if (oldId === newId) return;
  const e = cardEntry(deck, oldId);
  if (!e) return;
  const existing = cardEntry(deck, newId);
  if (existing) {
    deck.cards[newId] = { qty: existing.qty + e.qty, foil: existing.foil || e.foil };
  } else {
    deck.cards[newId] = { qty: e.qty, foil: e.foil };
  }
  delete deck.cards[oldId];
}

/**
 * Swap a card in deck.sideboard to a different printing of the same card.
 * Same merge logic as swapCardPrint.
 */
function swapSideboardPrint(deck, oldId, newId) {
  if (oldId === newId) return;
  if (!deck.sideboard) deck.sideboard = {};
  const e = sbEntry(deck, oldId);
  if (!e) return;
  const existing = sbEntry(deck, newId);
  if (existing) {
    deck.sideboard[newId] = { qty: existing.qty + e.qty, foil: existing.foil || e.foil };
  } else {
    deck.sideboard[newId] = { qty: e.qty, foil: e.foil };
  }
  delete deck.sideboard[oldId];
}

// ── Exports ───────────────────────────────────────────────────────────────────

return {
  // Constants
  RARITY_ORDER, RARITY_RANK,
  ROTATED_SET_CODES, CORE_LEGAL_SQL,
  // Rarity
  rarityRank, highestRarity,
  // Strings
  normStr, h,
  // Filters
  makeFilter, isStatFilterActive, buildFrom, deckFilterIds,
  // Data model
  cardEntry, sbEntry, migrateDeck,
  // Deck mutations
  addCardToDeck, removeCardFromDeck, setCardQty, toggleCardFoil,
  // Sideboard mutations
  addCardToSideboard, removeCardFromSideboard, setSideboardCardQty, toggleSideboardFoil,
  // Export helpers
  escHtml, fmtRules, buildCardRowHtml,
  buildCardText, buildDeckCardText,
  // Print swapping
  swapCardPrint, swapSideboardPrint,
  // Statistics
  deckTotalCards, sideboardTotalCards, deckUniqueCards, deckAvgCost, deckInkCounts,
  // Export / import
  formatDeckLine, buildDeckText, parseDeckImportText,
};

})); // end UMD
