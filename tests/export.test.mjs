import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSettings, taxFromGross, formatXeroDate, addDays, csvEscape, toCsv, billsCsv, billsRows, BILLS_HEADER,
  invoiceRows, invoiceCsv, INVOICE_HEADER, claimRows, summarize, filterReceipts, imageFileName, billReference,
  allowanceStatus, dateRangeLabel, exportFolderName, monthFolder, payLabel, CLAIM_HEADER,
} from '../src/export.js';

const settings = defaultSettings('UK');
const taxi = { id: 'abc123def456', date: '2026-11-03', merchant: 'Uber', category: 'taxi', total: 24, tax: 4, paidWith: 'personal', billable: true, client: 'Acme Ltd', notes: 'Airport', hasImage: true, currency: 'GBP' };
const lunch = { id: 'zzz999', date: '2026-11-01', merchant: 'Pret, "The Strand"', category: 'meals', total: 12.5, tax: 0, noTax: true, paidWith: 'westpac', billable: false, client: '', notes: '', hasImage: false };

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

test('bills CSV: expense-claim style, one bill payable to you', () => {
  const s = { ...settings, yourName: 'Tim Rogers', billsLabel: 'EA meals' };
  const rows = billsRows([lunch, taxi], s, { date: '2026-11-12' });
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.length, BILLS_HEADER.length);
  const row = Object.fromEntries(BILLS_HEADER.map((h, i) => [h, rows[1][i]]));
  assert.equal(row['*ContactName'], 'Tim Rogers');
  assert.equal(row['*InvoiceNumber'], 'EA meals 1-3 Nov');
  assert.equal(row['*InvoiceDate'], '12/11/2026');
  assert.equal(row['*DueDate'], '12/11/2026');
  assert.equal(row.Total, '');
  assert.equal(row.Description, 'Uber, 3 Nov, Airport');
  assert.equal(row['*Quantity'], '1');
  assert.equal(row['*UnitAmount'], '24.00');
  assert.equal(row['*AccountCode'], '493');
  assert.equal(row['*TaxType'], '20% (VAT on Expenses)');
  assert.equal(row.TaxAmount, '');
  assert.equal(row.TrackingName1, '');
  assert.equal(row.Currency, '');
  const noTax = Object.fromEntries(BILLS_HEADER.map((h, i) => [h, rows[0][i]]));
  assert.equal(noTax['*TaxType'], 'No VAT');
  assert.equal(noTax.Description, 'Meal, 1 Nov, Pret, "The Strand"');
  const csv = billsCsv([lunch], s);
  assert.ok(csv.startsWith('*ContactName,EmailAddress'));
  assert.ok(csv.includes('"Meal, 1 Nov, Pret, ""The Strand"""'));
});

test('bills CSV: one bill per merchant when configured', () => {
  const rows = billsRows([taxi], { ...settings, billsMode: 'merchant' });
  const row = Object.fromEntries(BILLS_HEADER.map((h, i) => [h, rows[0][i]]));
  assert.equal(row['*ContactName'], 'Uber');
  assert.equal(row['*InvoiceNumber'], 'RCPT-20261103-DEF456');
  assert.equal(row['*InvoiceDate'], '03/11/2026');
  assert.equal(row.Total, '');
  assert.equal(row.Currency, '');
});

test('date range labels', () => {
  const d = (date) => ({ date });
  assert.equal(dateRangeLabel([d('2026-11-09'), d('2026-11-12'), d('2026-11-10')]), '9-12 Nov');
  assert.equal(dateRangeLabel([d('2026-10-28'), d('2026-11-02')]), '28 Oct-2 Nov');
  assert.equal(dateRangeLabel([d('2026-11-09')]), '9 Nov');
  assert.equal(dateRangeLabel([d('2025-12-30'), d('2026-01-02')]), '30 Dec 2025-2 Jan 2026');
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
  assert.equal(acme.Currency, '');
  assert.match(acme['*Description'], /^03\/11\/2026 - Uber - Uber - Airport$/);
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

test('claim rows split net and tax, name the card, flag tax invoices', () => {
  const [row] = claimRows([{ ...taxi, taxInvoice: true }], settings);
  assert.equal(row[4], 'Personal card / cash (reimburse me)');
  assert.equal(row[5], '20.00');
  assert.equal(row[6], '4.00');
  assert.equal(row[7], '24.00');
  assert.equal(row[10], '2026-11-03_uber_24.00.jpg');
  assert.equal(row[11], 'Y');
  assert.equal(CLAIM_HEADER[11], 'Tax invoice');
  const [lunchRow] = claimRows([lunch], settings);
  assert.equal(lunchRow[4], 'Westpac business card');
  assert.equal(lunchRow[11], 'N');
  assert.equal(imageFileName(taxi), '2026-11-03_uber_24.00.jpg');
  assert.equal(payLabel('cognatio', settings), 'Cognatio card');
});

test('weekly export folder names never repeat', () => {
  assert.equal(monthFolder('2026-11-14'), '2026-11');
  assert.equal(exportFolderName('2026-11-14'), 'receipts-app-export-2026-11-14');
  assert.equal(exportFolderName('2026-11-14', ['receipts-app-export-2026-11-14']), 'receipts-app-export-2026-11-14-2');
  assert.equal(exportFolderName('2026-11-14', ['receipts-app-export-2026-11-14', 'receipts-app-export-2026-11-14-2']), 'receipts-app-export-2026-11-14-3');
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

test('daily allowance countdown', () => {
  const s = { ...settings, allowance: { enabled: true, amount: 165, categories: ['meals', 'taxi'] } };
  const today = [
    { id: 'a', date: '2026-11-11', category: 'meals', total: 23.1 },
    { id: 'b', date: '2026-11-11', category: 'taxi', total: 40 },
    { id: 'c', date: '2026-11-11', category: 'accommodation', total: 200 },
    { id: 'd', date: '2026-11-10', category: 'meals', total: 50 },
  ];
  const st = allowanceStatus(today, s, '2026-11-11');
  assert.deepEqual(st, { enabled: true, amount: 165, spent: 63.1, left: 101.9, count: 2, over: false });
  const preview = allowanceStatus(today, s, '2026-11-11', { excludeId: 'b', extra: 150 });
  assert.equal(preview.spent, 173.1);
  assert.equal(preview.over, true);
  assert.equal(allowanceStatus(today, { ...s, allowance: { enabled: false, amount: 165 } }, '2026-11-11').enabled, false);
  const exempt = allowanceStatus([...today, { id: 'e', date: '2026-11-11', category: 'taxi', total: 90, allowanceExempt: true }], s, '2026-11-11');
  assert.equal(exempt.spent, 63.1, 'airport taxi marked exempt is ignored');
  assert.deepEqual(defaultSettings().allowance.categories, ['meals', 'taxi', 'other']);
});
