/* Ledgerly app.js — zero-dependency vanilla JS. Talks to the local /api/* backend. */
'use strict';

const state = {
  settings: { categories: [], accounts: [], goals: [], budgets: [] },
  transactions: [],
  rules: [],
  tags: [],
  recurring: [],
  txnPage: 0,
  txnPageSize: 50,
};
const TXN_LIMIT = 50;

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isError) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------- navigation ---------- */
const pageMeta = {
  dashboard: ['Dashboard', 'Your financial overview'],
  transactions: ['Transactions', 'All activity'],
  subscriptions: ['Subscriptions', 'Recurring charges'],
  rules: ['Auto-Rules', 'Automatic categorization'],
  goals: ['Goals & Budgets', 'Plan ahead'],
  settings: ['Settings', 'Categories, accounts, data'],
};

function navigate(page) {
  document.querySelectorAll('.page').forEach((el) => el.classList.remove('active'));
  $('page-' + page)?.classList.add('active');
  const [t, s] = pageMeta[page] || [page, ''];
  $('pageTitle').textContent = t;
  $('pageSubtitle').textContent = s;
  document.querySelectorAll('#sideNav .nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  document.querySelectorAll('.mob-nav').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  if (page === 'subscriptions') loadRecurring();
  if (page === 'rules') renderRules();
  if (page === 'goals') renderGoalsBudgets();
  window.scrollTo(0, 0);
}
document.querySelectorAll('#sideNav .nav-item, .mob-nav').forEach((b) =>
  b.addEventListener('click', () => navigate(b.dataset.page))
);

/* ---------- modals ---------- */
function openModal(id) { $('modal-' + id)?.classList.remove('hidden'); }
function closeModal(id) { $('modal-' + id)?.classList.add('hidden'); }
document.querySelectorAll('.modal-overlay').forEach((ov) =>
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.add('hidden'); })
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach((ov) => ov.classList.add('hidden'));
});

/* ---------- selects ---------- */
function fillSelect(id, values, current) {
  const sel = $(id);
  if (!sel) return;
  sel.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    if (v === current) o.selected = true;
    sel.appendChild(o);
  }
}
function refreshCategorySelects() {
  const cats = state.settings.categories || [];
  fillSelect('txnCategory', cats, 'Needs review');
  fillSelect('txnCatFilter', [''].concat(cats));
  $('txnCatFilter').options[0].textContent = 'All categories';
  fillSelect('ruleThen', cats);
  fillSelect('budgetCategory', cats);
}
function refreshAccountSelects() {
  fillSelect('txnAccount', state.settings.accounts || []);
}

/* ---------- state ---------- */
async function loadState() {
  const s = await api('/api/state');
  state.settings = { categories: [], accounts: [], goals: [], budgets: [], ...s.settings };
  state.rules = s.rules || [];
  state.tags = s.tags || [];
  refreshCategorySelects();
  refreshAccountSelects();
  await loadTransactions();
  renderDashboard(s.summary);
  renderRecent(s.recent || []);
  renderSettings();
}

async function loadTransactions() {
  const q = $('txnSearch').value.trim();
  const type = $('txnTypeFilter').value;
  const category = $('txnCatFilter').value;
  const from = $('txnFrom').value;
  const to = $('txnTo').value;
  const params = new URLSearchParams({ limit: TXN_LIMIT, offset: state.txnPage * TXN_LIMIT });
  if (q) params.set('q', q);
  if (type) params.set('type', type);
  if (category) params.set('category', category);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const d = await api('/api/transactions?' + params);
  state.transactions = d.transactions || [];
  renderTxnTable();
}

async function refreshAll() {
  await loadState();
}

/* ---------- dashboard ---------- */
function renderDashboard(summary) {
  const s = summary || { totals: { income: 0, expenses: 0, net: 0 }, byCategory: [], byMonth: [], transactionCount: 0 };
  $('kpiIncome').textContent = money(s.totals.income);
  $('kpiExpenses').textContent = money(s.totals.expenses);
  const net = $('kpiNet');
  net.textContent = money(s.totals.net);
  net.className = 'kpi-value ' + (s.totals.net >= 0 ? 'income' : 'expense');
  $('kpiIncomeSub').textContent = s.transactionCount + ' transactions tracked';
  $('kpiExpSub').textContent = '';
  $('kpiNetSub').textContent = s.totals.net >= 0 ? 'You are saving ✓' : 'Spending exceeds income';

  // monthly bars
  const bars = $('monthlyBars');
  bars.innerHTML = '';
  const months = (s.byMonth || []).slice(-6);
  if (!months.length) { bars.innerHTML = '<div class="empty">No data yet — add transactions to see trends.</div>'; }
  else {
    const max = Math.max(1, ...months.flatMap((m) => [m.income, m.expenses]));
    for (const m of months) {
      const g = document.createElement('div');
      g.className = 'bar-group';
      const label = new Date(m.month + '-02').toLocaleString('default', { month: 'short' });
      g.innerHTML =
        '<div class="bar-pair">' +
        '<div class="bar exp" style="height:' + Math.max(2, (m.expenses / max) * 128) + 'px" title="Expenses ' + money(m.expenses) + '"></div>' +
        '<div class="bar inc" style="height:' + Math.max(2, (m.income / max) * 128) + 'px" title="Income ' + money(m.income) + '"></div>' +
        '</div><div class="bar-label">' + label + '</div>';
      bars.appendChild(g);
    }
  }

  // categories
  const cb = $('categoryBreakdown');
  cb.innerHTML = '';
  const cats = (s.byCategory || []).slice(0, 8);
  if (!cats.length) cb.innerHTML = '<div class="empty">No expenses yet.</div>';
  else {
    const max = Math.max(1, ...cats.map((c) => c.total));
    for (const c of cats) {
      const row = document.createElement('div');
      row.className = 'cat-row';
      row.innerHTML =
        '<span class="cat-name" title="' + esc(c.category) + '">' + esc(c.category) + '</span>' +
        '<div class="cat-track"><div class="cat-fill" style="width:' + Math.max(3, (c.total / max) * 100) + '%"></div></div>' +
        '<span class="cat-amt">' + money(c.total) + '</span>';
      cb.appendChild(row);
    }
  }
}

function renderRecent(recent) {
  const el = $('recentList');
  if (!recent.length) { el.innerHTML = '<div class="empty">No transactions yet. Add your first one above.</div>'; return; }
  el.innerHTML = recent.map((t) =>
    '<div class="list-item"><div class="grow"><div class="title">' + esc(t.merchant) + '</div>' +
    '<div class="sub">' + esc(t.date) + ' · ' + esc(t.category) + '</div></div>' +
    '<div class="amt ' + (t.type === 'income' ? 'pos' : 'neg') + '">' + (t.type === 'income' ? '+' : '−') + money(t.amount) + '</div></div>'
  ).join('');
}

/* ---------- transactions ---------- */
function renderTxnTable() {
  const tb = $('txnTableBody');
  if (!state.transactions.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">No transactions match. Try clearing filters.</td></tr>';
  } else {
    tb.innerHTML = state.transactions.map((t) =>
      '<tr><td style="white-space:nowrap">' + esc(t.date) + '</td>' +
      '<td>' + esc(t.merchant) + (t.tags && t.tags.length ? '<div>' + t.tags.map((g) => '<span class="badge">' + esc(g) + '</span>').join('') + '</div>' : '') + '</td>' +
      '<td><span class="pill">' + esc(t.category) + '</span></td>' +
      '<td><span class="pill ' + t.type + '">' + t.type + '</span></td>' +
      '<td class="amt ' + (t.type === 'income' ? 'pos' : 'neg') + '">' + (t.type === 'income' ? '+' : '−') + money(t.amount) + '</td>' +
      '<td class="row-actions"><button class="icon-btn" onclick="editTxn(\'' + t.id + '\')" title="Edit">✏️</button>' +
      '<button class="icon-btn danger" onclick="deleteTxn(\'' + t.id + '\')" title="Delete">🗑</button></td></tr>'
    ).join('');
  }
  $('txnCount').textContent = state.transactions.length + ' shown (page ' + (state.txnPage + 1) + ')';
  $('txnPrev').disabled = state.txnPage === 0;
  $('txnNext').disabled = state.transactions.length < TXN_LIMIT;
}
$('txnPrev')?.addEventListener('click', () => { if (state.txnPage > 0) { state.txnPage--; loadTransactions(); } });
$('txnNext')?.addEventListener('click', () => { state.txnPage++; loadTransactions(); });
['txnSearch', 'txnTypeFilter', 'txnCatFilter', 'txnFrom', 'txnTo'].forEach((id) => {
  $(id)?.addEventListener('input', () => { state.txnPage = 0; loadTransactions(); });
  $(id)?.addEventListener('change', () => { state.txnPage = 0; loadTransactions(); });
});

function openTxnModal() {
  $('txnModalTitle').textContent = 'Add transaction';
  $('txnId').value = '';
  $('txnDate').value = new Date().toISOString().slice(0, 10);
  $('txnType').value = 'expense';
  $('txnMerchant').value = '';
  $('txnAmount').value = '';
  $('txnTags').value = '';
  openModal('txn');
}

async function editTxn(id) {
  try {
    const t = await api('/api/transactions/' + id);
    $('txnModalTitle').textContent = 'Edit transaction';
    $('txnId').value = t.id;
    $('txnDate').value = t.date || '';
    $('txnType').value = t.type || 'expense';
    $('txnMerchant').value = t.merchant || '';
    $('txnAmount').value = t.amount ?? '';
    $('txnCategory').value = t.category || 'Needs review';
    $('txnAccount').value = t.account || '';
    $('txnTags').value = (t.tags || []).join(', ');
    openModal('txn');
  } catch (e) { toast(e.message, true); }
}

async function submitTxn() {
  const id = $('txnId').value;
  const body = {
    date: $('txnDate').value,
    type: $('txnType').value,
    merchant: $('txnMerchant').value.trim(),
    amount: parseFloat($('txnAmount').value),
    account: $('txnAccount').value,
    category: $('txnCategory').value,
    tags: $('txnTags').value.split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (!body.date || !body.merchant || !isFinite(body.amount)) { toast('Date, merchant and amount are required.', true); return; }
  try {
    if (id) await api('/api/transactions/' + id, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/transactions', { method: 'POST', body: JSON.stringify(body) });
    closeModal('txn');
    toast(id ? 'Transaction updated.' : 'Transaction added.');
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}

async function deleteTxn(id) {
  if (!confirm('Delete this transaction?')) return;
  try {
    await api('/api/transactions/' + id, { method: 'DELETE' });
    toast('Deleted.');
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}

/* ---------- import ---------- */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
    if (parts.length < 3) continue;
    const [date, merchant, amountRaw] = parts;
    if (/date/i.test(date) && /merchant|description/i.test(merchant)) continue; // header
    const amount = parseFloat(String(amountRaw).replace(/[$,]/g, ''));
    if (!date || !merchant || !isFinite(amount)) continue;
    out.push({ date, merchant, amount: Math.abs(amount), type: amount < 0 ? 'expense' : 'expense' });
  }
  return out;
}

async function runImport() {
  let txns = [];
  const csvText = $('importCsv').value.trim();
  const jsonText = $('importJson').value.trim();
  try {
    if (jsonText) {
      const parsed = JSON.parse(jsonText);
      txns = Array.isArray(parsed) ? parsed : parsed.transactions || [];
    } else if (csvText) {
      txns = parseCsv(csvText);
    } else { toast('Paste CSV or JSON first.', true); return; }
  } catch (e) { toast('Could not parse input: ' + e.message, true); return; }
  if (!txns.length) { toast('No valid transactions found.', true); return; }
  try {
    const r = await api('/api/transactions/import', { method: 'POST', body: JSON.stringify(txns) });
    closeModal('import');
    $('importCsv').value = ''; $('importJson').value = '';
    toast('Imported ' + r.imported + ', skipped ' + r.duplicates + ' duplicates.' + (r.errors && r.errors.length ? ' ' + r.errors.length + ' errors.' : ''));
    await refreshAll();
  } catch (e) { toast(e.message, true); }
}

/* ---------- subscriptions ---------- */
async function loadRecurring() {
  try {
    const d = await api('/api/detect/recurring');
    state.recurring = d.suggestions || [];
  } catch (e) { state.recurring = []; toast('Detection failed: ' + e.message, true); }
  renderRecurring();
}

function renderRecurring() {
  const el = $('recurringList');
  const list = state.recurring;
  const monthly = list.reduce((s, r) => s + (r.monthlyEquivalent || 0), 0);
  $('subMonthly').textContent = money(monthly);
  $('subAnnual').textContent = money(monthly * 12);
  $('subCount').textContent = list.length;
  if (!list.length) {
    el.innerHTML = '<div class="card"><div class="empty"><div class="big">🔍</div>No recurring patterns detected yet.<br>Add a few months of transactions and check back.</div></div>';
    return;
  }
  el.innerHTML = list.map((r) =>
    '<div class="list-item"><div class="grow">' +
    '<div class="title">' + esc(r.merchant) + ' <span class="conf ' + r.confidence.toLowerCase() + '">' + esc(r.confidence) + '</span></div>' +
    '<div class="sub">' + esc(r.cadence) + ' · ' + r.occurrences + ' charges · avg ' + money(r.averageAmount) +
    ' · next ~' + esc(r.nextDate) + ' · ' + money(r.monthlyEquivalent) + '/mo</div></div>' +
    '<button class="btn secondary small" onclick="dismissRecurring(\'' + esc(r.key) + '\')">Ignore</button></div>'
  ).join('');
}

async function dismissRecurring(key) {
  try {
    await api('/api/detect/dismiss', { method: 'POST', body: JSON.stringify({ key }) });
    toast('Ignored — it won\'t show up again.');
    await loadRecurring();
  } catch (e) { toast(e.message, true); }
}

/* ---------- rules ---------- */
function renderRules() {
  const el = $('rulesList');
  if (!state.rules.length) {
    el.innerHTML = '<div class="card"><div class="empty"><div class="big">⚙️</div>No rules yet. Create one to auto-categorize new transactions.</div></div>';
    return;
  }
  el.innerHTML = state.rules.map((r) =>
    '<div class="list-item"><div class="grow"><div class="title">When merchant contains “' + esc(r.whenText) + '” → <span class="pill">' + esc(r.thenText) + '</span></div>' +
    '<div class="sub">Created ' + esc((r.createdAt || '').slice(0, 10)) + '</div></div>' +
    '<span class="toggle ' + (r.enabled ? 'on' : '') + '" onclick="toggleRule(\'' + r.id + '\',' + (!r.enabled) + ')"><span class="toggle-track"><span class="toggle-thumb"></span></span></span>' +
    '<button class="icon-btn danger" onclick="deleteRule(\'' + r.id + '\')" title="Delete">🗑</button></div>'
  ).join('');
}

async function submitRule() {
  const whenText = $('ruleWhen').value.trim();
  const thenText = $('ruleThen').value;
  if (!whenText || !thenText) { toast('Both fields are required.', true); return; }
  try {
    await api('/api/rules', { method: 'POST', body: JSON.stringify({ whenText, thenText }) });
    closeModal('rule');
    $('ruleWhen').value = '';
    toast('Rule created.');
    const s = await api('/api/state');
    state.rules = s.rules || [];
    renderRules();
  } catch (e) { toast(e.message, true); }
}

async function toggleRule(id, enabled) {
  try {
    await api('/api/rules/' + id, { method: 'PUT', body: JSON.stringify({ enabled }) });
    const s = await api('/api/state');
    state.rules = s.rules || [];
    renderRules();
  } catch (e) { toast(e.message, true); }
}

async function deleteRule(id) {
  if (!confirm('Delete this rule?')) return;
  try {
    await api('/api/rules/' + id, { method: 'DELETE' });
    const s = await api('/api/state');
    state.rules = s.rules || [];
    renderRules();
    toast('Rule deleted.');
  } catch (e) { toast(e.message, true); }
}

/* ---------- goals & budgets ---------- */
function monthKey() { return new Date().toISOString().slice(0, 7); }

async function renderGoalsBudgets() {
  const goals = state.settings.goals || [];
  const budgets = state.settings.budgets || [];
  const gg = $('goalsGrid');
  gg.innerHTML = goals.length ? '' : '<div class="card"><div class="empty">No goals yet.</div></div>';
  for (const g of goals) {
    const pct = g.target > 0 ? Math.min(100, (g.current / g.target) * 100) : 0;
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + esc(g.name) + '</strong>' +
      '<span><button class="icon-btn" onclick="editGoal(\'' + g.id + '\')" title="Edit">✏️</button>' +
      '<button class="icon-btn danger" onclick="deleteGoal(\'' + g.id + '\')" title="Delete">🗑</button></span></div>' +
      '<div class="muted" style="margin-top:6px">' + money(g.current) + ' of ' + money(g.target) + ' · ' + pct.toFixed(0) + '%</div>' +
      '<div class="progress"><div style="width:' + pct + '%"></div></div>';
    gg.appendChild(div);
  }

  // budget spend this month
  let monthSpend = {};
  try {
    const d = await api('/api/transactions?' + new URLSearchParams({ type: 'expense', from: monthKey() + '-01', limit: 10000 }));
    for (const t of d.transactions || []) monthSpend[t.category] = (monthSpend[t.category] || 0) + Number(t.amount);
  } catch (e) { /* non-fatal */ }

  const bg = $('budgetsGrid');
  bg.innerHTML = budgets.length ? '' : '<div class="card"><div class="empty">No budgets yet.</div></div>';
  for (const b of budgets) {
    const spent = monthSpend[b.category] || 0;
    const pct = b.amount > 0 ? Math.min(100, (spent / b.amount) * 100) : 0;
    const over = spent > b.amount;
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><strong>' + esc(b.category) + '</strong>' +
      '<span><button class="icon-btn" onclick="editBudget(\'' + b.id + '\')" title="Edit">✏️</button>' +
      '<button class="icon-btn danger" onclick="deleteBudget(\'' + b.id + '\')" title="Delete">🗑</button></span></div>' +
      '<div class="muted" style="margin-top:6px">' + money(spent) + ' of ' + money(b.amount) + ' this month' + (over ? ' · <strong style="color:var(--rose)">over budget</strong>' : '') + '</div>' +
      '<div class="progress' + (over ? ' over' : '') + '"><div style="width:' + Math.min(100, pct) + '%"></div></div>';
    bg.appendChild(div);
  }

  const a = parseFloat(state.settings.assetsTotal) || 0;
  const l = parseFloat(state.settings.liabilitiesTotal) || 0;
  $('assetsInput').value = a || '';
  $('liabInput').value = l || '';
  const nw = $('netWorthVal');
  nw.textContent = money(a - l);
  nw.style.color = a - l >= 0 ? 'var(--green)' : 'var(--rose)';
}

const uid = () => 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

async function saveSettingsPatch(patch) {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  Object.assign(state.settings, patch);
}

async function submitGoal() {
  const id = $('goalId').value;
  const name = $('goalName').value.trim();
  const target = parseFloat($('goalTarget').value) || 0;
  const current = parseFloat($('goalCurrent').value) || 0;
  if (!name || target <= 0) { toast('Name and target are required.', true); return; }
  const goals = [...(state.settings.goals || [])];
  if (id) {
    const i = goals.findIndex((g) => g.id === id);
    if (i >= 0) goals[i] = { ...goals[i], name, target, current };
  } else goals.push({ id: uid(), name, target, current, createdAt: new Date().toISOString() });
  try {
    await saveSettingsPatch({ goals });
    closeModal('goal');
    $('goalId').value = ''; $('goalName').value = ''; $('goalTarget').value = ''; $('goalCurrent').value = '';
    renderGoalsBudgets();
    toast('Goal saved.');
  } catch (e) { toast(e.message, true); }
}
function editGoal(id) {
  const g = (state.settings.goals || []).find((x) => x.id === id);
  if (!g) return;
  $('goalId').value = g.id; $('goalName').value = g.name;
  $('goalTarget').value = g.target; $('goalCurrent').value = g.current;
  openModal('goal');
}
async function deleteGoal(id) {
  if (!confirm('Delete this goal?')) return;
  await saveSettingsPatch({ goals: (state.settings.goals || []).filter((g) => g.id !== id) });
  renderGoalsBudgets();
}

async function submitBudget() {
  const id = $('budgetId').value;
  const category = $('budgetCategory').value;
  const amount = parseFloat($('budgetAmount').value) || 0;
  if (!category || amount <= 0) { toast('Category and amount are required.', true); return; }
  const budgets = [...(state.settings.budgets || [])];
  if (id) {
    const i = budgets.findIndex((b) => b.id === id);
    if (i >= 0) budgets[i] = { ...budgets[i], category, amount };
  } else budgets.push({ id: uid(), category, amount });
  try {
    await saveSettingsPatch({ budgets });
    closeModal('budget');
    $('budgetId').value = ''; $('budgetAmount').value = '';
    renderGoalsBudgets();
    toast('Budget saved.');
  } catch (e) { toast(e.message, true); }
}
function editBudget(id) {
  const b = (state.settings.budgets || []).find((x) => x.id === id);
  if (!b) return;
  $('budgetId').value = b.id; $('budgetCategory').value = b.category; $('budgetAmount').value = b.amount;
  openModal('budget');
}
async function deleteBudget(id) {
  if (!confirm('Delete this budget?')) return;
  await saveSettingsPatch({ budgets: (state.settings.budgets || []).filter((b) => b.id !== id) });
  renderGoalsBudgets();
}

async function saveNetWorth() {
  const assetsTotal = parseFloat($('assetsInput').value) || 0;
  const liabilitiesTotal = parseFloat($('liabInput').value) || 0;
  try {
    await saveSettingsPatch({ assetsTotal, liabilitiesTotal, netWorthConfigured: true });
    renderGoalsBudgets();
    toast('Net worth saved.');
  } catch (e) { toast(e.message, true); }
}

/* ---------- settings ---------- */
function renderSettings() {
  const cats = state.settings.categories || [];
  $('catList').innerHTML = cats.map((c) =>
    '<span class="badge">' + esc(c) + ' <a href="#" onclick="removeCategory(\'' + esc(c).replace(/'/g, "\\'") + '\');return false" style="color:var(--rose);text-decoration:none;margin-left:4px">×</a></span>'
  ).join('');
  const accts = state.settings.accounts || [];
  $('acctList').innerHTML = accts.map((a) =>
    '<span class="badge">' + esc(a) + ' <a href="#" onclick="removeAccount(\'' + esc(a).replace(/'/g, "\\'") + '\');return false" style="color:var(--rose);text-decoration:none;margin-left:4px">×</a></span>'
  ).join('');
}

async function addCategory() {
  const v = $('newCat').value.trim();
  if (!v) return;
  const cats = [...(state.settings.categories || [])];
  if (cats.includes(v)) { toast('Category already exists.', true); return; }
  cats.push(v);
  try {
    await saveSettingsPatch({ categories: cats });
    $('newCat').value = '';
    refreshCategorySelects();
    renderSettings();
  } catch (e) { toast(e.message, true); }
}
async function removeCategory(name) {
  if (!confirm('Remove category "' + name + '"?')) return;
  await saveSettingsPatch({ categories: (state.settings.categories || []).filter((c) => c !== name) });
  refreshCategorySelects();
  renderSettings();
}
async function addAccount() {
  const v = $('newAcct').value.trim();
  if (!v) return;
  const accts = [...(state.settings.accounts || [])];
  if (accts.includes(v)) { toast('Account already exists.', true); return; }
  accts.push(v);
  try {
    await saveSettingsPatch({ accounts: accts });
    $('newAcct').value = '';
    refreshAccountSelects();
    renderSettings();
  } catch (e) { toast(e.message, true); }
}
async function removeAccount(name) {
  if (!confirm('Remove account "' + name + '"?')) return;
  await saveSettingsPatch({ accounts: (state.settings.accounts || []).filter((a) => a !== name) });
  refreshAccountSelects();
  renderSettings();
}

async function exportData() {
  try {
    const [txns, s] = await Promise.all([api('/api/transactions?' + new URLSearchParams({ limit: 100000 })), api('/api/state')]);
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), transactions: txns.transactions, settings: s.settings, rules: s.rules, tags: s.tags }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ledgerly-export-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Export downloaded.');
  } catch (e) { toast(e.message, true); }
}

async function confirmReset() {
  if (!confirm('Delete ALL transactions, rules, goals and budgets? This cannot be undone.')) return;
  if (!confirm('Really wipe everything?')) return;
  try {
    await api('/api/reset', { method: 'POST' });
    toast('All data cleared.');
    await refreshAll();
    navigate('dashboard');
  } catch (e) { toast(e.message, true); }
}

/* ---------- boot ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadState();
  } catch (e) {
    console.error(e);
    toast('Could not reach the Ledgerly server. Is it running? (node server.js)', true);
  }
});
