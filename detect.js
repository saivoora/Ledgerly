// detect.js — recurring / subscription detection engine (spec §9).
//
// Pure functions. Given a list of expense transactions [{date,merchant,category,tags,amount}, ...],
// returns suggestion objects. Detection NEVER silently creates a confirmed item — the caller
// (UI/server) surfaces these as Keep/Ignore suggestions only.

const SUBSCRIPTION_HINTS = [
  'netflix','spotify','hulu','disney','youtube','icloud','dropbox','adobe','microsoft',
  'amazon prime','patreon','membership','studio','gym','openai','chatgpt','canva','notion',
  'zoom','slack','github',
];

const RECURRING_HINTS = [
  'mortgage','rent','loan','insurance','utility','utilities','electric','water',
  'internet','phone','mobile','daycare','tuition','lease','car payment','auto payment',
  'hoa','property tax',
];

// Spec §9.1: for pattern matching, normalize merchant names.
export function normalizeMerchant(raw) {
  if (!raw) return '';
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/[#]\d+$/, '');          // remove terminal # + digits
  s = s.replace(/[^\w\s]/g, ' ');         // remove punctuation
  s = s.replace(/\b\d{5,}\b/g, ' ');      // remove long reference-number digit sequences
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const DAY = 24 * 60 * 60 * 1000;
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / DAY);
}

// Cadence windows (in days), spec §9.2.
const CADENCES = [
  { name: 'weekly', min: 5, max: 9, monthlyFactor: 52 / 12 },
  { name: 'biweekly', min: 12, max: 17, monthlyFactor: 26 / 12 },
  { name: 'monthly', min: 24, max: 40, monthlyFactor: 1 },
  { name: 'quarterly', min: 75, max: 110, monthlyFactor: 1 / 3 },
  { name: 'annual', min: 330, max: 400, monthlyFactor: 1 / 12 },
];

function classifyCadence(intervals) {
  if (!intervals.length) return null;
  for (const c of CADENCES) {
    const within = intervals.filter(i => i >= c.min && i <= c.max);
    if (within.length >= Math.ceil(intervals.length / 2)) {
      // dominant interval fits this window
      return c;
    }
  }
  return null;
}

function amountVariationPct(amounts) {
  if (amounts.length < 2) return 0;
  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  if (avg === 0) return 0;
  return Math.max(...amounts.map(a => Math.abs(a - avg) / avg)) * 100;
}

function containsHint(haystackParts, hints) {
  const joined = haystackParts.map(s => String(s || '').toLowerCase()).join(' ');
  return hints.some(h => joined.includes(h));
}

function nextDate(dates, cadenceName) {
  // Calendar-aware next occurrence, preserving day-of-month where possible.
  const sorted = [...dates].sort((a, b) => new Date(a) - new Date(b));
  const last = new Date(sorted[sorted.length - 1]);
  const d = new Date(last);
  const dom = last.getUTCDate();
  switch (cadenceName) {
    case 'weekly': d.setUTCDate(d.getUTCDate() + 7); break;
    case 'biweekly': d.setUTCDate(d.getUTCDate() + 14); break;
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      try { d.setUTCDate(dom); } catch { /* clamp handled below */ }
      break;
    case 'quarterly':
      d.setUTCMonth(d.getUTCMonth() + 3);
      try { d.setUTCDate(dom); } catch { /* */ }
      break;
    case 'annual':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      try { d.setUTCDate(dom); } catch { /* */ }
      break;
    default: d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function intervalJitter(intervals) {
  if (!intervals.length) return Infinity;
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  return Math.max(...intervals.map(i => Math.abs(i - avg)));
}

/**
 * Detect recurring/subscription suggestions from expense transactions.
 * @param {Array} expenses — [{id,date,merchant,category,tags[],amount}]
 * @param {Array} dismissedKeys — normalized merchant keys already ignored
 * @returns {Array} suggestions sorted by confidence
 */
export function detectRecurring(expenses = [], dismissedKeys = []) {
  const dismissed = new Set(dismissedKeys);

  // Group by normalized merchant.
  const groups = new Map();
  for (const t of expenses) {
    const key = normalizeMerchant(t.merchant);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const suggestions = [];

  for (const [key, txns] of groups) {
    if (dismissed.has(key)) continue;
    // Require at least two unique transaction dates (§9.2).
    const uniqueDates = new Set(txns.map(t => t.date));
    if (uniqueDates.size < 2) continue;

    const sorted = [...txns].sort((a, b) => new Date(a.date) - new Date(b.date));
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(daysBetween(sorted[i - 1].date, sorted[i].date));
    }
    const cadence = classifyCadence(intervals);
    if (!cadence) continue; // dominant interval doesn't fit — reject (§9.2)

    const amounts = txns.map(t => Number(t.amount));
    const variation = amountVariationPct(amounts);
    const occCount = txns.length;

    // Determine subscription vs other-recurring via hints (§9.3/§9.4).
    const hintParts = [key, ...txns.map(t => t.category), ...txns.flatMap(t => t.tags || [])];
    const isSubscription =
      containsHint(txns.flatMap(t => t.tags || []), ['subscription']) ||
      containsHint(txns.map(t => t.category), ['subscription']) ||
      containsHint([key], SUBSCRIPTION_HINTS);
    const hasRecurringHint =
      containsHint(hintParts, SUBSCRIPTION_HINTS) ||
      containsHint(hintParts, RECURRING_HINTS);

    const varCap = isSubscription ? 20 : 35;     // §9.2
    const recurringVarCap = 35;

    // Protection against false positives (§9.5):
    // A merchant with no strong hint needs >=3 stable monthly/quarterly/annual
    // occurrences with <=3% variation.
    const isMonthlyOrLonger = ['monthly', 'quarterly', 'annual'].includes(cadence.name);
    if (!hasRecurringHint) {
      if (!isMonthlyOrLonger) continue;            // reject routine weekly shopping
      if (occCount < 3) continue;
      if (variation > 3) continue;
    }

    if (variation > recurringVarCap) continue;

    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const monthlyEquiv = avgAmount * cadence.monthlyFactor;

    // Confidence (§9.6)
    const jitter = intervalJitter(intervals);
    const highConfidence = occCount >= 3 && variation <= 12 && jitter <= 5;
    const confidence = highConfidence ? 'High' : 'Likely';

    const dates = txns.map(t => t.date);
    suggestions.push({
      key,
      merchant: txns[0].merchant, // keep original display merchant
      category: txns[0].category,
      cadence: cadence.name,
      occurrences: occCount,
      confidence,
      averageAmount: Math.round(avgAmount * 100) / 100,
      monthlyEquivalent: Math.round(monthlyEquiv * 100) / 100,
      annualEquivalent: Math.round(monthlyEquiv * 12 * 100) / 100,
      nextDate: nextDate(dates, cadence.name),
      kind: isSubscription ? 'subscription' : 'recurring',
    });
  }

  // High confidence first.
  return suggestions.sort((a, b) => {
    const cv = { High: 0, Likely: 1 };
    if (cv[a.confidence] !== cv[b.confidence]) return cv[a.confidence] - cv[b.confidence];
    return b.monthlyEquivalent - a.monthlyEquivalent;
  });
}
