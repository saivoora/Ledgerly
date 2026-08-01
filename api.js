// api.js — HTTP API routing layer for Ledgerly.
//
// Exports `handleApi(req, res, url)`, which `server.js` calls for any request
// whose pathname starts with `/api/`. All routing logic lives here and is
// expressed purely in terms of the standard Node http request/response objects
// plus `db.js` (persistence) and `detect.js` (recurring/subscription engine).
//
// The module is portable: it never touches the network listener or the static
// file layer, so it can be reused under Cloudflare Pages (D1/R2 bindings) by
// swapping the db.js internals.

import { createHash } from 'node:crypto';

import {
  db,
  getSetting,
  setSetting,
  setManySettings,
  getAllSettings,
  ensureEmptyStartSettings,
  uuid,
} from './db.js';
import { detectRecurring } from './detect.js';

// Re-assert the empty-start config at module load (idempotent / cheap).
ensureEmptyStartSettings();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json;charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const MAX = 25 * 1024 * 1024; // 25MB cap protects the local server.
    let buf = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      buf += chunk;
    });
    req.on('end', () => {
      if (!buf) return resolve(null);
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Route matcher: pattern '/api/transactions/:id' against a pathname.
// Returns an object of {param: value} on match, or null.
function match(pattern, pathname) {
  const pp = pattern.split('/').filter(Boolean);
  const ap = pathname.split('/').filter(Boolean);
  if (pp.length !== ap.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) {
      try {
        params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
      } catch {
        params[pp[i].slice(1)] = ap[i];
      }
    } else if (pp[i] !== ap[i]) {
      return null;
    }
  }
  return params;
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseTagsArr(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// --- Row mappers (DB shape -> API shape) ------------------------------------

function asTxn(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    merchant: row.merchant,
    category: row.category,
    amount: Number(row.amount),
    type: row.type,
    account: row.account,
    tags: parseTagsArr(row.tags),
    receipt: !!row.receipt,
    source: row.source,
    createdAt: row.createdAt,
  };
}

function asRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    whenText: row.whenText,
    thenText: row.thenText,
    enabled: !!row.enabled,
    createdAt: row.createdAt,
  };
}

function asTag(row) {
  if (!row) return null;
  return { name: row.name, createdAt: row.createdAt };
}

function asDoc(row) {
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    objectKey: row.objectKey,
    status: row.status,
    source: row.source,
    createdAt: row.createdAt,
  };
}

// --- Source-of-truth list helpers (Table reads, not the settings mirror) -----

function listRules() {
  return db.prepare('SELECT * FROM rules ORDER BY createdAt ASC').all().map(asRule);
}

function listTags() {
  return db.prepare('SELECT * FROM tags ORDER BY name ASC').all().map(asTag);
}

function listDocuments() {
  return db.prepare('SELECT * FROM documents ORDER BY createdAt DESC').all().map(asDoc);
}

// Keep `settings.rules` mirror in sync with the rules table so code that reads
// settings.rules never drifts from the table (the canonical store).
function syncRulesSetting() {
  setSetting('rules', listRules());
}

// --- Domain helpers ----------------------------------------------------------

// Deterministic duplicate key — spec demands fingerprint uniqueness so an
// import run is idempotent. We hash the natural identity of a transaction.
function makeFingerprint(t) {
  const base = [
    t.date || '',
    String(t.merchant || '').toLowerCase().trim(),
    Number(t.amount || 0),
    t.account || '',
  ].join('|');
  return createHash('sha256').update(base).digest('hex');
}

// Apply user rules to auto-categorize "Needs review" rows on write (spec §8).
function applyRulesToTxn(txn, rules) {
  if (txn.category && txn.category !== 'Needs review') return txn.category;
  const m = String(txn.merchant || '').toLowerCase();
  for (const r of rules) {
    if (!r.enabled) continue;
    const w = String(r.whenText || '').toLowerCase();
    if (w && m.includes(w)) return r.thenText || 'Needs review';
  }
  return txn.category || 'Needs review';
}

function insertTransaction(t, rules) {
  if (!t.date || !t.merchant || t.amount === undefined || t.amount === null) {
    throw new Error('Missing required field: date, merchant, or amount');
  }
  const amount = Number(t.amount);
  if (!Number.isFinite(amount)) throw new Error('amount must be a finite number');

  const id = uuid();
  const createdAt = new Date().toISOString();
  const tags = Array.isArray(t.tags) ? t.tags.map(String) : [];
  const category = applyRulesToTxn(t, rules) || 'Needs review';
  const type = t.type || 'expense';
  const account = t.account || 'Imported account';
  const source = t.source || 'manual';
  const receipt = t.receipt ? 1 : 0;
  const fp = makeFingerprint({ date: t.date, merchant: t.merchant, amount, account });

  db.prepare(
    'INSERT INTO transactions ' +
      '(id, date, merchant, category, amount, type, account, tags, receipt, source, fingerprint, createdAt) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, t.date, String(t.merchant), category, amount, type, account, JSON.stringify(tags), receipt, source, fp, createdAt);

  for (const tg of tags) {
    db.prepare('INSERT OR IGNORE INTO tags (name, createdAt) VALUES (?, ?)').run(tg, createdAt);
  }
  return asTxn(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
}

// Dashboard summary computed from a list of API-shape transactions.
function computeSummary(rows) {
  let income = 0;
  let expenses = 0;
  const byCat = new Map();
  const byMonth = new Map();

  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    const isIncome = r.type === 'income';
    if (isIncome) income += amt;
    else expenses += amt;

    const cat = r.category || 'Needs review';
    const c = byCat.get(cat) || { total: 0, count: 0 };
    if (!isIncome) c.total += amt;
    c.count += 1;
    byCat.set(cat, c);

    const month = String(r.date || '').slice(0, 7) || 'unknown';
    const m = byMonth.get(month) || { income: 0, expenses: 0 };
    if (isIncome) m.income += amt;
    else m.expenses += amt;
    byMonth.set(month, m);
  }

  return {
    totals: { income: round(income), expenses: round(expenses), net: round(income - expenses) },
    byCategory: [...byCat.entries()]
      .map(([category, v]) => ({ category, total: round(v.total), count: v.count }))
      .sort((a, b) => b.total - a.total),
    byMonth: [...byMonth.entries()]
      .map(([month, v]) => ({
        month,
        income: round(v.income),
        expenses: round(v.expenses),
        net: round(v.income - v.expenses),
      }))
      .sort((a, b) => (a.month < b.month ? -1 : 1)),
    transactionCount: rows.length,
  };
}

function isUniqueViolation(err) {
  return /UNIQUE/i.test(String(err && err.message ? err.message : err));
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

export async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // CORS preflight — allow all so the API can be exercised from dev tooling.
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    // ----- Transactions ----------------------------------------------------

    if (pathname === '/api/transactions' && method === 'GET') {
      const { category, type, from, to, q, tag } = Object.fromEntries(url.searchParams);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 1000, 10000);
      const offset = Number(url.searchParams.get('offset')) || 0;

      const where = [];
      const params = [];
      if (category) { where.push('category = ?'); params.push(category); }
      if (type) { where.push('type = ?'); params.push(type); }
      if (from) { where.push('date >= ?'); params.push(from); }
      if (to) { where.push('date <= ?'); params.push(to); }
      if (q) { where.push('LOWER(merchant) LIKE ?'); params.push('%' + String(q).toLowerCase() + '%'); }
      if (tag) { where.push("tags LIKE ?"); params.push('%"' + String(tag).replace(/"/g, '') + '"%'); }

      let sql = 'SELECT * FROM transactions';
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY date DESC, createdAt DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params).map(asTxn);
      return json(res, 200, { transactions: rows, limit, offset });
    }

    if (pathname === '/api/transactions' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body) return json(res, 400, { error: 'Request body required' });
      const rules = listRules();
      try {
        const created = insertTransaction(body, rules);
        return json(res, 201, created);
      } catch (e) {
        if (isUniqueViolation(e)) {
          return json(res, 409, { error: 'Duplicate transaction', fingerprint: makeFingerprint(body) });
        }
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    if (pathname === '/api/transactions' && method === 'DELETE') {
      const info = db.prepare('DELETE FROM transactions').run();
      return json(res, 200, { deleted: info.changes });
    }

    // Bulk import must be matched before the /:id route.
    if (pathname === '/api/transactions/import' && method === 'POST') {
      const body = await readJsonBody(req);
      const arr = Array.isArray(body)
        ? body
        : body && Array.isArray(body.transactions)
          ? body.transactions
          : null;
      if (!arr) return json(res, 400, { error: 'Expected an array of transactions' });

      const rules = listRules();
      let imported = 0;
      let duplicates = 0;
      const errors = [];
      for (const t of arr) {
        try {
          insertTransaction(t, rules);
          imported++;
        } catch (e) {
          if (isUniqueViolation(e)) duplicates++;
          else errors.push({ row: t, error: String(e.message || e) });
        }
      }
      return json(res, 200, { imported, duplicates, errors });
    }

    {
      const p = match('/api/transactions/:id', pathname);
      if (p) {
        if (method === 'GET') {
          const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(p.id);
          if (!row) return json(res, 404, { error: 'Transaction not found' });
          return json(res, 200, asTxn(row));
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          if (!body) return json(res, 400, { error: 'Request body required' });
          const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(p.id);
          if (!row) return json(res, 404, { error: 'Transaction not found' });

          const date = body.date !== undefined ? body.date : row.date;
          const merchant = body.merchant !== undefined ? String(body.merchant) : row.merchant;
          const amount = body.amount !== undefined ? Number(body.amount) : Number(row.amount);
          const account = body.account !== undefined ? body.account : row.account;
          const category = body.category !== undefined ? body.category : row.category;
          const type = body.type !== undefined ? body.type : row.type;
          const tags = Array.isArray(body.tags) ? body.tags.map(String) : parseTagsArr(row.tags);
          const receipt = body.receipt !== undefined ? (body.receipt ? 1 : 0) : row.receipt;
          const source = body.source !== undefined ? body.source : row.source;
          const fp = makeFingerprint({ date, merchant, amount, account });

          try {
            db.prepare(
              'UPDATE transactions SET date=?, merchant=?, category=?, amount=?, type=?, ' +
                'account=?, tags=?, receipt=?, source=?, fingerprint=? WHERE id=?'
            ).run(date, merchant, category, amount, type, account, JSON.stringify(tags), receipt, source, fp, p.id);
          } catch (e) {
            if (isUniqueViolation(e)) {
              return json(res, 409, { error: 'Edit would duplicate an existing transaction' });
            }
            throw e;
          }
          for (const tg of tags) {
            db.prepare('INSERT OR IGNORE INTO tags (name, createdAt) VALUES (?, ?)').run(tg, new Date().toISOString());
          }
          return json(res, 200, asTxn(db.prepare('SELECT * FROM transactions WHERE id = ?').get(p.id)));
        }
        if (method === 'DELETE') {
          const info = db.prepare('DELETE FROM transactions WHERE id = ?').run(p.id);
          if (info.changes === 0) return json(res, 404, { error: 'Transaction not found' });
          return json(res, 200, { deleted: 1 });
        }
      }
    }

    // ----- Tags ------------------------------------------------------------

    if (pathname === '/api/tags' && method === 'GET') {
      return json(res, 200, { tags: listTags() });
    }

    if (pathname === '/api/tags' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || !body.name) return json(res, 400, { error: 'name is required' });
      const name = String(body.name).trim();
      if (!name) return json(res, 400, { error: 'name cannot be empty' });
      db.prepare('INSERT OR IGNORE INTO tags (name, createdAt) VALUES (?, ?)').run(name, new Date().toISOString());
      return json(res, 201, asTag(db.prepare('SELECT * FROM tags WHERE name = ?').get(name)));
    }

    {
      const p = match('/api/tags/:name', pathname);
      if (p && method === 'DELETE') {
        const name = p.name;
        const info = db.prepare('DELETE FROM tags WHERE name = ?').run(name);
        if (info.changes === 0) return json(res, 404, { error: 'Tag not found' });
        // Best-effort: strip the deleted tag from any transactions that carry it.
        const rows = db.prepare('SELECT id, tags FROM transactions').all();
        for (const row of rows) {
          const arr = parseTagsArr(row.tags);
          if (arr.includes(name)) {
            const next = arr.filter((t) => t !== name);
            db.prepare('UPDATE transactions SET tags = ? WHERE id = ?').run(JSON.stringify(next), row.id);
          }
        }
        return json(res, 200, { deleted: 1 });
      }
    }

    // ----- Rules -----------------------------------------------------------

    if (pathname === '/api/rules' && method === 'GET') {
      return json(res, 200, { rules: listRules() });
    }

    if (pathname === '/api/rules' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || !body.whenText || !body.thenText) {
        return json(res, 400, { error: 'whenText and thenText are required' });
      }
      const id = uuid();
      const createdAt = new Date().toISOString();
      const enabled = body.enabled === false ? 0 : 1;
      db.prepare(
        'INSERT INTO rules (id, whenText, thenText, enabled, createdAt) VALUES (?,?,?,?,?)'
      ).run(id, String(body.whenText), String(body.thenText), enabled, createdAt);
      syncRulesSetting();
      return json(res, 201, asRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(id)));
    }

    {
      const p = match('/api/rules/:id', pathname);
      if (p) {
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          if (!body) return json(res, 400, { error: 'Request body required' });
          const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(p.id);
          if (!row) return json(res, 404, { error: 'Rule not found' });
          const whenText = body.whenText !== undefined ? String(body.whenText) : row.whenText;
          const thenText = body.thenText !== undefined ? String(body.thenText) : row.thenText;
          const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : row.enabled;
          db.prepare('UPDATE rules SET whenText=?, thenText=?, enabled=? WHERE id=?').run(
            whenText, thenText, enabled, p.id
          );
          syncRulesSetting();
          return json(res, 200, asRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(p.id)));
        }
        if (method === 'DELETE') {
          const info = db.prepare('DELETE FROM rules WHERE id = ?').run(p.id);
          if (info.changes === 0) return json(res, 404, { error: 'Rule not found' });
          syncRulesSetting();
          return json(res, 200, { deleted: 1 });
        }
      }
    }

    // ----- Documents (R2 receipt metadata — bytes stored externally) -------

    if (pathname === '/api/documents' && method === 'GET') {
      return json(res, 200, { documents: listDocuments() });
    }

    if (pathname === '/api/documents' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || !body.filename || !body.objectKey) {
        return json(res, 400, { error: 'filename and objectKey are required' });
      }
      const id = uuid();
      const createdAt = new Date().toISOString();
      try {
        db.prepare(
          'INSERT INTO documents (id, filename, mimeType, size, objectKey, status, source, createdAt) ' +
            'VALUES (?,?,?,?,?,?,?,?)'
        ).run(
          id,
          String(body.filename),
          body.mimeType || 'application/octet-stream',
          Number(body.size) || 0,
          String(body.objectKey),
          body.status || 'pending',
          body.source || 'manual',
          createdAt
        );
      } catch (e) {
        if (isUniqueViolation(e)) {
          return json(res, 409, { error: 'A document with that objectKey already exists' });
        }
        throw e;
      }
      return json(res, 201, asDoc(db.prepare('SELECT * FROM documents WHERE id = ?').get(id)));
    }

    {
      const p = match('/api/documents/:id', pathname);
      if (p && method === 'DELETE') {
        const info = db.prepare('DELETE FROM documents WHERE id = ?').run(p.id);
        if (info.changes === 0) return json(res, 404, { error: 'Document not found' });
        return json(res, 200, { deleted: 1 });
      }
    }

    // ----- Detection engine -----------------------------------------------

    if (pathname === '/api/detect/recurring' && method === 'GET') {
      let rows = db.prepare("SELECT * FROM transactions WHERE type = 'expense'").all();
      if (!rows.length) rows = db.prepare('SELECT * FROM transactions').all();
      const expenses = rows.map((r) => ({
        id: r.id,
        date: r.date,
        merchant: r.merchant,
        category: r.category,
        tags: parseTagsArr(r.tags),
        amount: Number(r.amount),
      }));
      const dismissed = getSetting('dismissedPatterns', []) || [];
      const suggestions = detectRecurring(expenses, dismissed);
      return json(res, 200, { suggestions });
    }

    if (pathname === '/api/detect/dismiss' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || !body.key) return json(res, 400, { error: 'key is required' });
      const arr = getSetting('dismissedPatterns', []) || [];
      if (!arr.includes(body.key)) arr.push(body.key);
      setSetting('dismissedPatterns', arr);
      return json(res, 200, { dismissedPatterns: arr });
    }

    // ----- Dashboard summary ----------------------------------------------

    if (pathname === '/api/summary' && method === 'GET') {
      const rows = db.prepare('SELECT * FROM transactions').all().map(asTxn);
      return json(res, 200, computeSummary(rows));
    }

    // ----- Settings & full app state -------------------------------------

    if (pathname === '/api/state' && method === 'GET') {
      const settings = getAllSettings();
      const rules = listRules();
      const tags = listTags();
      const documents = listDocuments();
      const recentRows = db.prepare('SELECT * FROM transactions ORDER BY date DESC, createdAt DESC LIMIT 5').all().map(asTxn);
      const allRows = db.prepare('SELECT * FROM transactions').all().map(asTxn);

      // `settings.rules` mirrors the table; prefer the live table value.
      settings.rules = rules;
      return json(res, 200, {
        settings,
        tags,
        rules,
        documents,
        counts: {
          transactions: allRows.length,
          tags: tags.length,
          rules: rules.length,
          documents: documents.length,
        },
        recent: recentRows,
        summary: computeSummary(allRows),
      });
    }

    if (pathname === '/api/settings' && method === 'PUT') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json(res, 400, { error: 'Expected a JSON object of key/value settings' });
      }
      setManySettings(body);
      return json(res, 200, { ok: true, settings: getAllSettings() });
    }

    {
      const p = match('/api/settings/:key', pathname);
      if (p && method === 'PUT') {
        const body = await readJsonBody(req);
        if (!body || body.value === undefined) {
          return json(res, 400, { error: 'Body must include a "value" field' });
        }
        setSetting(p.key, body.value);
        return json(res, 200, { ok: true, key: p.key, value: getSetting(p.key) });
      }
    }

    // ----- Fresh start / reset --------------------------------------------

    if (pathname === '/api/reset' && method === 'POST') {
      db.prepare('DELETE FROM transactions').run();
      db.prepare('DELETE FROM documents').run();
      db.prepare('DELETE FROM tags').run();
      db.prepare('DELETE FROM rules').run();
      setManySettings({
        goals: [],
        budgets: [],
        subscriptions: [],
        recurring: [],
        dismissedPatterns: [],
        rules: [],
        assetsTotal: 0,
        liabilitiesTotal: 0,
        netWorthConfigured: false,
        selectedPeriod: 'all-time',
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
        driveResetAt: new Date().toISOString(),
        freshStart: true,
      });
      ensureEmptyStartSettings();
      return json(res, 200, { ok: true });
    }

    // ----- Fallback --------------------------------------------------------

    return json(res, 404, { error: 'Not found', path: pathname, method });
  } catch (e) {
    return json(res, 500, { error: 'Server error', message: String(e.message || e) });
  }
}
