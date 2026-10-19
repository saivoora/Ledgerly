# Ledgerly — Personal Finance Dashboard

A zero-maintenance, local-first personal finance tracker. No cloud, no accounts, no subscriptions, no tracking. Your data lives in a SQLite file on your machine.

## Run it

```bash
node server.js
```

Then open http://127.0.0.1:8788 in your browser. That's it.

Requirements: **Node.js ≥ 22** (uses the built-in `node:sqlite` — no npm packages needed).

## Features

- **Dashboard** — income vs expenses, net cash flow, 6-month trend chart, top spending categories, recent transactions
- **Transactions** — add/edit/delete, search, filter by type/category/date range, paginated
- **Import** — paste CSV (`date, merchant, amount`) or a JSON array; duplicates are detected and skipped automatically
- **Subscriptions** — automatic detection of recurring charges (Netflix, rent, insurance…) with confidence scores, next-charge dates, and monthly/annual burn totals; ignore patterns you don't care about
- **Auto-rules** — "when merchant contains X, set category to Y" rules that categorize new transactions on arrival
- **Goals & budgets** — savings goals with progress bars, monthly per-category budgets with spend tracking, net-worth tracker
- **Settings** — custom categories and accounts, one-click JSON export, full data reset

## Architecture

```
server.js   — Node http server: routes /api/* to the API, everything else to public/
api.js      — REST API (transactions, rules, tags, documents, detection, settings)
db.js       — SQLite persistence via node:sqlite (D1-compatible wrapper)
detect.js   — recurring/subscription detection engine (pure functions)
public/     — self-contained frontend: index.html + styles.css + app.js
              Vanilla JS/CSS only. No frameworks, no CDNs, no build step.
```

Data is stored in `./data/db/ledgerly.sqlite3` (WAL mode). Override with `LEDGERLY_DB=/path/to/file.db`.

## Zero-maintenance design

- **Zero npm dependencies** — pure Node.js standard library
- **Zero external services** — no CDNs, no fonts, no analytics, no auth servers; works fully offline (after first load)
- **Zero build step** — edit the HTML/CSS/JS and refresh the browser
- **Single command** — `node server.js`, nothing else to configure or babysit

## API quick reference

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | Full app state (settings, recent, summary) |
| GET/POST | `/api/transactions` | List (filters: q, type, category, from, to, tag) / create |
| GET/PUT/DELETE | `/api/transactions/:id` | Read / update / delete one |
| POST | `/api/transactions/import` | Bulk import (array or `{transactions: [...]}`) |
| GET/POST | `/api/rules` | List / create auto-categorization rules |
| PUT/DELETE | `/api/rules/:id` | Update / delete a rule |
| GET | `/api/detect/recurring` | Recurring-charge suggestions |
| POST | `/api/detect/dismiss` | Ignore a recurring pattern (`{key}`) |
| GET | `/api/summary` | Dashboard aggregates |
| PUT | `/api/settings` | Bulk settings update (goals, budgets, categories…) |
| POST | `/api/reset` | Wipe all data (two-confirm in UI) |
