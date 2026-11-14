# Handoff: Receipts app → Friday bookkeeping run (Xero)

For whoever builds or maintains the automation that reads the bookkeeping inbox and creates
the Xero records. Written 14 Nov 2026 against app version 1.7.1. The app's code is in this
repository; the authoritative CSV definition is `src/export.js` (`CLAIM_HEADER`, `claimRows`)
and `tests/export.test.mjs`.

## 1. The shape of the whole flow

```
                     ┌────────────────────────────────────────┐
 paper/card receipts │ Receipts app (phone, on-device only)   │  Friday ~7am, 2 taps
 meals, parking,     │  photo → OCR → checked by Tim → stored │ ───────────────────────┐
 ad hoc taxis,       │  weekly batch: CSV + JPEGs             │                        │
 small purchases     └────────────────────────────────────────┘                        ▼
                                                                          bookkeeping inbox
 Uber rides          Uber business profile → per-trip receipt email ──────► (advisory Gmail)
                                                                                       │
 flights, hotels,    forwarded from company Gmail ─────────────────────────────────────┤
 software, etc.                                                                        ▼
                                                                          Friday run → Xero
```

Hard rule agreed with Tim: **one path into Xero.** The app never pushes to Xero. Its Xero CSV
exports still exist under "Backups and other exports" on the Export screen but are not used
in the normal flow; if one is ever imported by hand, the Friday run would create duplicates
for the same batch. Treat the weekly email as the only app output.

## 2. The weekly email from the app

Sent by Tim from the phone's share sheet (Mail), so subject and sender are whatever iOS Mail
produces. **Do not key on the subject.** Key on the attachments and the first line of the body.

| Part | Value |
|---|---|
| From | Tim's mail account |
| Body line 1 | `Receipts receipts-app-export-YYYY-MM-DD` (the batch id; `-2`, `-3` suffix if a second batch was sent the same day) |
| Body lines 2–3 | `N receipts, total A$x (GST A$y).` and `Attached: <batch>.csv and N photos (k receipts have no photo).` |
| Attachment | `receipts-app-export-YYYY-MM-DD[-n].csv` — exactly one per email |
| Attachments | one JPEG per receipt that has a photo, named as in the CSV's `Receipt image` column |
| Size | the app refuses to build an email over 20 MB; a big week may arrive as two batches with different ids |
| Timing | Tim sends Thursday afternoon or Friday morning (a repeating Thursday 4 pm phone reminder exists). The Export screen defaults to the current week, Monday to send day, and flags older unsent receipts, so a batch normally covers one week |

**Idempotency key: the batch id** (= CSV file name without `.csv`). The app never reuses a
batch id, and it marks the included receipts as exported so they do not appear in a later
batch. Record processed batch ids and skip any you have seen. A receipt edited or deleted in
the app after it was exported is *not* re-sent; corrections after Friday are manual.

The CSV is UTF-8, CRLF line endings, RFC 4180 quoting (fields containing commas or quotes are
double-quoted, embedded quotes doubled). No BOM.

## 3. CSV columns

| # | Column | Type | Meaning |
|---|---|---|---|
| 1 | `Date` | `YYYY-MM-DD` | Receipt date as read/entered, not the export date |
| 2 | `Merchant` | text | As on the receipt; OCR-read then checked, may still be imperfect |
| 3 | `Category` | one of: `Meals & drinks`, `Taxi`, `Parking`, `Travel (train, flights)`, `Accommodation`, `Office supplies`, `Services & subscriptions`, `Other` | In practice almost all rows are the first three |
| 4 | `Client` | text or blank | Non-blank ⇒ rechargeable to that client (normally `Energy Australia`). Blank ⇒ not rechargeable |
| 5 | `Paid with` | exactly one of `Personal card / cash (reimburse me)`, `Westpac business card`, `Cognatio card` | See §4 |
| 6 | `Net` | 0.00 | `Total − Tax` |
| 7 | `Tax` | 0.00 | GST on the receipt. Read from the receipt when the reader found a GST line, otherwise computed as Total/11; `0.00` when Tim ticked "No GST" |
| 8 | `Total` | 0.00 | GST-inclusive amount paid |
| 9 | `Currency` | `AUD` | |
| 10 | `Notes` | text or blank | Free text from Tim |
| 11 | `Receipt image` | file name or blank | Matches an attached JPEG. Blank = no photo (entered by hand). Two identical receipts on one day get `-2` before `.jpg` |
| 12 | `Tax invoice` | `Y`/`N` | `Y` when the receipt shows the supplier's ABN and the words "tax invoice" (set automatically by the reader when it sees both, or by Tim). Needed to claim GST on anything over $82.50 |
| 13 | `Airport transfer` | `Y`/`N` | Taxi to/from an airport. Always rechargeable to the client and outside the daily allowance |
| 14 | `Daily allowance` | `Y`/`N` | `Y` when the row counts towards the $165/day cap. Already applies the rules below, so you can sum `Total` where this is `Y` grouped by `Date` |

Columns 12–14 were appended in that order; columns 1–11 are unchanged from the original brief.

Example row:

```
2026-11-11,Bowlito,Meals & drinks,Energy Australia,Westpac business card,21.00,2.10,23.10,AUD,,2026-11-11_bowlito_23.10.jpg,Y,N,Y
```

## 4. Business rules the app applies (so you do not have to re-derive them)

**Defaults on every new receipt**, changed by Tim by exception: paid with Westpac business
card; billable to the default client (Energy Australia); category = last used.

**Taxis are the exception to billable.** An ad hoc taxi is a business expense and *not*
billable unless (a) `Airport transfer` is `Y`, which makes it billable and exempt from the
allowance, or (b) Tim set a `Client` by hand.

**Daily allowance, $165/day, meals and incidentals.** Counts `Meals & drinks`, `Taxi` and
`Other`. `Parking`, `Travel`, `Accommodation` and the rest are outside it (Tim can change the
set in Settings). Airport transfers and anything Tim marked "Not part of my daily allowance"
are excluded. The `Daily allowance` column is the result of all that. The cap is per receipt
*date*, not per batch, and Uber rides (which never pass through the app) are not in it.

**Paid with → Xero treatment** (from the original brief; the app only carries the label):

| Paid with | What the bookkeeping does |
|---|---|
| Personal card / cash (reimburse me) | Bill payable to supplier "Tim Rogers", settled from the director's loan |
| Westpac business card | Spend money / bill matched to the Westpac bank feed |
| Cognatio card | Coded to the Cognatio loan |

**Suggested account coding** (the app's own defaults, used only in its unused Xero CSVs;
override freely in the bookkeeping rules): Meals & drinks 420, Taxi/Parking/Travel/
Accommodation 493, Office supplies 453, Services/Other 429. Recharge lines to the client at
the gross receipt amount plus GST was the app's default when it did invoicing; whether to
invoice gross+GST or net+GST is a bookkeeping decision now.

## 5. Uber rides (not in the app)

Booked on the Uber business profile "Rogers Advisory", default payment Mastercard ••9596,
receipts emailed per trip to the bookkeeping inbox by Uber (`noreply@uber.com`, subject
"Your <day> <time> trip with Uber"). The emails carry pickup/drop-off addresses, fare and GST.

Rules: an Uber **to or from an airport is rechargeable to the client**; every other Uber is a
business expense and not rechargeable unless Tim says so. "Airport" appears in the address
on the receipt; that is the signal to use. Uber rides are not part of the app's $165 figure.

If a weekly/monthly Uber travel report is ever switched on, it duplicates the per-trip
receipts; ignore one or the other.

## 6. Things that will go wrong, and what to do

- **No batch arrives Friday.** Tim sends it by hand; the app only nags from Thursday. Nothing
  else to detect; process the next batch when it comes. Batch ids are dated by send day, so a
  late batch is `receipts-app-export-<Saturday>`.
- **Same-day second batch.** Id ends `-2`. It contains only receipts not in the first.
- **Wrong total.** The reader fills totals from the photo and Tim checks, but a missed
  check is possible. The photo is attached; `Total` is what Tim saw and approved.
- **`Tax` computed, not read.** When no GST line was legible the app uses Total/11. For a
  receipt with mixed GST-free items this overstates GST. Only `Tax invoice = Y` rows have a
  defensible GST claim anyway.
- **No photo** (`Receipt image` blank): hand-entered; still a valid line, no evidence attached.
- **Edits after export** are not resent. If Tim says "I fixed last week's Bowlito", that is a
  manual correction in Xero.
- The app's "Mark as exported" is Tim's action after sending; if he forgets, the same
  receipts reappear in the next batch with the *same* image names. Dedupe by
  `(Date, Merchant, Total, Receipt image)` as a second line of defence.

## 7. Where things live

- App: https://rogersctim-droid.github.io/receipts-/ (data is only on Tim's phone; JSON backup from Settings)
- Code: this repository. CSV definition `src/export.js`; tests `tests/export.test.mjs`;
  OCR parsing `src/ocr-parse.js`.
- Settings that affect the CSV: payment method labels, default client, allowance categories.
  All under Settings in the app; changing a label changes the strings in column 5.

## 8. Decisions log

- 13 Nov: Xero bills CSV reworked to "one bill payable to Tim, a line per receipt". Then
  superseded: app does not feed Xero directly.
- 14 Nov: Weekly folder export built to the brief, then replaced as the primary path by the
  emailed batch because the inbox is what the Friday run reads. Folder export kept as backup.
- 14 Nov: Defaults set to Westpac card + billable. Uber rides excluded from the app. Taxis
  non-billable unless airport transfer. Columns 12–14 added.
