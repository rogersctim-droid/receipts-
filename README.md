# Receipts

A phone app for photographing receipts (taxis, meals, hotels, services) and getting them into
**Xero** and onto **client invoices** with as little typing as possible.

It is a progressive web app: open the URL on your phone once, add it to your home screen, and it
behaves like a native app, works offline, and keeps everything on your phone. No app store,
no account, no server, no subscription.

**Live app:** https://rogersctim-droid.github.io/receipts-/ (after the first GitHub Pages deploy, see below)

## What it does

| Step | How |
| --- | --- |
| Capture | Tap **Take photo of receipt**. The app reads the total, GST, merchant, date and a category from the photo and fills them in for you to check. Anything it misses you type. |
| Tag | Mark who paid (personal card = reimburse me) and which client it should be billed to. |
| Into Xero | **Export › Download bills CSV** then Xero › Business › Bills to pay › Import. Or **Share photos to Xero bills inbox** to email the photos to Xero, which reads them itself. |
| Invoice a client | **Export › Download sales invoice CSV** then Xero › Business › Invoices › Import. One draft invoice per client with a line per receipt. |
| Attach evidence | **Expense claim PDF with photos** gives a one-page summary plus every receipt image, ready to attach to the invoice or an expense claim. |
| Daily allowance | The Capture screen shows how much of your daily spend (default $165) is left, with a bar that turns amber at 75% and red when over. The receipt form shows what a receipt would leave. Amount and which categories count are in Settings. |
| Track | Receipts are badged *Not in Xero* / *Xero ✓* and *To claim* / *Claimed ✓* so nothing is exported twice or forgotten. |

## Install on your phone

1. Open the live URL in Safari (iPhone) or Chrome (Android).
2. iPhone: Share button › **Add to Home Screen**. Android: menu › **Install app** / **Add to Home screen**.
3. Open it from the home screen. The app is set up for Australia (AUD, 10% GST, Xero's
   GST on Expenses / GST on Income tax rates). Change the region in **Settings** if needed, enter your name and your Xero bills email address, and save.

### Finding your Xero bills email address

In Xero go to Business › Bills to pay and click the **Email bills to Xero** link near the top
(or Files › Inbox). Copy the address ending in `@xerofiles.com` into Settings. When you use
**Share photos to Xero bills inbox** the app copies that address to your clipboard and opens the
share sheet. Choose Mail and paste the address.

## Xero import notes

- **Bills CSV**: amounts are tax inclusive. When Xero asks, choose **Tax Inclusive**. Each receipt
  becomes a draft bill with the merchant as the contact, the receipt date as bill and due date,
  and a reference like `RCPT-20261103-DEF456`. Attach the photo from the ZIP export if you want
  it on the bill (file names match: `2026-11-03_uber_24.00.jpg`).
- **Sales invoice CSV**: creates draft invoices, one per client, dated today, due in the number of
  days set in Settings. Each line reads `03/11/2026 - Taxi / rideshare - Uber - Airport run`.
  Review before approving.
- **Tax type names** must match your Xero organisation exactly. The defaults are Xero's standard
  Australian names (GST on Expenses, GST Free Expenses, BAS Excluded, GST on Income). UK, NZ and
  US presets are also available. Change them in Settings if yours differ.
- **Account codes** default to Xero's standard chart (493 Travel, 420 Entertainment, 429 General
  Expenses, 453 Office Expenses, 200 Sales). Edit them in Settings to match your chart.
- **Tax on recharged expenses** (Settings) has three options. *Gross + GST* (default): a $44 taxi
  is invoiced at $44 plus $4.40 GST. *Net + GST*: invoiced at $40 plus $4 GST, so the client pays
  exactly what the taxi cost you and you keep the $4 input tax credit. *Gross, no GST*: only for
  true reimbursements where you paid as the client's agent. Check the treatment with your
  accountant and your client contracts.

## Reading receipts (OCR)

Text recognition runs on the phone using Tesseract (bundled under `vendor/tesseract`, Apache 2.0).
Nothing is uploaded. The first time it runs it fetches about 7 MB of engine and language data,
which the service worker then keeps for offline use. Recognition takes a few seconds on a phone.

Fields filled from the photo are highlighted. The app only fills fields you have not already
typed in, and you can tap **Read details from photo** to run it again. Turn it off in Settings if
you prefer to type. Expect it to be right most of the time on printed receipts and poor on
handwritten or crumpled ones; always glance at the total before saving.

How it decides: the total is the amount on a line containing "total", "amount due" or similar
(ignoring subtotals), falling back to the card payment line, then to the largest amount. GST is
the amount on a line mentioning GST or tax. Dates are read day-first (month-first for the US
region). Merchant is a known brand if one appears, otherwise the first proper line of text.
Category is guessed from keywords (Uber, parking, cafe, nights, Officeworks and so on). All of
this is in `src/ocr-parse.js` and tested in `tests/ocr-parse.test.mjs`.

## Backups

All data lives in the browser storage on your phone. Settings › **Download full backup** writes a
single JSON file with every receipt, photo and setting. Keep it somewhere safe (iCloud Drive,
Google Drive) and use **Restore from backup** on a new phone. Clearing the browser's site data
deletes the receipts, so back up before doing that.

## Development

No build step and no dependencies. Serve the folder with any static server:

```bash
npm start            # python3 -m http.server 8080, then open http://localhost:8080
npm test             # unit tests for the CSV/ZIP export code
```

Files:

- `index.html`, `styles.css`: the single screen with its four tabs.
- `src/app.js`: UI, camera handling, image resizing, IndexedDB persistence.
- `src/export.js`: pure functions that produce the Xero bills CSV, Xero sales invoice CSV and
  expense claim CSV. Covered by `tests/`.
- `src/zip.js`: tiny ZIP writer for the receipt-image download.
- `src/ocr.js`, `src/ocr-parse.js`: on-device text recognition and the receipt parser.
- `vendor/tesseract/`: Tesseract.js 7, its WebAssembly core and the English model.
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and home-screen install.
- `.github/workflows/pages.yml`: runs the tests and deploys to GitHub Pages on every push.

## Deploying

The workflow deploys to GitHub Pages automatically. The first run enables Pages for the
repository. If it fails with a permissions message, open the repository's **Settings › Pages** and
set **Source** to **GitHub Actions**, then re-run the workflow.
