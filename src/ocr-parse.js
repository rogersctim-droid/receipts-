// Turns raw OCR text from a receipt into suggested field values.
// Pure functions, no DOM, covered by tests/ocr-parse.test.mjs.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const BRANDS = [
  [/\buber\b/i, 'Uber'], [/\bdidi\b/i, 'DiDi'], [/\bola\b/i, 'Ola'], [/13\s*cabs/i, '13cabs'], [/\bsilver\s*top/i, 'Silver Top Taxi'],
  [/\bqantas\b/i, 'Qantas'], [/\bjetstar\b/i, 'Jetstar'], [/virgin\s*australia/i, 'Virgin Australia'], [/\brex\b.*airlines|regional\s*express/i, 'Rex'],
  [/\blinkt\b/i, 'Linkt'], [/wilson\s*parking/i, 'Wilson Parking'], [/secure\s*parking/i, 'Secure Parking'], [/\bopal\b/i, 'Opal'], [/\bmyki\b/i, 'myki'],
  [/\bhertz\b/i, 'Hertz'], [/\bavis\b/i, 'Avis'], [/\bthrifty\b/i, 'Thrifty'], [/\beuropcar\b/i, 'Europcar'],
  [/\bwoolworths\b/i, 'Woolworths'], [/\bcoles\b/i, 'Coles'], [/\bofficeworks\b/i, 'Officeworks'], [/\bbunnings\b/i, 'Bunnings'], [/jb\s*hi-?fi/i, 'JB Hi-Fi'],
  [/\bmcdonald/i, "McDonald's"], [/hungry\s*jack/i, "Hungry Jack's"], [/\bkfc\b/i, 'KFC'], [/\bsubway\b/i, 'Subway'], [/guzman/i, 'Guzman y Gomez'],
  [/\bzambrero\b/i, 'Zambrero'], [/\bstarbucks\b/i, 'Starbucks'], [/gloria\s*jean/i, "Gloria Jean's"], [/\bnando'?s\b/i, "Nando's"], [/\bgrill'?d\b/i, "Grill'd"],
  [/\bibis\b/i, 'Ibis'], [/\bmercure\b/i, 'Mercure'], [/\bnovotel\b/i, 'Novotel'], [/\bhilton\b/i, 'Hilton'], [/\bmarriott\b/i, 'Marriott'], [/\bairbnb\b/i, 'Airbnb'],
  [/\btelstra\b/i, 'Telstra'], [/\boptus\b/i, 'Optus'], [/\bvodafone\b/i, 'Vodafone'], [/7-?eleven/i, '7-Eleven'], [/\bampol\b/i, 'Ampol'], [/\bcaltex\b/i, 'Caltex'],
];

const CATEGORY_KEYWORDS = {
  taxi: [[/\buber\b|\bdidi\b|\bola\b|\btaxi\b|\bcabs?\b|rideshare|trip\s*fare|\bfare\b|13\s*cabs|silver\s*top/i, 3]],
  travel: [
    [/qantas|jetstar|virgin\s*australia|\bflight|boarding|\bairline|\brex\b/i, 3],
    [/\btoll|linkt|\bopal\b|\bmyki\b|translink|\btrain\b|\bmetro\b|\bbus\b|\bferry\b|\btram\b/i, 3],
    [/\bfuel\b|petrol|unleaded|diesel|\bampol\b|\bcaltex\b|\bbp\b|\bshell\b|7-?eleven/i, 2],
    [/car\s*hire|car\s*rental|\bhertz\b|\bavis\b|\bthrifty\b|europcar|\bbudget\b/i, 3],
  ],
  parking: [[/parking|car\s*park|\bmeter\b|\bbay\s*\d|wilson|secure\s*park|\bentry\s*time|\bexit\s*time/i, 3]],
  accommodation: [
    [/accommodation|\bnights?\b|check-?\s*in|check-?\s*out|room\s*(rate|charge|no|number)|\bsuite\b|airbnb|\bibis\b|mercure|novotel|hilton|marriott|\bmotel\b|\bresort\b/i, 3],
    [/\bhotel\b/i, 1],
  ],
  meals: [
    [/\bcaf[eé]\b|restaurant|\bbistro\b|\bkitchen\b|\bbakery\b|\bpizza|\bburger|\bsushi\b|\bthai\b|\bgrill\b|\bpub\b|\btavern\b|\bbrasserie\b|\beatery\b|\bdiner\b/i, 3],
    [/\bcoffee\b|\blatte\b|flat\s*white|cappuccino|\bespresso\b|\bchai\b|\bbreakfast\b|\blunch\b|\bdinner\b|\bmeal\b|\bcovers?\b|\btable\s*\d|\bdine\s*in|take\s*away/i, 2],
    [/\bburrito|\btacos?\b|\bsandwich|\bsalad|\bwrap\b|\bbowl\b|\bnoodle|\bcurry|\bchicken|\bbeef\b|\bbrisket|\bfries\b|\bchips\b|\bjuice\b|\bsmoothie|\bwater\b|\bsparkling|\bmuffin|\bcroissant|\btoast/i, 2],
    [/mcdonald|hungry\s*jack|\bkfc\b|\bsubway\b|guzman|zambrero|starbucks|gloria\s*jean|nando|grill'?d|\bwine\b|\bbeer\b|\bschooner\b/i, 3],
  ],
  supplies: [[/officeworks|stationery|\btoner\b|\bink\b|cartridge|\bpaper\b|\bpens?\b|\bnotebook\b|jb\s*hi-?fi|harvey\s*norman|\bbunnings\b/i, 3]],
  services: [[/subscription|\blicen[cs]e\b|\bhosting\b|\bdomain\b|\bsoftware\b|\btelstra\b|\boptus\b|\bvodafone\b|\bconsult|\bplan\b|\bmonthly\b/i, 2]],
};

export function normalizeAmountToken(tok) {
  // OCR often reads 0 as O and 1 as l/I inside numbers.
  if (!/^\$?[\dOoIl]{1,6}[.,][\dOoIl]{2}$/.test(tok) || !/\d/.test(tok)) return tok;
  return tok.replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
}

export function normalizeLine(line) {
  return line
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(normalizeAmountToken)
    .join(' ')
    .replace(/(\d)\s+[.,]\s*(\d{2})\b/g, '$1.$2') // "24 . 00" -> "24.00"
    .replace(/\$\s+(\d)/g, '$$$1');
}

export function amountsIn(line) {
  const out = [];
  const re = /(?:^|[^\d.,])(\d{1,3}(?:,\d{3})+|\d{1,6})[.,](\d{2})(?![\d])/g;
  let m;
  while ((m = re.exec(line))) {
    const whole = m[1].replace(/,/g, '');
    const value = Number(`${whole}.${m[2]}`);
    if (Number.isFinite(value) && value > 0 && value < 100000) out.push(value);
  }
  return out;
}

const TOTAL_WORDS = /\b(grand\s*total|total\s*(due|amount|paid|payable|incl|inc)?|amount\s*(due|paid|payable|tendered)|balance\s*due|to\s*pay|net\s*payable|gross)\b/i;
const NOT_TOTAL = /sub\s*-?\s*total|total\s*(savings?|discount|items?|qty|quantity|units?)|\bgst\b|\btax\b|\bchange\b|\brounding\b|\bpoints\b/i;
const CARD_WORDS = /\b(eftpos|visa|mastercard|amex|debit|credit|card|paywave|tap|contactless|purchase)\b/i;

export function findTotal(lines) {
  const totalLines = [];
  const cardLines = [];
  let max = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let amounts = amountsIn(line);
    // A header row such as "GST  Net  Gross" has its numbers on the following line.
    const headerTotal = !amounts.length && TOTAL_WORDS.test(line) && lines[i + 1] ? amountsIn(lines[i + 1]) : [];
    if (headerTotal.length) { totalLines.push(headerTotal[headerTotal.length - 1]); continue; }
    if (!amounts.length) continue;
    max = Math.max(max, ...amounts);
    if (TOTAL_WORDS.test(line) && !NOT_TOTAL.test(line)) totalLines.push(amounts[amounts.length - 1]);
    else if (CARD_WORDS.test(line) && !NOT_TOTAL.test(line)) cardLines.push(amounts[amounts.length - 1]);
  }
  if (totalLines.length) return { value: Math.max(...totalLines), source: 'total' };
  if (cardLines.length) return { value: Math.max(...cardLines), source: 'card' };
  // No total line read (often the bottom of the receipt). If there are itemised
  // "qty x price amount" lines, their sum is a better guess than the largest number.
  const itemAmounts = lines
    .map((l) => l.match(/^\s*\d+(?:\.\d+)?\s*[xX×@]\s*\$?[\d.,]+\s+\$?(\d[\d,]*\.\d{2})\b/))
    .filter(Boolean)
    .map((m) => Number(m[1].replace(/,/g, '')));
  if (itemAmounts.length >= 2) {
    const sum = Math.round(itemAmounts.reduce((a, b) => a + b, 0) * 100) / 100;
    if (sum >= max) return { value: sum, source: 'items' };
  }
  if (max > 0) return { value: max, source: 'largest' };
  return null;
}

export function findTax(lines, total) {
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bgst\b|\btax\b|\bvat\b/i.test(line) || /tax\s*invoice|\babn\b|tax\s*code|gst\s*(reg|no|number)/i.test(line)) continue;
    let amounts = amountsIn(line);
    // Column headers like "GST  Net  Gross" put the numbers on the next line.
    if (!amounts.length && lines[i + 1]) amounts = amountsIn(lines[i + 1]);
    for (const a of amounts) {
      if (!total || a < total) candidates.push(a);
    }
  }
  if (!candidates.length) return null;
  // Most receipts print the GST once; if several numbers, prefer the one that fits ~1/11 of total.
  if (total) candidates.sort((a, b) => Math.abs(a - total / 11) - Math.abs(b - total / 11));
  return candidates[0];
}

function validDate(y, m, d, now) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 100) y += 2000;
  if (y < 2000 || y > now.getFullYear() + 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  if (dt.getTime() > now.getTime() + 2 * 86400000) return null;
  return dt.toISOString().slice(0, 10);
}

export function findDate(lines, { dateFormat = 'DMY', now = new Date() } = {}) {
  const text = lines.join('\n');
  let m;
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(text))) { const d = validDate(+m[1], +m[2], +m[3], now); if (d) return d; }

  const numeric = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/g;
  while ((m = numeric.exec(text))) {
    const a = +m[1]; const b = +m[2]; const y = +m[3];
    const first = dateFormat === 'MDY' ? validDate(y, a, b, now) : validDate(y, b, a, now);
    if (first) return first;
    const second = dateFormat === 'MDY' ? validDate(y, b, a, now) : validDate(y, a, b, now);
    if (second) return second;
  }

  const monthName = /\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/]*(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?[\s\-/]*(\d{4}|\d{2})\b/gi;
  while ((m = monthName.exec(text))) { const d = validDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1], now); if (d) return d; }
  const monthFirst = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;
  while ((m = monthFirst.exec(text))) { const d = validDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2], now); if (d) return d; }
  return null;
}

const SKIP_MERCHANT = /tax\s*invoice|\binvoice\b|\breceipt\b|\babn\b|\bacn\b|\bphone\b|\btel\b|\bph[:.]|www\.|https?:|@|welcome|thank|\bstore\b\s*\d|\border\b|\bdate\b|\btime\b|\bcashier\b|\bserved\b|\bterminal\b|\bmerchant\s*id|\bcopy\b/i;

// A plausible business name: at least one real word of 3+ letters, mostly letters overall,
// and not a short fragment like "i IO" that OCR makes of a stylised logo.
function looksLikeName(line) {
  const compact = line.replace(/\s/g, '');
  const letters = (line.match(/[a-z]/gi) || []).length;
  const words = line.split(/\s+/).filter((w) => /^[a-z][a-z'’&.-]{2,}$/i.test(w));
  return letters >= 4 && words.length >= 1 && letters / Math.max(1, compact.length) >= 0.6 && !/[|\\/#@*_=~<>{}\[\]]/.test(line);
}

export function findMerchant(lines) {
  const text = lines.join('\n');
  for (const [re, name] of BRANDS) if (re.test(text)) return name;
  // "Thank you for shopping at Bowlito, Sunshine Coast" style footers are very reliable.
  const footer = text.match(/thank\s*you\s*for\s*(?:shopping|dining|visiting|your\s*(?:visit|business|custom|purchase))?\s*(?:at|with)\s+([A-Za-z][A-Za-z0-9'’&.\- ]{2,40}?)(?:[,!.\n]|$)/i);
  if (footer && looksLikeName(footer[1])) return tidyName(footer[1]);
  for (const line of lines.slice(0, 8)) {
    if (SKIP_MERCHANT.test(line) || amountsIn(line).length || !looksLikeName(line)) continue;
    return tidyName(line);
  }
  return null;
}

function tidyName(s) {
  const clean = s.replace(/[^\w&'’.\- ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean === clean.toUpperCase()) {
    return clean.toLowerCase().replace(/(^|[\s\-'’])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  }
  return clean;
}

export function guessCategory(lines) {
  const text = lines.join('\n');
  const scores = {};
  for (const [cat, rules] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const [re, weight] of rules) {
      const hits = (text.match(new RegExp(re.source, 'gi')) || []).length;
      if (hits) scores[cat] = (scores[cat] || 0) + weight * Math.min(hits, 3);
    }
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : null;
}

// A GST credit over $82.50 needs a tax invoice: the supplier's ABN and the words "tax invoice".
export function isTaxInvoice(lines) {
  const text = lines.join('\n');
  return /\babn\b|a\.b\.n\./i.test(text) && /tax\s*invoice/i.test(text);
}

export function parseReceiptText(text, opts = {}) {
  const lines = String(text || '').split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const totalInfo = findTotal(lines);
  const total = totalInfo ? totalInfo.value : null;
  const tax = findTax(lines, total);
  return {
    merchant: findMerchant(lines),
    total,
    totalSource: totalInfo ? totalInfo.source : null,
    tax,
    date: findDate(lines, opts),
    category: guessCategory(lines),
    taxInvoice: isTaxInvoice(lines),
    lines,
  };
}
