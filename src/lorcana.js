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
    q: '',
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
  // Print swapping
  swapCardPrint, swapSideboardPrint,
  // Statistics
  deckTotalCards, sideboardTotalCards, deckUniqueCards, deckAvgCost, deckInkCounts,
  // Export / import
  formatDeckLine, buildDeckText, parseDeckImportText,
};

})); // end UMD
