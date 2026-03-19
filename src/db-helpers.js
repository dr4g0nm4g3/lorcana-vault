// db-helpers.js  –  Spin up an in-memory SQLite database with the same
// schema as lorcana-browser.html so that query-logic integration tests
// can run without a browser or network.
//
// Requires the `sql.js` package built as a CommonJS module.
// If the package is unavailable (network-restricted CI), tests that import
// this file are skipped gracefully via the exported `skipIfNoSqlJs` helper.

let SQL = null;

async function getSqlJs() {
  if (SQL) return SQL;
  try {
    // sql.js ships its own WASM binary; point it at the local node_modules copy
    const initSqlJs = require('sql.js');
    SQL = await initSqlJs();
  } catch {
    SQL = null;
  }
  return SQL;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards(
  id TEXT PRIMARY KEY, name TEXT, version TEXT, layout TEXT, released_at TEXT,
  img_s TEXT, img_n TEXT, img_l TEXT, cost INTEGER, inkwell INTEGER, ink TEXT,
  types TEXT, classes TEXT, ctxt TEXT, move_cost INTEGER, str INTEGER, wil INTEGER,
  lore INTEGER, rarity TEXT, ills TEXT, cnum TEXT, flavor TEXT, set_code TEXT,
  set_name TEXT, keywords TEXT, price_usd TEXT
);
DROP VIEW IF EXISTS card_canonical;
CREATE VIEW card_canonical AS
  SELECT c.* FROM cards c
  INNER JOIN (
    SELECT MIN(id) AS canon_id FROM cards
    GROUP BY
      REPLACE(REPLACE(REPLACE(name, char(8217), char(39)), char(8216), char(39)), char(700), char(39)),
      COALESCE(version,'')
  ) best ON c.id = best.canon_id;
`;

/**
 * Create and return an in-memory sql.js Database pre-loaded with the Lorcana
 * schema.  Returns null when sql.js is not available.
 */
async function makeDb() {
  const S = await getSqlJs();
  if (!S) return null;
  const db = new S.Database();
  db.run(SCHEMA);
  return db;
}

/**
 * Insert a card row.  All fields are optional; sensible defaults are applied.
 */
function insertCard(db, card) {
  const c = {
    id: 'card_' + Math.random().toString(36).slice(2),
    name: 'Test Card',
    version: null,
    layout: null,
    released_at: null,
    img_s: null, img_n: null, img_l: null,
    cost: null,
    inkwell: 0,
    ink: null,
    types: '[]',
    classes: '[]',
    ctxt: null,
    move_cost: null,
    str: null,
    wil: null,
    lore: null,
    rarity: 'Common',
    ills: '[]',
    cnum: null,
    flavor: null,
    set_code: '1',
    set_name: 'Test Set',
    keywords: '[]',
    price_usd: null,
    ...card,
  };

  db.run(
    `INSERT OR REPLACE INTO cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      c.id, c.name, c.version, c.layout, c.released_at,
      c.img_s, c.img_n, c.img_l, c.cost, c.inkwell ? 1 : 0, c.ink,
      typeof c.types === 'string' ? c.types : JSON.stringify(c.types),
      typeof c.classes === 'string' ? c.classes : JSON.stringify(c.classes),
      c.ctxt, c.move_cost, c.str, c.wil, c.lore, c.rarity,
      typeof c.ills === 'string' ? c.ills : JSON.stringify(c.ills),
      c.cnum, c.flavor, c.set_code, c.set_name,
      typeof c.keywords === 'string' ? c.keywords : JSON.stringify(c.keywords),
      c.price_usd,
    ]
  );
  return c.id;
}

/**
 * Run a COUNT(*) query and return the integer result.
 */
function queryCount(db, sql, params = []) {
  const r = db.exec(sql, params);
  return r[0]?.values[0][0] ?? 0;
}

/**
 * Run a SELECT and return an array of plain objects.
 */
function queryRows(db, sql, params = []) {
  const r = db.exec(sql, params);
  if (!r[0]) return [];
  const { columns, values } = r[0];
  return values.map(row => {
    const o = {};
    columns.forEach((col, i) => (o[col] = row[i]));
    return o;
  });
}

module.exports = { makeDb, insertCard, queryCount, queryRows };
