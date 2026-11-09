import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSettings, taxFromGross, formatXeroDate, addDays, csvEscape, toCsv, billsCsv, billsRows, BILLS_HEADER,
  invoiceRows, invoiceCsv, INVOICE_HEADER, claimRows, summarize, filterReceipts, imageFileName, billReference,
} from '../src/export.js';

const settings = defaultSettings('UK');
const taxi = { id: 'abc123def456', date: '2026-11-03', merchant: 'Uber', category: 'taxi', total: 24, tax: 4, paidWith: 'personal', billable: true, client: 'Acme Ltd', notes: 'Airport', hasImage: true, currency: 'GBP' };
const lunch = { id: 'zzz999', date: '2026-11-01', merchant: 'Pret, "The Strand"', category: 'meals', total: 12.5, tax: 0, noTax: true, paidWith: 'company', billable: false, client: '', notes: '', hasImage: false };

test('tax from gross at 20%', () => {
  assert.equal(taxFromGross(120, 20), 20);
  assert.equal(taxFromGross(24, 20), 4);
  assert.equal(taxFromGross(10, 0), 0);
});

test('date formatting and arithmetic', () => {
  assert.equal(formatXeroDate('2026-11-03', 'DMY'), '03/11/2026');
  assert.equal(formatXeroDate('2026-11-03', 'MDY'), '11/03/2026');
  assert.equal(addDays('2026-11-25', 30), '2026-12-25');
});

test('csv escaping', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(toCsv([['a', 'b'], ['1', 'x,y']]), 'a,b\r\n1,"x,y"\r\n');
});

test('bills CSV matches Xero template shape', () => {
  const rows = billsRows([taxi, lunch], settings);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.length, BILLS_HEADER.length);
  const row = Object.fromEntries(BILLS_HEADER.map((h, i) => [h, rows[0][i]]));
  assert.equal(row['*ContactName'], 'Uber');
  assert.equal(row['*InvoiceDate'], '03/11/2026');
  assert.equal(row['*UnitAmount'], '24.00');
  assert.equal(row['*AccountCode'], '493');
  assert.equal(row['*TaxType'], '20% (VAT on Expenses)');
  assert.equal(row.TaxAmount, '4.00');
  assert.equal(row.TrackingOption1, 'Acme Ltd');
  assert.equal(row.Currency, 'GBP');
  const noTax = Object.fromEntries(BILLS_HEADER.map((h, i) => [h, rows[1][i]]));
  assert.equal(noTax['*TaxType'], 'No VAT');
  assert.equal(noTax.TaxAmount, '0.00');
  assert.equal(noTax['*AccountCode'], '420');
  const csv = billsCsv([lunch], settings);
  assert.ok(csv.startsWith('*ContactName,EmailAddress'));
  assert.ok(csv.includes('"Pret, ""The Strand"""'));
});

test('bill reference is stable and readable', () => {
  assert.equal(billReference(taxi), 'RCPT-20261103-DEF456');
});

test('sales invoice CSV groups by client', () => {
  const other = { ...taxi, id: 'q1', client: 'Beta Co', date: '2026-11-05', total: 50, tax: 8.33 };
  const rows = invoiceRows([taxi, other, { ...lunch, billable: true }], settings, { invoiceDate: '2026-11-09' });
  for (const r of rows) assert.equal(r.length, INVOICE_HEADER.length);
  const byClient = Object.fromEntries(rows.map((r) => [r[0], r]));
  assert.deepEqual(Object.keys(byClient).sort(), ['Acme Ltd', 'Beta Co', 'Unassigned']);
  const acme = Object.fromEntries(INVOICE_HEADER.map((h, i) => [h, byClient['Acme Ltd'][i]]));
  assert.equal(acme['*InvoiceDate'], '09/11/2026');
  assert.equal(acme['*DueDate'], '09/12/2026');
  assert.equal(acme['*UnitAmount'], '24.00');
  assert.equal(acme['*AccountCode'], '200');
  assert.equal(acme['*TaxType'], '20% (VAT on Income)');
  assert.match(acme['*Description'], /^03\/11\/2026 - Taxi \/ rideshare - Uber - Airport$/);
  const numbers = new Set(rows.map((r) => r[10]));
  assert.equal(numbers.size, 3, 'one invoice number per client');
  assert.ok(invoiceCsv([taxi], settings).startsWith(INVOICE_HEADER.join(',')));
});

test('recharge without tax uses zero-rated income type', () => {
  const s = { ...settings, rechargeTax: 'none' };
  const [row] = invoiceRows([taxi], s, { invoiceDate: '2026-11-09' });
  assert.equal(row[INVOICE_HEADER.indexOf('*TaxType')], 'Zero Rated Income');
});

test('recharge net plus tax bills the receipt net amount', () => {
  const s = { ...settings, rechargeTax: 'net' };
  const [row] = invoiceRows([taxi], s, { invoiceDate: '2026-11-09' });
  assert.equal(row[INVOICE_HEADER.indexOf('*UnitAmount')], '20.00');
  assert.equal(row[INVOICE_HEADER.indexOf('*TaxType')], '20% (VAT on Income)');
  const [noTaxRow] = invoiceRows([{ ...lunch, billable: true }], s, { invoiceDate: '2026-11-09' });
  assert.equal(noTaxRow[INVOICE_HEADER.indexOf('*UnitAmount')], '12.50', 'no-tax receipt is recharged in full');
});

test('claim rows split net and tax', () => {
  const [row] = claimRows([taxi], settings);
  assert.equal(row[5], '20.00');
  assert.equal(row[6], '4.00');
  assert.equal(row[7], '24.00');
  assert.equal(row[10], '2026-11-03_uber_24.00.jpg');
  assert.equal(imageFileName(taxi), '2026-11-03_uber_24.00.jpg');
});

test('summaries and filters', () => {
  const s = summarize([taxi, lunch]);
  assert.deepEqual(s, { count: 2, total: 36.5, tax: 4, personal: 24, billable: 24 });
  assert.equal(filterReceipts([taxi, lunch], { status: 'personal' }).length, 1);
  assert.equal(filterReceipts([taxi, lunch], { client: 'Acme Ltd' }).length, 1);
  assert.equal(filterReceipts([taxi, lunch], { from: '2026-11-02' }).length, 1);
  assert.equal(filterReceipts([{ ...taxi, exportedXero: 'x' }, lunch], { status: 'notXero' }).length, 1);
  assert.equal(filterReceipts([{ ...taxi, exportedClaim: 'x' }, lunch], { status: 'notClaimed' }).length, 0);
});

test('regional defaults', () => {
  assert.equal(defaultSettings('AU').taxNames.expense, 'GST on Expenses');
  assert.equal(defaultSettings('US').dateFormat, 'MDY');
  assert.equal(defaultSettings('NZ').taxRate, 15);
});
