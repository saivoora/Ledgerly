// db.js — D1-equivalent persistence layer.
//
// In production this would be Cloudflare D1 bound as `DB`. Locally we use
// node:sqlite (Node >= 22), which mirrors D1's SQL semantics closely enough
// for the whole app. The wrapper exposes a small D1-like API so the route
// modules stay portable: .prepare(sql).bind(...).all()/get()/run().

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.LEDGERLY_DB || './data/db/ledgerly.sqlite3';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// --- Schema (idempotent). Mirrors spec §4.1 exactly. ---
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    merchant TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Needs review',
    amount REAL NOT NULL,
    type TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT 'Imported account',
    tags TEXT NOT NULL DEFAULT '[]',
    receipt INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tags (
    name TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    whenText TEXT NOT NULL,
    thenText TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    size INTEGER NOT NULL,
    objectKey TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

for (const stmt of SCHEMA) db.exec(stmt);

// --- Settings helpers (the `settings` table is the D1 key/value store). ---

const DEFAULT_SETTINGS = {
  // Lookup configuration only — NOT financial records.
  categories: [
    'Housing', 'Groceries', 'Shopping', 'Dining', 'Transportation',
    'Utilities', 'Subscriptions', 'Insurance', 'Health', 'Entertainment',
    'Income', 'Needs review', 'Other',
  ],
  accounts: ['Main Checking', 'Everyday Visa', 'Rewards Card', 'Cash'],
  // Empty-start contract: all financial datasets begin empty.
  goals: [],
  budgets: [],
  subscriptions: [],
  recurring: [],
  dismissedPatterns: [],
  rules: [], // also stored in `rules` table, but mirrored here for the state payload
  assetsTotal: 0,
  liabilitiesTotal: 0,
  netWorthConfigured: false,
  selectedPeriod: 'all-time',
  driveFolder: { name: 'Ledgerly Financial Inbox', url: '', id: '' },
  driveSync: {
    schedule: { time: '08:00', timezone: '', cadence: 'daily' },
    lastSyncedAt: null,
    status: 'never',
    lastImported: 0,
    lastDuplicate: 0,
    lastFilesStored: 0,
    lastReview: 0,
    lastErrors: [],
  },
  processedFileIds: [],
  driveResetAt: null,
  freshStart: true,
};

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value; // scalar text fallback (e.g. selectedPeriod)
  }
}

export function setSetting(key, value) {
  // Serialize to JSON; getSetting unpacks the value. Scalars are stored wrapped in quotes.
  const v = JSON.stringify(value);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt'
  ).run(key, v, now);
}

export function setManySettings(obj) {
  for (const [k, v] of Object.entries(obj || {})) setSetting(k, v);
}

export function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const { key, value } of rows) {
    try { out[key] = JSON.parse(value); } catch { out[key] = value; }
  }
  return out;
}

// --- Idempotent config seeding. Only run once and only if unseeded. ---
function seedIfEmpty() {
  const seeded = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('seeded');
  if (seeded) return;
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    setSetting(key, value);
  }
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('seeded', '1');
}

// Re-assert the empty-start configuration if a wipe deleted settings but left schema_meta.
export function ensureEmptyStartSettings() {
  const hasCategories = db.prepare('SELECT key FROM settings WHERE key = ?').get('categories');
  if (!hasCategories) {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) setSetting(key, value);
  }
}

seedIfEmpty();

export function uuid() {
  return randomUUID();
}
