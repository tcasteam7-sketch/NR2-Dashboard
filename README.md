# NR2 Train Movements Dashboard

Operational monitoring dashboard for the NR2 TKJ-PWL section, built on the
"NR 2 Train Movements" Google Sheet.

**This is a standalone copy.** It shares no code with the Mumbai (VR-ST)
dashboard — the two books have different layouts, so each has its own Apps
Script project, its own deployment and its own page. Changing one never
affects the other.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The dashboard page |
| `apps-script/Code.gs` | Server logic and the JSON API |
| `apps-script/Dashboard.html` | Same dashboard, served from Apps Script |
| `apps-script/Setup.html` | Column mapping installer |
| `apps-script/appsscript.json` | Manifest and OAuth scopes |

## How this differs from the Mumbai copy

The NR2 book is laid out one row higher and names its tabs without a year, so
three things are set differently in `Code.gs`:

| | Mumbai | NR2 |
|---|---|---|
| Section titles | row 2 | **row 1** |
| Column headers | row 3 | **row 2** |
| Data starts | row 4 | **row 3** |
| Month tabs | `AUG-26` | `AUG`, `JULY`, `JUNE`, `MAY` |

`KAVACH_HEADER_ROW` / `KAVACH_SUB_HEADER_ROW` / `KAVACH_DATA_START_ROW` carry
the NR2 values, and `isKavachMonthSheet_` treats the year suffix as optional.
`KAVACH_SPREADSHEET_ID` is pre-set to the NR2 book.

If the NR2 sheet ever gains a title line in row 1, bump those three constants
back to 2/3/4.

## Deploying

1. Open the NR2 sheet -> **Extensions -> Apps Script**.
2. Create the files, matching these names exactly — `Code.gs` looks up the
   HTML by name:

   | Apps Script file | Type | Paste from |
   |---|---|---|
   | `Code` | Script | `apps-script/Code.gs` |
   | `Dashboard` | HTML | `apps-script/Dashboard.html` |
   | `Setup` | HTML | `apps-script/Setup.html` |

3. **Project Settings** -> show the manifest -> paste `apps-script/appsscript.json`.
4. Run any function once and accept the authorisation prompt.
5. **Deploy -> New deployment -> Web app**, execute as **Me**, access **Anyone**.
6. Check `<exec-url>?action=ping` returns `{"ok":true,...}`.
7. Put the `/exec` URL into `index.html` at `var API_URL`.

Then open `<exec-url>?page=setup` to map the columns if the auto-detected
mapping needs correcting.

## Column mapping

The NR2 book's headers do not match the Mumbai names exactly — `LTCAS MAKE`
rather than a plain make column, and sections titled `Mode Change Issues`,
`Brake intervention` and `Train Journey & Operational Summary`. The Setup page
exists to map these; run it before trusting the tiles.

## A note on access

A public page needs the web app deployed to **Anyone**, which means anyone
holding the `/exec` URL can read the sheet. The API key filters casual traffic
but ships in the page source, so it deters rather than protects. If the data
should not be public, serve the Apps Script copy instead and restrict access.

The API is read-only. No endpoint writes to the spreadsheet.
