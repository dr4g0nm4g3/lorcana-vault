// lorcana.test.js
// Run with:  node --test lorcana.test.js
//
// Uses Node's built-in test runner (node:test) and assert module — no external
// dependencies required.  The sql.js-backed DB integration tests are skipped
// automatically when sql.js is not installed.
//
// Coverage areas:
//   1. normStr          – Unicode normalisation
//   2. h                – HTML escaping
//   3. cardEntry        – deck.cards accessor + legacy migration
//   4. sbEntry          – sideboard accessor + legacy migration
//   5. migrateDeck      – deck-level migration
//   6. Deck mutations   – add / remove / setQty / toggleFoil (main deck)
//   7. Sideboard        – add / remove / setQty / toggleFoil (sideboard)
//   8. Statistics       – totalCards / unique / avgCost / inkCounts
//   9. Export           – formatDeckLine / buildDeckText
//  10. Import parsing   – parseDeckImportText
//  11. Filter helpers   – makeFilter / isStatFilterActive
//  12. Rarity ranking   – rarityRank / highestRarity
//  13. Deck filter IDs  – deckFilterIds
//  14. DB integration   – card_canonical dedup, buildFrom rarity logic,
//                         runQ filter logic (sql.js required)

'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  normStr,
  h,
  cardEntry,
  sbEntry,
  migrateDeck,
  addCardToDeck,
  removeCardFromDeck,
  setCardQty,
  toggleCardFoil,
  addCardToSideboard,
  removeCardFromSideboard,
  setSideboardCardQty,
  toggleSideboardFoil,
  deckTotalCards,
  sideboardTotalCards,
  deckUniqueCards,
  deckAvgCost,
  deckInkCounts,
  formatDeckLine,
  buildDeckText,
  parseDeckImportText,
  makeFilter,
  isStatFilterActive,
  rarityRank,
  highestRarity,
  deckFilterIds,
} = require('./src/lorcana.js');
const { makeDb, insertCard, queryCount, queryRows } = require('./src/db-helpers.js');

// ─── helpers ────────────────────────────────────────────────────────────────

/** Create a blank deck with the correct shape. */
function mkDeck(id = 'd1') {
  return { id, name: 'Test Deck', cards: {}, sideboard: {} };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. normStr
// ═══════════════════════════════════════════════════════════════════════════════

describe('normStr', () => {
  test('returns null for falsy input', () => {
    assert.equal(normStr(null), null);
    assert.equal(normStr(''), null);
    assert.equal(normStr(undefined), null);
  });

  test('trims whitespace and returns null for blank strings', () => {
    assert.equal(normStr('   '), null);
  });

  test('normalises right smart apostrophe (U+2019)', () => {
    assert.equal(normStr('A Pirate\u2019s Life'), "A Pirate's Life");
  });

  test('normalises left smart apostrophe (U+2018)', () => {
    assert.equal(normStr("That\u2018s More Like It"), "That's More Like It");
  });

  test('normalises modifier-letter apostrophe (U+02BC)', () => {
    assert.equal(normStr("Let\u02BCs Go"), "Let's Go");
  });

  test('normalises backtick and acute accent apostrophes', () => {
    assert.equal(normStr('It\u0060s'), "It's");
    assert.equal(normStr('It\u00B4s'), "It's");
  });

  test('normalises smart double quotes', () => {
    assert.equal(normStr('\u201CHello\u201D'), '"Hello"');
  });

  test('normalises em-dash and en-dash to hyphen', () => {
    assert.equal(normStr('One\u2013Two'), 'One-Two');
    assert.equal(normStr('One\u2014Two'), 'One-Two');
  });

  test('normalises ellipsis character', () => {
    assert.equal(normStr('Wait\u2026'), 'Wait...');
  });

  test('leaves plain ASCII untouched', () => {
    assert.equal(normStr("Mickey Mouse - Brave Little Tailor"), "Mickey Mouse - Brave Little Tailor");
  });

  test('handles mixed Unicode in one string', () => {
    const input = '\u201CElsa\u201D \u2014 Spirit of Winter\u2026';
    assert.equal(normStr(input), '"Elsa" - Spirit of Winter...');
  });

  test('two names that differ only in apostrophe style normalise to the same string', () => {
    assert.equal(normStr("A Pirate\u2019s Life"), normStr("A Pirate's Life"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. h (HTML escaping)
// ═══════════════════════════════════════════════════════════════════════════════

describe('h (HTML escape)', () => {
  test('escapes ampersand', () => assert.equal(h('a&b'), 'a&amp;b'));
  test('escapes less-than', () => assert.equal(h('a<b'), 'a&lt;b'));
  test('escapes greater-than', () => assert.equal(h('a>b'), 'a&gt;b'));
  test('escapes double-quote', () => assert.equal(h('"hi"'), '&quot;hi&quot;'));
  test('escapes all dangerous characters together', () => {
    assert.equal(h('<script>"alert"&</script>'), '&lt;script&gt;&quot;alert&quot;&amp;&lt;/script&gt;');
  });
  test('leaves safe strings untouched', () => {
    assert.equal(h("Mickey Mouse - Brave Little Tailor"), "Mickey Mouse - Brave Little Tailor");
  });
  test('converts non-string values to string', () => {
    assert.equal(h(42), '42');
    assert.equal(h(null), '');
    assert.equal(h(undefined), '');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. cardEntry
// ═══════════════════════════════════════════════════════════════════════════════

describe('cardEntry', () => {
  test('returns null when card is not in deck', () => {
    const deck = mkDeck();
    assert.equal(cardEntry(deck, 'missing'), null);
  });

  test('returns entry when card has object format', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 3, foil: true };
    assert.deepEqual(cardEntry(deck, 'c1'), { qty: 3, foil: true });
  });

  test('migrates legacy plain-number to {qty, foil:false}', () => {
    const deck = mkDeck();
    deck.cards['c1'] = 2;
    const e = cardEntry(deck, 'c1');
    assert.deepEqual(e, { qty: 2, foil: false });
  });

  test('migration does not mutate deck.cards', () => {
    const deck = mkDeck();
    deck.cards['c1'] = 4;
    cardEntry(deck, 'c1');
    // deck.cards['c1'] should still be the original number (cardEntry doesn't mutate)
    assert.equal(typeof deck.cards['c1'], 'number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. sbEntry
// ═══════════════════════════════════════════════════════════════════════════════

describe('sbEntry', () => {
  test('returns null when card is not in sideboard', () => {
    const deck = mkDeck();
    assert.equal(sbEntry(deck, 'missing'), null);
  });

  test('returns entry when card has object format', () => {
    const deck = mkDeck();
    deck.sideboard['c1'] = { qty: 1, foil: false };
    assert.deepEqual(sbEntry(deck, 'c1'), { qty: 1, foil: false });
  });

  test('migrates legacy plain-number', () => {
    const deck = mkDeck();
    deck.sideboard['c1'] = 3;
    assert.deepEqual(sbEntry(deck, 'c1'), { qty: 3, foil: false });
  });

  test('initialises sideboard to {} when missing', () => {
    const deck = { id: 'd1', name: 'x', cards: {} }; // no sideboard key
    sbEntry(deck, 'c1');
    assert.ok('sideboard' in deck);
    assert.deepEqual(deck.sideboard, {});
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. migrateDeck
// ═══════════════════════════════════════════════════════════════════════════════

describe('migrateDeck', () => {
  test('converts plain-number card entries to objects', () => {
    const deck = { id: 'd', name: 'x', cards: { c1: 2, c2: 4 }, sideboard: {} };
    migrateDeck(deck);
    assert.deepEqual(deck.cards['c1'], { qty: 2, foil: false });
    assert.deepEqual(deck.cards['c2'], { qty: 4, foil: false });
  });

  test('converts plain-number sideboard entries', () => {
    const deck = { id: 'd', name: 'x', cards: {}, sideboard: { s1: 1 } };
    migrateDeck(deck);
    assert.deepEqual(deck.sideboard['s1'], { qty: 1, foil: false });
  });

  test('creates sideboard when absent', () => {
    const deck = { id: 'd', name: 'x', cards: {} };
    migrateDeck(deck);
    assert.deepEqual(deck.sideboard, {});
  });

  test('leaves correctly-typed entries unchanged', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: true };
    migrateDeck(deck);
    assert.deepEqual(deck.cards['c1'], { qty: 2, foil: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Main deck mutations
// ═══════════════════════════════════════════════════════════════════════════════

describe('addCardToDeck', () => {
  test('adds a new card with qty 1', () => {
    const deck = mkDeck();
    addCardToDeck(deck, 'c1');
    assert.deepEqual(deck.cards['c1'], { qty: 1, foil: false });
  });

  test('increments qty of existing card', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false };
    addCardToDeck(deck, 'c1');
    assert.equal(deck.cards['c1'].qty, 3);
  });

  test('preserves foil status when incrementing', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: true };
    addCardToDeck(deck, 'c1');
    assert.equal(deck.cards['c1'].foil, true);
    assert.equal(deck.cards['c1'].qty, 2);
  });

  test('does not affect sideboard', () => {
    const deck = mkDeck();
    deck.sideboard['c1'] = { qty: 1, foil: false };
    addCardToDeck(deck, 'c1');
    assert.equal(deck.sideboard['c1'].qty, 1); // unchanged
    assert.equal(deck.cards['c1'].qty, 1);
  });

  test('can add multiple distinct cards independently', () => {
    const deck = mkDeck();
    addCardToDeck(deck, 'c1');
    addCardToDeck(deck, 'c2');
    addCardToDeck(deck, 'c1');
    assert.equal(deck.cards['c1'].qty, 2);
    assert.equal(deck.cards['c2'].qty, 1);
  });
});

describe('removeCardFromDeck', () => {
  test('decrements qty when qty > 1', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 3, foil: false };
    removeCardFromDeck(deck, 'c1');
    assert.equal(deck.cards['c1'].qty, 2);
  });

  test('deletes entry when qty reaches 0', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    removeCardFromDeck(deck, 'c1');
    assert.equal(deck.cards['c1'], undefined);
  });

  test('is a no-op for a card not in deck', () => {
    const deck = mkDeck();
    assert.doesNotThrow(() => removeCardFromDeck(deck, 'missing'));
  });

  test('preserves foil when decrementing', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: true };
    removeCardFromDeck(deck, 'c1');
    assert.equal(deck.cards['c1'].foil, true);
  });

  test('does not affect sideboard', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    deck.sideboard['c1'] = { qty: 2, foil: false };
    removeCardFromDeck(deck, 'c1');
    assert.equal(deck.sideboard['c1'].qty, 2); // unchanged
  });
});

describe('setCardQty', () => {
  test('sets qty to given value', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    setCardQty(deck, 'c1', 4);
    assert.equal(deck.cards['c1'].qty, 4);
  });

  test('removes entry when qty is 0', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false };
    setCardQty(deck, 'c1', 0);
    assert.equal(deck.cards['c1'], undefined);
  });

  test('removes entry for negative qty', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false };
    setCardQty(deck, 'c1', -1);
    assert.equal(deck.cards['c1'], undefined);
  });

  test('creates new entry if card not present', () => {
    const deck = mkDeck();
    setCardQty(deck, 'c1', 3);
    assert.deepEqual(deck.cards['c1'], { qty: 3, foil: false });
  });

  test('preserves foil status when changing qty', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: true };
    setCardQty(deck, 'c1', 3);
    assert.equal(deck.cards['c1'].foil, true);
  });

  test('accepts string qty values (from HTML inputs)', () => {
    const deck = mkDeck();
    setCardQty(deck, 'c1', '2');
    assert.equal(deck.cards['c1'].qty, 2);
  });
});

describe('toggleCardFoil', () => {
  test('sets foil from false to true', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    toggleCardFoil(deck, 'c1');
    assert.equal(deck.cards['c1'].foil, true);
  });

  test('sets foil from true to false', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: true };
    toggleCardFoil(deck, 'c1');
    assert.equal(deck.cards['c1'].foil, false);
  });

  test('preserves qty when toggling foil', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 3, foil: false };
    toggleCardFoil(deck, 'c1');
    assert.equal(deck.cards['c1'].qty, 3);
  });

  test('is a no-op for a card not in deck', () => {
    const deck = mkDeck();
    assert.doesNotThrow(() => toggleCardFoil(deck, 'missing'));
    assert.equal(deck.cards['missing'], undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Sideboard mutations
// ═══════════════════════════════════════════════════════════════════════════════

describe('addCardToSideboard', () => {
  test('adds a new sideboard card with qty 1', () => {
    const deck = mkDeck();
    addCardToSideboard(deck, 's1');
    assert.deepEqual(deck.sideboard['s1'], { qty: 1, foil: false });
  });

  test('increments sideboard qty of existing entry', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = { qty: 2, foil: false };
    addCardToSideboard(deck, 's1');
    assert.equal(deck.sideboard['s1'].qty, 3);
  });

  test('does not affect deck.cards', () => {
    const deck = mkDeck();
    deck.cards['s1'] = { qty: 1, foil: false };
    addCardToSideboard(deck, 's1');
    assert.equal(deck.cards['s1'].qty, 1); // unchanged
  });

  test('a card can exist simultaneously in deck and sideboard', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false };
    addCardToSideboard(deck, 'c1');
    assert.equal(deck.cards['c1'].qty, 2);
    assert.equal(deck.sideboard['c1'].qty, 1);
  });
});

describe('removeCardFromSideboard', () => {
  test('decrements qty when qty > 1', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = { qty: 3, foil: false };
    removeCardFromSideboard(deck, 's1');
    assert.equal(deck.sideboard['s1'].qty, 2);
  });

  test('deletes entry when qty reaches 0', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = { qty: 1, foil: false };
    removeCardFromSideboard(deck, 's1');
    assert.equal(deck.sideboard['s1'], undefined);
  });

  test('is a no-op for a card not in sideboard', () => {
    const deck = mkDeck();
    assert.doesNotThrow(() => removeCardFromSideboard(deck, 'missing'));
  });

  test('does not affect deck.cards', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false };
    deck.sideboard['c1'] = { qty: 1, foil: false };
    removeCardFromSideboard(deck, 'c1');
    assert.equal(deck.cards['c1'].qty, 2); // unchanged
    assert.equal(deck.sideboard['c1'], undefined);
  });
});

describe('setSideboardCardQty', () => {
  test('sets sideboard qty', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = { qty: 1, foil: false };
    setSideboardCardQty(deck, 's1', 3);
    assert.equal(deck.sideboard['s1'].qty, 3);
  });

  test('removes sideboard entry when qty is 0', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = { qty: 2, foil: false };
    setSideboardCardQty(deck, 's1', 0);
    assert.equal(deck.sideboard['s1'], undefined);
  });

  test('preserves foil when changing qty', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = { qty: 1, foil: true };
    setSideboardCardQty(deck, 's1', 2);
    assert.equal(deck.sideboard['s1'].foil, true);
  });
});

describe('toggleSideboardFoil', () => {
  test('toggles foil on', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = { qty: 1, foil: false };
    toggleSideboardFoil(deck, 's1');
    assert.equal(deck.sideboard['s1'].foil, true);
  });

  test('toggles foil off', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = { qty: 1, foil: true };
    toggleSideboardFoil(deck, 's1');
    assert.equal(deck.sideboard['s1'].foil, false);
  });

  test('preserves qty when toggling', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = { qty: 4, foil: false };
    toggleSideboardFoil(deck, 's1');
    assert.equal(deck.sideboard['s1'].qty, 4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Statistics
// ═══════════════════════════════════════════════════════════════════════════════

describe('deckTotalCards', () => {
  test('returns 0 for empty deck', () => {
    assert.equal(deckTotalCards(mkDeck()), 0);
  });

  test('sums all card quantities', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 3, foil: false };
    deck.cards['c2'] = { qty: 2, foil: true };
    assert.equal(deckTotalCards(deck), 5);
  });

  test('does not count sideboard cards', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false };
    deck.sideboard['s1'] = { qty: 5, foil: false };
    assert.equal(deckTotalCards(deck), 2);
  });

  test('handles legacy plain-number values', () => {
    const deck = mkDeck();
    deck.cards['c1'] = 4; // legacy format
    assert.equal(deckTotalCards(deck), 4);
  });

  test('single card with qty 1 returns 1', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    assert.equal(deckTotalCards(deck), 1);
  });

  test('correctly counts after add/remove cycle', () => {
    const deck = mkDeck();
    addCardToDeck(deck, 'c1');
    addCardToDeck(deck, 'c1');
    addCardToDeck(deck, 'c2');
    removeCardFromDeck(deck, 'c1');
    assert.equal(deckTotalCards(deck), 2);
  });
});

describe('sideboardTotalCards', () => {
  test('returns 0 for empty sideboard', () => {
    assert.equal(sideboardTotalCards(mkDeck()), 0);
  });

  test('sums sideboard quantities only', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = { qty: 3, foil: false };
    deck.sideboard['s2'] = { qty: 2, foil: true };
    deck.cards['c1'] = { qty: 10, foil: false };
    assert.equal(sideboardTotalCards(deck), 5);
  });

  test('works when sideboard key is absent', () => {
    const deck = { id: 'd', name: 'x', cards: { c1: { qty: 2, foil: false } } };
    assert.equal(sideboardTotalCards(deck), 0);
  });

  test('handles legacy plain-number sideboard values', () => {
    const deck = mkDeck();
    deck.sideboard['s1'] = 3;
    assert.equal(sideboardTotalCards(deck), 3);
  });
});

describe('deckUniqueCards', () => {
  test('returns 0 for empty deck', () => {
    assert.equal(deckUniqueCards(mkDeck()), 0);
  });

  test('counts distinct card IDs regardless of qty', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 4, foil: false };
    deck.cards['c2'] = { qty: 1, foil: false };
    assert.equal(deckUniqueCards(deck), 2);
  });

  test('does not count sideboard entries', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    deck.sideboard['c2'] = { qty: 1, foil: false };
    assert.equal(deckUniqueCards(deck), 1);
  });
});

describe('deckAvgCost', () => {
  test('returns null for empty deck', () => {
    assert.equal(deckAvgCost(mkDeck(), {}), null);
  });

  test('calculates weighted average correctly', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false }; // cost 2
    deck.cards['c2'] = { qty: 2, foil: false }; // cost 4
    const cardData = { c1: { cost: 2 }, c2: { cost: 4 } };
    // (2*2 + 4*2) / 4 = 3
    assert.equal(deckAvgCost(deck, cardData), 3);
  });

  test('excludes cards not in cardData from average', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    deck.cards['c2'] = { qty: 1, foil: false };
    // only c1 has data
    const cardData = { c1: { cost: 4 } };
    assert.equal(deckAvgCost(deck, cardData), 4);
  });

  test('includes cost-0 cards in the average', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false }; // cost 0
    deck.cards['c2'] = { qty: 1, foil: false }; // cost 4
    const cardData = { c1: { cost: 0 }, c2: { cost: 4 } };
    assert.equal(deckAvgCost(deck, cardData), 2);
  });

  test('sideboard cards do not affect average', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    deck.sideboard['s1'] = { qty: 1, foil: false };
    const cardData = { c1: { cost: 4 }, s1: { cost: 0 } };
    assert.equal(deckAvgCost(deck, cardData), 4);
  });
});

describe('deckInkCounts', () => {
  test('returns empty object for empty deck', () => {
    assert.deepEqual(deckInkCounts(mkDeck(), {}), {});
  });

  test('counts ink colours weighted by qty', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 3, foil: false };
    deck.cards['c2'] = { qty: 2, foil: false };
    const cardData = { c1: { ink: 'Amber' }, c2: { ink: 'Amber' } };
    assert.deepEqual(deckInkCounts(deck, cardData), { Amber: 5 });
  });

  test('handles multi-ink decks', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false };
    deck.cards['c2'] = { qty: 3, foil: false };
    const cardData = { c1: { ink: 'Amber' }, c2: { ink: 'Sapphire' } };
    assert.deepEqual(deckInkCounts(deck, cardData), { Amber: 2, Sapphire: 3 });
  });

  test('does not count sideboard cards in ink distribution', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    deck.sideboard['s1'] = { qty: 10, foil: false };
    const cardData = {
      c1: { ink: 'Ruby' },
      s1: { ink: 'Amethyst' },
    };
    assert.deepEqual(deckInkCounts(deck, cardData), { Ruby: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Export
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatDeckLine', () => {
  const cardData = {
    c1: { name: 'Mickey Mouse', version: 'Brave Little Tailor' },
    c2: { name: 'Elsa', version: null },
    c3: { name: 'Simba', version: 'Future King' },
  };

  test('formats basic entry without foil', () => {
    assert.equal(formatDeckLine('c1', { qty: 2, foil: false }, cardData), '2x Mickey Mouse - Brave Little Tailor');
  });

  test('appends (foil) annotation when foil is true', () => {
    assert.equal(formatDeckLine('c1', { qty: 1, foil: true }, cardData), '1x Mickey Mouse - Brave Little Tailor (foil)');
  });

  test('omits version separator when version is null', () => {
    assert.equal(formatDeckLine('c2', { qty: 3, foil: false }, cardData), '3x Elsa');
  });

  test('formats foil entry without version', () => {
    assert.equal(formatDeckLine('c2', { qty: 2, foil: true }, cardData), '2x Elsa (foil)');
  });

  test('returns empty string when card not in cardData', () => {
    assert.equal(formatDeckLine('unknown', { qty: 1, foil: false }, cardData), '');
  });

  test('handles legacy plain-number value', () => {
    assert.equal(formatDeckLine('c2', 3, cardData), '3x Elsa');
  });
});

describe('buildDeckText', () => {
  const cardData = {
    c1: { name: 'Mickey Mouse', version: 'Brave Little Tailor' },
    c2: { name: 'Elsa', version: null },
    s1: { name: 'Simba', version: 'Future King' },
  };

  test('produces plain list for main deck without sideboard', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false };
    deck.cards['c2'] = { qty: 1, foil: false };
    const txt = buildDeckText(deck, cardData);
    assert.ok(txt.includes('2x Mickey Mouse - Brave Little Tailor'));
    assert.ok(txt.includes('1x Elsa'));
    assert.ok(!txt.includes('Sideboard:'));
  });

  test('appends sideboard section when sideboard is non-empty', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false };
    deck.sideboard['s1'] = { qty: 1, foil: false };
    const txt = buildDeckText(deck, cardData);
    assert.ok(txt.includes('Sideboard:'));
    assert.ok(txt.includes('1x Simba - Future King'));
  });

  test('includes foil annotation in both sections', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: true };
    deck.sideboard['s1'] = { qty: 1, foil: true };
    const txt = buildDeckText(deck, cardData);
    const lines = txt.split('\n').filter(l => l.includes('(foil)'));
    assert.equal(lines.length, 2);
  });

  test('returns empty string for completely empty deck', () => {
    const deck = mkDeck();
    assert.equal(buildDeckText(deck, cardData), '');
  });

  test('sideboard section is separated by a blank line', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    deck.sideboard['s1'] = { qty: 1, foil: false };
    const txt = buildDeckText(deck, cardData);
    assert.ok(txt.includes('\n\nSideboard:\n'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Import parsing
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseDeckImportText', () => {
  test('parses a simple card name with qty', () => {
    const d = parseDeckImportText('4x Mickey Mouse - Brave Little Tailor');
    assert.equal(d.length, 1);
    assert.equal(d[0].qty, 4);
    assert.equal(d[0].name, 'Mickey Mouse');
    assert.equal(d[0].version, 'Brave Little Tailor');
    assert.equal(d[0].target, 'deck');
  });

  test('defaults qty to 1 when omitted', () => {
    const d = parseDeckImportText('Elsa');
    assert.equal(d[0].qty, 1);
    assert.equal(d[0].name, 'Elsa');
    assert.equal(d[0].version, null);
  });

  test('parses multiple lines', () => {
    const txt = '2x Elsa\n3x Mickey Mouse - Brave Little Tailor';
    const d = parseDeckImportText(txt);
    assert.equal(d.length, 2);
    assert.equal(d[0].name, 'Elsa');
    assert.equal(d[1].qty, 3);
  });

  test('routes lines after "Sideboard:" to sideboard target', () => {
    const txt = '2x Elsa\nSideboard:\n1x Mickey Mouse';
    const d = parseDeckImportText(txt);
    assert.equal(d[0].target, 'deck');
    assert.equal(d[1].target, 'sideboard');
  });

  test('sideboard header is case-insensitive', () => {
    const txt = '2x Elsa\nSIDEBOARD:\n1x Mickey Mouse';
    const d = parseDeckImportText(txt);
    assert.equal(d[1].target, 'sideboard');
  });

  test('sideboard header without colon also works', () => {
    const txt = '2x Elsa\nSideboard\n1x Mickey Mouse';
    const d = parseDeckImportText(txt);
    assert.equal(d[1].target, 'sideboard');
  });

  test('detects foil annotation in card name', () => {
    const d = parseDeckImportText('1x Elsa (foil)');
    assert.equal(d[0].foil, true);
    assert.equal(d[0].name, 'Elsa');
  });

  test('foil detection is case-insensitive', () => {
    const d = parseDeckImportText('1x Elsa (FOIL)');
    assert.equal(d[0].foil, true);
  });

  test('non-foil cards have foil=false', () => {
    const d = parseDeckImportText('1x Elsa');
    assert.equal(d[0].foil, false);
  });

  test('strips (foil) before parsing name/version', () => {
    const d = parseDeckImportText('2x Elsa - Spirit of Winter (foil)');
    assert.equal(d[0].name, 'Elsa');
    assert.equal(d[0].version, 'Spirit of Winter');
    assert.equal(d[0].foil, true);
  });

  test('accepts × (multiplication sign) as quantity delimiter', () => {
    const d = parseDeckImportText('3×Elsa');
    assert.equal(d[0].qty, 3);
    assert.equal(d[0].name, 'Elsa');
  });

  test('accepts X (uppercase) as quantity delimiter', () => {
    const d = parseDeckImportText('2XElsa');
    assert.equal(d[0].qty, 2);
  });

  test('ignores blank lines', () => {
    const d = parseDeckImportText('\n\n2x Elsa\n\n');
    assert.equal(d.length, 1);
  });

  test('sideboard header line does not produce a card directive', () => {
    const txt = '1x Elsa\nSideboard:\n1x Mickey Mouse';
    const d = parseDeckImportText(txt);
    assert.equal(d.length, 2); // header is not a directive
  });

  test('all directives before Sideboard: are target=deck', () => {
    const txt = '1x A\n2x B\nSideboard:\n3x C';
    const d = parseDeckImportText(txt);
    const deckOnes = d.filter(x => x.target === 'deck');
    const sbOnes = d.filter(x => x.target === 'sideboard');
    assert.equal(deckOnes.length, 2);
    assert.equal(sbOnes.length, 1);
    assert.equal(sbOnes[0].qty, 3);
  });

  test('round-trips through buildDeckText correctly', () => {
    const cardData = {
      c1: { name: 'Mickey Mouse', version: 'Brave Little Tailor' },
      c2: { name: 'Elsa', version: null },
      s1: { name: 'Simba', version: 'Future King' },
    };
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 2, foil: false };
    deck.cards['c2'] = { qty: 1, foil: true };
    deck.sideboard['s1'] = { qty: 1, foil: false };

    const exported = buildDeckText(deck, cardData);
    const parsed = parseDeckImportText(exported);

    const main = parsed.filter(d => d.target === 'deck');
    const sb = parsed.filter(d => d.target === 'sideboard');

    assert.equal(main.length, 2);
    assert.equal(sb.length, 1);

    // c2 was foil
    const elsaDir = main.find(d => d.name === 'Elsa');
    assert.ok(elsaDir);
    assert.equal(elsaDir.foil, true);

    assert.equal(sb[0].name, 'Simba');
    assert.equal(sb[0].version, 'Future King');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Filter helpers
// ═══════════════════════════════════════════════════════════════════════════════

describe('makeFilter', () => {
  test('returns a filter with all Sets empty by default', () => {
    const f = makeFilter();
    assert.equal(f.ink.size, 0);
    assert.equal(f.rarity.size, 0);
    assert.equal(f.keywords.size, 0);
  });

  test('cmin/cmax default to 0 and 10', () => {
    const f = makeFilter();
    assert.equal(f.cmin, 0);
    assert.equal(f.cmax, 10);
  });

  test('stat ranges default to null (inactive)', () => {
    const f = makeFilter();
    assert.equal(f.lmin, null);
    assert.equal(f.lmax, null);
    assert.equal(f.smin, null);
    assert.equal(f.smax, null);
    assert.equal(f.wmin, null);
    assert.equal(f.wmax, null);
  });

  test('accepts override values', () => {
    const f = makeFilter({ cmin: 2, cmax: 5, q: 'Elsa' });
    assert.equal(f.cmin, 2);
    assert.equal(f.cmax, 5);
    assert.equal(f.q, 'Elsa');
  });

  test('two makeFilter() calls produce independent Set instances', () => {
    const f1 = makeFilter();
    const f2 = makeFilter();
    f1.ink.add('Amber');
    assert.equal(f2.ink.size, 0);
  });
});

describe('isStatFilterActive', () => {
  test('lore is inactive when range is full (0–4)', () => {
    assert.equal(isStatFilterActive(0, 4, 'l'), false);
  });

  test('lore is active when range is narrowed', () => {
    assert.equal(isStatFilterActive(1, 3, 'l'), true);
    assert.equal(isStatFilterActive(2, 4, 'l'), true);
    assert.equal(isStatFilterActive(0, 2, 'l'), true);
  });

  test('strength is inactive when range is full (0–10)', () => {
    assert.equal(isStatFilterActive(0, 10, 's'), false);
  });

  test('strength is active when narrowed', () => {
    assert.equal(isStatFilterActive(2, 8, 's'), true);
  });

  test('willpower is inactive when full (0–10)', () => {
    assert.equal(isStatFilterActive(0, 10, 'w'), false);
  });

  test('single value range is always active', () => {
    assert.equal(isStatFilterActive(3, 3, 'l'), true);
    assert.equal(isStatFilterActive(5, 5, 's'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Rarity ranking
// ═══════════════════════════════════════════════════════════════════════════════

describe('rarityRank', () => {
  test('Iconic has the lowest rank (highest priority)', () => {
    assert.equal(rarityRank('Iconic'), 0);
  });

  test('Epic is second', () => {
    assert.equal(rarityRank('Epic'), 1);
  });

  test('Enchanted is third', () => {
    assert.equal(rarityRank('Enchanted'), 2);
  });

  test('Common has a higher rank than Rare', () => {
    assert.ok(rarityRank('Common') > rarityRank('Rare'));
  });

  test('Unknown rarity returns 99 (lowest priority)', () => {
    assert.equal(rarityRank('Unknown'), 99);
  });

  test('Ranking order is Iconic < Epic < Enchanted < Legendary < Super_rare < Rare < Uncommon < Common', () => {
    const order = ['Iconic','Epic','Enchanted','Legendary','Super_rare','Rare','Uncommon','Common'];
    for (let i = 0; i < order.length - 1; i++) {
      assert.ok(
        rarityRank(order[i]) < rarityRank(order[i+1]),
        `${order[i]} should rank above ${order[i+1]}`
      );
    }
  });
});

describe('highestRarity', () => {
  test('returns the rarest from a list', () => {
    assert.equal(highestRarity(['Common', 'Rare', 'Legendary']), 'Legendary');
  });

  test('returns Iconic over Enchanted', () => {
    assert.equal(highestRarity(['Enchanted', 'Iconic']), 'Iconic');
  });

  test('returns single element unchanged', () => {
    assert.equal(highestRarity(['Uncommon']), 'Uncommon');
  });

  test('handles duplicates gracefully', () => {
    assert.equal(highestRarity(['Common', 'Common', 'Rare']), 'Rare');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Deck filter IDs
// ═══════════════════════════════════════════════════════════════════════════════

describe('deckFilterIds', () => {
  test('returns null when mode is null (no filter)', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    assert.equal(deckFilterIds(deck, null), null);
  });

  test('mode=deck returns IDs from deck.cards', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    deck.cards['c2'] = { qty: 2, foil: false };
    deck.sideboard['s1'] = { qty: 1, foil: false };
    const ids = deckFilterIds(deck, 'deck');
    assert.deepEqual(ids, new Set(['c1', 'c2']));
  });

  test('mode=sideboard returns IDs from deck.sideboard', () => {
    const deck = mkDeck();
    deck.cards['c1'] = { qty: 1, foil: false };
    deck.sideboard['s1'] = { qty: 1, foil: false };
    const ids = deckFilterIds(deck, 'sideboard');
    assert.deepEqual(ids, new Set(['s1']));
  });

  test('returns empty Set when deck.cards is empty', () => {
    const deck = mkDeck();
    const ids = deckFilterIds(deck, 'deck');
    assert.equal(ids.size, 0);
  });

  test('returns empty Set when sideboard is empty', () => {
    const deck = mkDeck();
    const ids = deckFilterIds(deck, 'sideboard');
    assert.equal(ids.size, 0);
  });

  test('returns empty Set when sideboard key is absent', () => {
    const deck = { id: 'd', name: 'x', cards: {} };
    const ids = deckFilterIds(deck, 'sideboard');
    assert.equal(ids.size, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. DB integration (requires sql.js)
//
// Uses node:test's before() hook to initialise the database synchronously
// before any test runs. This avoids the async describe() race condition where
// db would be null when nested describe bodies execute.
// ═══════════════════════════════════════════════════════════════════════════════

describe('DB integration', () => {
  // db is set in before() and shared across all nested describes/tests.
  let db = null;

  before(async () => {
    db = await makeDb();

    if (!db) return; // tests will skip themselves when db is null

    // ── card_canonical seed data ──────────────────────────────────────────
    // Inserted once before any test runs.

    // Deduplication / MIN(id) tests
    insertCard(db, { id: 'uniq_a1',    name: 'Unique Card',        version: 'Alpha', set_code: '1', rarity: 'Common' });
    insertCard(db, { id: 'uniq_a2',    name: 'Unique Card',        version: 'Alpha', set_code: '2', rarity: 'Rare' });
    insertCard(db, { id: 'canon_aa',   name: 'Canon Test',         version: null,    set_code: '1', rarity: 'Common' });
    insertCard(db, { id: 'canon_bb',   name: 'Canon Test',         version: null,    set_code: '2', rarity: 'Rare' });
    insertCard(db, { id: 'ver_v1',     name: 'Versioned',          version: 'V1',    set_code: '1' });
    insertCard(db, { id: 'ver_v2',     name: 'Versioned',          version: 'V2',    set_code: '1' });
    insertCard(db, { id: 'apos_smart', name: 'A Pirate\u2019s Life', version: null,  set_code: '1' });
    insertCard(db, { id: 'apos_plain', name: "A Pirate's Life",    version: null,    set_code: '2' });

    // Filter query test cards (prefix 'filt_')
    insertCard(db, {
      id: 'filt_amber1', name: 'Amber Hero', version: null,
      ink: 'Amber', cost: 3, inkwell: 1, rarity: 'Common',
      types: '["Character"]', classes: '["Hero"]',
      lore: 2, str: 3, wil: 2, keywords: '["Rush"]', set_code: '1',
    });
    insertCard(db, {
      id: 'filt_amber2', name: 'Amber Villain', version: null,
      ink: 'Amber', cost: 5, inkwell: 0, rarity: 'Rare',
      types: '["Character"]', classes: '["Villain"]',
      lore: 3, str: 5, wil: 4, keywords: '["Evasive"]', set_code: '1',
    });
    insertCard(db, {
      id: 'filt_sap1', name: 'Sapphire Action', version: null,
      ink: 'Sapphire', cost: 2, inkwell: 1, rarity: 'Common',
      types: '["Action"]', classes: '[]',
      lore: null, str: null, wil: null, keywords: '[]', set_code: '2',
    });
    insertCard(db, {
      id: 'filt_leg1', name: 'Legendary Hero', version: null,
      ink: 'Ruby', cost: 7, inkwell: 1, rarity: 'Legendary',
      types: '["Character"]', classes: '["Hero"]',
      lore: 4, str: 8, wil: 6, keywords: '["Shift","Rush"]', set_code: '1',
    });

    // Rarity art selection test cards (prefix 'rarity_' / 'rarity2_')
    insertCard(db, { id: 'rarity_common',  name: 'Rarity Test Card',  version: null, rarity: 'Common',    set_code: '1' });
    insertCard(db, { id: 'rarity_rare',    name: 'Rarity Test Card',  version: null, rarity: 'Rare',      set_code: '2' });
    insertCard(db, { id: 'rarity_enc',     name: 'Rarity Test Card',  version: null, rarity: 'Enchanted', set_code: '3' });
    insertCard(db, { id: 'rarity2_common', name: 'Rarity Test Card2', version: null, rarity: 'Common',    set_code: '1' });
    insertCard(db, { id: 'rarity2_rare',   name: 'Rarity Test Card2', version: null, rarity: 'Rare',      set_code: '2' });
    insertCard(db, { id: 'rarity2_enc',    name: 'Rarity Test Card2', version: null, rarity: 'Enchanted', set_code: '3' });
  });

  // ── card_canonical view ──────────────────────────────────────────────────

  describe('card_canonical view', () => {
    test('SKIPPED – sql.js not available', (t) => {
      if (!db) t.skip('sql.js not installed');
    });

    test('deduplicates reprints of the same card', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const count = queryCount(db, `SELECT COUNT(*) FROM card_canonical WHERE name='Unique Card' AND version='Alpha'`);
      assert.equal(count, 1);
    });

    test('uses MIN(id) to pick the canonical row', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT id FROM card_canonical WHERE name='Canon Test'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'canon_aa'); // MIN('canon_aa','canon_bb')
    });

    test('treats cards with different versions as distinct', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const count = queryCount(db, `SELECT COUNT(*) FROM card_canonical WHERE name='Versioned'`);
      assert.equal(count, 2);
    });

    test('normalises Unicode apostrophes for deduplication', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const count = queryCount(db, `SELECT COUNT(*) FROM card_canonical WHERE name LIKE '%Pirate%'`);
      assert.equal(count, 1);
    });
  });

  // ── Basic filtering queries ───────────────────────────────────────────────

  describe('filter queries', () => {
    test('no filter returns all canonical cards', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const total = queryCount(db, 'SELECT COUNT(*) FROM card_canonical');
      assert.ok(total > 0);
    });

    test('ink filter returns only cards of that ink', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT ink FROM card_canonical WHERE name LIKE 'filt_%' AND ink='Amber'`);
      assert.ok(rows.length > 0);
      rows.forEach(r => assert.equal(r.ink, 'Amber'));
    });

    test('cost range filter excludes cards outside range', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `
        SELECT name, cost FROM card_canonical
        WHERE name LIKE 'filt_%' AND (cost >= 4 AND (cost <= 6 OR 6 >= 10))
      `);
      const names = rows.map(r => r.name);
      assert.ok(names.includes('Amber Villain'));      // cost 5 ✓
      assert.ok(!names.includes('Amber Hero'));        // cost 3 ✗
      assert.ok(!names.includes('Legendary Hero'));    // cost 7 ✗
    });

    test('cost max >= 10 means no upper bound', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `
        SELECT name FROM card_canonical
        WHERE name LIKE 'filt_%' AND (cost >= 0 AND (cost <= 10 OR 10 >= 10))
      `);
      assert.ok(rows.map(r => r.name).includes('Legendary Hero'));
    });

    test('inkwell filter works', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE 'filt_%' AND inkwell=0`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'Amber Villain');
    });

    test('type filter matches Character cards', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE 'filt_%' AND types LIKE '%"Character"%'`);
      const names = rows.map(r => r.name);
      assert.ok(names.includes('Amber Hero'));
      assert.ok(!names.includes('Sapphire Action'));
    });

    test('typeExact filter matches only pure Action cards', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `
        SELECT name FROM card_canonical
        WHERE name LIKE 'filt_%' AND json_array_length(types)=1 AND types LIKE '%"Action"%'
      `);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'Sapphire Action');
    });

    test('classification filter matches Hero cards', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE 'filt_%' AND classes LIKE '%"Hero"%'`);
      const names = rows.map(r => r.name);
      assert.ok(names.includes('Amber Hero'));
      assert.ok(names.includes('Legendary Hero'));
      assert.ok(!names.includes('Amber Villain'));
    });

    test('lore range filter excludes cards outside range', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE 'filt_%' AND lore >= 3 AND lore <= 4`);
      const names = rows.map(r => r.name);
      assert.ok(names.includes('Amber Villain'));   // lore 3
      assert.ok(names.includes('Legendary Hero'));  // lore 4
      assert.ok(!names.includes('Amber Hero'));     // lore 2
    });

    test('lore filter naturally excludes cards with NULL lore', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE 'filt_%' AND lore >= 1 AND lore <= 4`);
      assert.ok(!rows.map(r => r.name).includes('Sapphire Action')); // lore NULL
    });

    test('str (strength) range filter', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE 'filt_%' AND str >= 5 AND str <= 10`);
      const names = rows.map(r => r.name);
      assert.ok(names.includes('Amber Villain'));   // str 5
      assert.ok(names.includes('Legendary Hero'));  // str 8
      assert.ok(!names.includes('Amber Hero'));     // str 3
    });

    test('wil (willpower) range filter', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE 'filt_%' AND wil >= 4 AND wil <= 10`);
      const names = rows.map(r => r.name);
      assert.ok(names.includes('Amber Villain'));   // wil 4
      assert.ok(names.includes('Legendary Hero'));  // wil 6
      assert.ok(!names.includes('Amber Hero'));     // wil 2
    });

    test('keyword filter AND logic (both keywords required)', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `
        SELECT name FROM card_canonical
        WHERE name LIKE 'filt_%' AND keywords LIKE '%"Shift"%' AND keywords LIKE '%"Rush"%'
      `);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'Legendary Hero');
    });

    test('keyword filter with single keyword (Rush)', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE 'filt_%' AND keywords LIKE '%"Rush"%'`);
      const names = rows.map(r => r.name);
      assert.ok(names.includes('Amber Hero'));
      assert.ok(names.includes('Legendary Hero'));
      assert.ok(!names.includes('Amber Villain')); // only "Evasive"
    });

    test('set_code filter', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE 'filt_%' AND set_code IN ('2')`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'Sapphire Action');
    });

    test('text search (name LIKE)', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE '%Villain%'`);
      assert.ok(rows.some(r => r.name === 'Amber Villain'));
    });

    test('combined ink + rarity filter', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT name FROM card_canonical WHERE name LIKE 'filt_%' AND ink='Amber' AND rarity='Rare'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'Amber Villain');
    });
  });

  // ── Rarity art selection (buildFrom logic) ────────────────────────────────

  describe('rarity-based art selection', () => {
    const RARITY_RANK_SQL = `CASE rarity
      WHEN 'Iconic'     THEN 0 WHEN 'Epic'       THEN 1
      WHEN 'Enchanted'  THEN 2 WHEN 'Legendary'  THEN 3
      WHEN 'Super_rare' THEN 4 WHEN 'Rare'       THEN 5
      WHEN 'Uncommon'   THEN 6 ELSE 7 END`;

    test('when filtering by Enchanted, picks Enchanted row over Common/Rare', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `
        SELECT c.id, c.rarity FROM cards c
        WHERE c.name LIKE 'Rarity Test Card%'
          AND c.rarity IN ('Enchanted')
          AND c.id = (
            SELECT c2.id FROM cards c2
            WHERE c2.name = c.name AND COALESCE(c2.version,'')=COALESCE(c.version,'')
              AND c2.rarity IN ('Enchanted')
            ORDER BY ${RARITY_RANK_SQL.replace(/rarity/g, 'c2.rarity')}, c2.id
            LIMIT 1
          )
      `);
      assert.ok(rows.length > 0);
      rows.forEach(r => assert.equal(r.rarity, 'Enchanted'));
    });

    test('when filtering by Rare+Enchanted, picks Enchanted (higher priority)', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `
        SELECT c.id, c.rarity FROM cards c
        WHERE c.name = 'Rarity Test Card2'
          AND c.rarity IN ('Rare','Enchanted')
          AND c.id = (
            SELECT c2.id FROM cards c2
            WHERE c2.name = c.name AND COALESCE(c2.version,'')=COALESCE(c.version,'')
              AND c2.rarity IN ('Rare','Enchanted')
            ORDER BY ${RARITY_RANK_SQL.replace(/rarity/g, 'c2.rarity')}, c2.id
            LIMIT 1
          )
      `);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].rarity, 'Enchanted');
    });

    test('when filtering by Common only, returns Common row', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `
        SELECT c.rarity FROM cards c
        WHERE c.name = 'Rarity Test Card2'
          AND c.rarity IN ('Common')
          AND c.id = (
            SELECT c2.id FROM cards c2
            WHERE c2.name = c.name AND COALESCE(c2.version,'')=COALESCE(c.version,'')
              AND c2.rarity IN ('Common')
            ORDER BY ${RARITY_RANK_SQL.replace(/rarity/g, 'c2.rarity')}, c2.id
            LIMIT 1
          )
      `);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].rarity, 'Common');
    });

    test('no rarity filter uses card_canonical (earliest print by MIN id)', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const rows = queryRows(db, `SELECT id, rarity FROM card_canonical WHERE name='Rarity Test Card2'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'rarity2_common'); // MIN('rarity2_common','rarity2_enc','rarity2_rare')
    });
  });

  // ── ID-based deck/sideboard filter ───────────────────────────────────────

  describe('dDeckFilter id-based restriction', () => {
    test('restricting to specific IDs returns only those cards', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const ids = ['filt_amber1', 'filt_sap1'];
      const rows = queryRows(db, `SELECT id FROM card_canonical WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);
      const returnedIds = new Set(rows.map(r => r.id));
      assert.ok(returnedIds.has('filt_amber1'));
      assert.ok(returnedIds.has('filt_sap1'));
      assert.ok(!returnedIds.has('filt_amber2'));
      assert.ok(!returnedIds.has('filt_leg1'));
    });

    test('empty ID list returns no results', (t) => {
      if (!db) return t.skip('sql.js not installed');
      const count = queryCount(db, `SELECT COUNT(*) FROM card_canonical WHERE 1=0`);
      assert.equal(count, 0);
    });
  });
});

console.log('\n✓ Test file loaded — running with: node --test lorcana.test.js\n');
