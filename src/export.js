// Pure data/export helpers. No DOM access so this file can be unit-tested in Node.

export const REGIONS = {
  AU: {
    label: 'Australia (GST)', currency: 'AUD', rate: 10, dateFormat: 'DMY',
    taxExpense: 'GST on Expenses', taxExpenseZero: 'GST Free Expenses', taxExpenseNone: 'BAS Excluded',
    taxIncome: 'GST on Income', taxIncomeZero: 'GST Free Income',
  },
  UK: {
    label: 'United Kingdom (VAT)', currency: 'GBP', rate: 20, dateFormat: 'DMY',
    taxExpense: '20% (VAT on Expenses)', taxExpenseZero: 'Zero Rated Expenses', taxExpenseNone: 'No VAT',
    taxIncome: '20% (VAT on Income)', taxIncomeZero: 'Zero Rated Income',
  },
  NZ: {
    label: 'New Zealand (GST)', currency: 'NZD', rate: 15, dateFormat: 'DMY',
    taxExpense: '15% GST on Expenses', taxExpenseZero: 'Zero Rated', taxExpenseNone: 'No GST',
    taxIncome: '15% GST on Income', taxIncomeZero: 'Zero Rated',
  },
  US: {
    label: 'United States (Sales tax)', currency: 'USD', rate: 0, dateFormat: 'MDY',
    taxExpense: 'Tax on Purchases', taxExpenseZero: 'Tax Exempt', taxExpenseNone: 'Tax Exempt',
    taxIncome: 'Tax on Sales', taxIncomeZero: 'Tax Exempt',
  },
};

// Default Xero chart-of-accounts codes (Xero's standard chart). All editable in Settings.
export const CATEGORIES = [
  { key: 'taxi', label: 'Taxi / rideshare', account: '493' },
  { key: 'travel', label: 'Travel (train, flights, parking)', account: '493' },
  { key: 'meals', label: 'Meals & drinks', account: '420' },
  { key: 'accommodation', label: 'Accommodation', account: '493' },
  { key: 'services', label: 'Services & subscriptions', account: '429' },
  { key: 'supplies', label: 'Office supplies', account: '453' },
  { key: 'other', label: 'Other', account: '429' },
];

export const PAY_METHODS = {
  personal: 'Personal card / cash (reimburse me)',
  company: 'Company card',
};

export function defaultSettings(region = 'AU') {
  const r = REGIONS[region] || REGIONS.AU;
  return {
    region,
    currency: r.currency,
    taxRate: r.rate,
    dateFormat: r.dateFormat,
    taxNames: {
      expense: r.taxExpense, expenseZero: r.taxExpenseZero, expenseNone: r.taxExpenseNone,
      income: r.taxIncome, incomeZero: r.taxIncomeZero,
    },
    accountCodes: Object.fromEntries(CATEGORIES.map((c) => [c.key, c.account])),
    incomeAccount: '200',
    rechargeTax: 'standard', // 'standard' | 'none'
    dueDays: 30,
    xeroEmail: '',
    yourName: '',
    defaultClient: '',
    invoicePrefix: 'EXP',
  };
}

export function categoryLabel(key) {
  const c = CATEGORIES.find((x) => x.key === key);
  return c ? c.label : key || 'Other';
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function money(n) {
  return round2(n).toFixed(2);
}

// Tax contained in a tax-inclusive total at the given percentage rate.
export function taxFromGross(total, rate) {
  const t = Number(total) || 0;
  const r = Number(rate) || 0;
  if (r <= 0) return 0;
  return round2(t - t / (1 + r / 100));
}

export function formatXeroDate(isoDate, fmt = 'DMY') {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return fmt === 'MDY' ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}

export function addDays(isoDate, days) {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

export function slug(s, max = 30) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'receipt';
}

export function imageFileName(r) {
  return `${r.date}_${slug(r.merchant)}_${money(r.total)}.jpg`;
}

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function expenseTaxType(r, settings) {
  const tax = Number(r.tax) || 0;
  if (r.noTax) return settings.taxNames.expenseNone;
  return tax > 0 ? settings.taxNames.expense : settings.taxNames.expenseZero;
}

function describe(r) {
  const parts = [categoryLabel(r.category), r.merchant || 'Unknown merchant'];
  if (r.notes) parts.push(r.notes);
  return parts.join(' - ');
}

export function billReference(r) {
  return `RCPT-${(r.date || '').replace(/-/g, '')}-${String(r.id || '').slice(-6).toUpperCase()}`;
}

// Xero > Business > Bills to pay > Import. Header matches Xero's bills import template.
// Amounts are tax-inclusive: choose "Tax Inclusive" when importing.
export const BILLS_HEADER = [
  '*ContactName', 'EmailAddress', 'POAddressLine1', 'POAddressLine2', 'POAddressLine3', 'POAddressLine4',
  'POCity', 'PORegion', 'POPostalCode', 'POCountry', '*InvoiceNumber', '*InvoiceDate', '*DueDate', 'Total',
  'InventoryItemCode', 'Description', '*Quantity', '*UnitAmount', '*AccountCode', '*TaxType', 'TaxAmount',
  'TrackingName1', 'TrackingOption1', 'TrackingName2', 'TrackingOption2', 'Currency',
];

export function billsRows(receipts, settings) {
  return receipts.map((r) => [
    r.merchant || 'Unknown merchant', '', '', '', '', '', '', '', '', '',
    billReference(r),
    formatXeroDate(r.date, settings.dateFormat),
    formatXeroDate(r.date, settings.dateFormat),
    money(r.total),
    '',
    describe(r),
    '1',
    money(r.total),
    settings.accountCodes[r.category] || settings.accountCodes.other || '429',
    expenseTaxType(r, settings),
    money(r.noTax ? 0 : r.tax),
    r.client ? 'Client' : '', r.client || '', '', '',
    r.currency || settings.currency,
  ]);
}

export function billsCsv(receipts, settings) {
  return toCsv([BILLS_HEADER, ...billsRows(receipts, settings)]);
}

// Xero > Business > Invoices > Import. Header matches Xero's sales invoice import template.
export const INVOICE_HEADER = [
  '*ContactName', 'EmailAddress', 'POAddressLine1', 'POAddressLine2', 'POAddressLine3', 'POAddressLine4',
  'POCity', 'PORegion', 'POPostalCode', 'POCountry', '*InvoiceNumber', 'Reference', '*InvoiceDate', '*DueDate',
  'InventoryItemCode', '*Description', '*Quantity', '*UnitAmount', 'Discount', '*AccountCode', '*TaxType',
  'TrackingName1', 'TrackingOption1', 'TrackingName2', 'TrackingOption2', 'Currency', 'BrandingTheme',
];

export function groupByClient(receipts) {
  const groups = new Map();
  for (const r of receipts) {
    const key = (r.client || '').trim() || 'Unassigned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return groups;
}

export function invoiceRows(receipts, settings, opts = {}) {
  const invoiceDate = opts.invoiceDate || new Date().toISOString().slice(0, 10);
  const dueDate = addDays(invoiceDate, settings.dueDays);
  const prefix = settings.invoicePrefix || 'EXP';
  const rows = [];
  let n = 0;
  for (const [client, list] of groupByClient(receipts)) {
    n += 1;
    const invoiceNumber = `${prefix}-${invoiceDate.replace(/-/g, '')}-${String(n).padStart(2, '0')}`;
    const taxType = settings.rechargeTax === 'none' ? settings.taxNames.incomeZero : settings.taxNames.income;
    for (const r of list) {
      rows.push([
        client, '', '', '', '', '', '', '', '', '',
        invoiceNumber,
        'Expenses recharged',
        formatXeroDate(invoiceDate, settings.dateFormat),
        formatXeroDate(dueDate, settings.dateFormat),
        '',
        `${formatXeroDate(r.date, settings.dateFormat)} - ${describe(r)}`,
        '1',
        money(r.total),
        '',
        settings.incomeAccount || '200',
        taxType,
        '', '', '', '',
        r.currency || settings.currency,
        '',
      ]);
    }
  }
  return rows;
}

export function invoiceCsv(receipts, settings, opts) {
  return toCsv([INVOICE_HEADER, ...invoiceRows(receipts, settings, opts)]);
}

// Plain spreadsheet for an expense claim or for pasting into any invoicing tool.
export const CLAIM_HEADER = [
  'Date', 'Merchant', 'Category', 'Client', 'Paid with', 'Net', 'Tax', 'Total', 'Currency', 'Notes', 'Receipt image',
];

export function claimRows(receipts, settings) {
  return receipts.map((r) => {
    const tax = r.noTax ? 0 : Number(r.tax) || 0;
    return [
      r.date, r.merchant || '', categoryLabel(r.category), r.client || '', PAY_METHODS[r.paidWith] || r.paidWith || '',
      money((Number(r.total) || 0) - tax), money(tax), money(r.total), r.currency || settings.currency,
      r.notes || '', r.hasImage ? imageFileName(r) : '',
    ];
  });
}

export function claimCsv(receipts, settings) {
  return toCsv([CLAIM_HEADER, ...claimRows(receipts, settings)]);
}

export function summarize(receipts) {
  const out = { count: receipts.length, total: 0, tax: 0, personal: 0, billable: 0 };
  for (const r of receipts) {
    const t = Number(r.total) || 0;
    out.total += t;
    out.tax += r.noTax ? 0 : Number(r.tax) || 0;
    if (r.paidWith === 'personal') out.personal += t;
    if (r.billable) out.billable += t;
  }
  for (const k of ['total', 'tax', 'personal', 'billable']) out[k] = round2(out[k]);
  return out;
}

export function filterReceipts(receipts, f = {}) {
  return receipts.filter((r) => {
    if (f.from && r.date < f.from) return false;
    if (f.to && r.date > f.to) return false;
    if (f.client && (r.client || '') !== f.client) return false;
    if (f.status === 'notXero' && r.exportedXero) return false;
    if (f.status === 'notClaimed' && (r.exportedClaim || !r.billable)) return false;
    if (f.status === 'billable' && !r.billable) return false;
    if (f.status === 'personal' && r.paidWith !== 'personal') return false;
    return true;
  });
}
