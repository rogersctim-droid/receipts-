import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceiptText, amountsIn, findDate, normalizeLine } from '../src/ocr-parse.js';

const now = new Date('2026-11-09T00:00:00Z');

const uber = `Uber
Trip receipt
Thanks for riding, Tim
Total                          $44.00
Trip fare                      $38.50
Booking fee                     $1.50
Airport surcharge               $4.00
Payments
Visa ****1234    09/11/2026    $44.00
Includes GST of $4.00`;

const cafe = `THE GRIND CAFE
123 Collins St Melbourne
ABN 12 345 678 901
TAX INVOICE
08/11/26  12:42   Table 7
2 x Flat White            9.00
Smashed Avo              18.50
Sparkling Water           4.50
Subtotal                 32.00
GST                       2.91
TOTAL                   $32.00
EFTPOS                   32.00
Thank you!`;

const hotel = `Quest Apartment Hotels
Tax Invoice / Receipt
Check-in 3 Nov 2026  Check-out 5 Nov 2026
Room 412  2 nights @ 189.00        378.00
Total incl GST                     378.00
GST included                        34.36
Paid Mastercard                    378.00`;

test('amounts in a line', () => {
  assert.deepEqual(amountsIn('Total $1,234.56 and 9.00'), [1234.56, 9]);
  assert.deepEqual(amountsIn('ABN 12 345 678 901'), []);
  assert.deepEqual(amountsIn('09/11/2026 12:42'), []);
});

test('normalises OCR digit confusions', () => {
  assert.equal(normalizeLine('TOTAL $24.OO'), 'TOTAL $24.00');
  assert.equal(normalizeLine('GST 2 . 91'), 'GST 2.91');
});

test('uber trip receipt', () => {
  const p = parseReceiptText(uber, { now });
  assert.equal(p.merchant, 'Uber');
  assert.equal(p.total, 44);
  assert.equal(p.tax, 4);
  assert.equal(p.date, '2026-11-09');
  assert.equal(p.category, 'taxi');
});

test('cafe receipt with subtotal and two-digit year', () => {
  const p = parseReceiptText(cafe, { now });
  assert.equal(p.merchant, 'The Grind Cafe');
  assert.equal(p.total, 32);
  assert.equal(p.tax, 2.91);
  assert.equal(p.date, '2026-11-08');
  assert.equal(p.category, 'meals');
});

test('hotel invoice with month names', () => {
  const p = parseReceiptText(hotel, { now });
  assert.equal(p.total, 378);
  assert.equal(p.tax, 34.36);
  assert.equal(p.date, '2026-11-03');
  assert.equal(p.category, 'accommodation');
  assert.equal(p.merchant, 'Quest Apartment Hotels');
});

test('airport burrito receipt with GST in a column table', () => {
  const text = `Bowlito
ABN: 64640167515
Sunshine Coast Airport
Ph: 07 5406 2962
e: hello@lagardereawpl.com
Tax Invoice #:2048
Date : 09/11/2026 - 11:38:46
Shop : MCY104 - 002
Staff : 17246 - Zachary
1100321364 Burrito - Beef Brisket
1.00 x 16.90 16.90 (10)
1000003178 Mt Franklin Lightly Spark
1.00 x 6.20 6.20 (10)
Item(s) : 2
TOTAL 23.10
VISA 23.10
GST Tax Net Gst Gross
10 10.00% 21.00 2.10 23.10
Thank You For Shopping at
Bowlito, Sunshine Coast`;
  const p = parseReceiptText(text, { now });
  assert.equal(p.merchant, 'Bowlito');
  assert.equal(p.total, 23.1);
  assert.equal(p.tax, 2.1);
  assert.equal(p.date, '2026-11-09');
  assert.equal(p.category, 'meals');
});

test('falls back to the largest amount when no total word is present', () => {
  const p = parseReceiptText('Parking\n2 hours 8.00\nFee 12.00\n', { now });
  assert.equal(p.total, 12);
  assert.equal(p.totalSource, 'largest');
  assert.equal(p.category, 'travel');
  assert.equal(p.tax, null);
});

test('date formats', () => {
  assert.equal(findDate(['2026-10-31'], { now }), '2026-10-31');
  assert.equal(findDate(['31/10/2026'], { now }), '2026-10-31');
  assert.equal(findDate(['10/31/2026'], { now }), '2026-10-31', 'falls back to MDY when DMY is impossible');
  assert.equal(findDate(['Oct 31, 2026'], { now }), '2026-10-31');
  assert.equal(findDate(['31-Oct-26'], { now }), '2026-10-31');
  assert.equal(findDate(['12/12/2031'], { now }), null, 'future dates rejected');
  assert.equal(findDate(['no date here'], { now }), null);
});

test('empty input is safe', () => {
  const p = parseReceiptText('', { now });
  assert.deepEqual([p.merchant, p.total, p.tax, p.date, p.category], [null, null, null, null, null]);
});
