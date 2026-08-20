/* ============================================================
   KAVACH DASHBOARD - Apps Script web app + sheet row tracking
   ============================================================ */

const KAVACH_ROW_ID_HEADER = "KAVACH_ROW_ID";
const KAVACH_CHANGE_LOG_SHEET = "Dashboard Change Log";
const KAVACH_REASON_MASTER_SHEET = "Dashboard Reason Master";
/* NR2 book has no row-1 title line: section titles sit in row 1, column
   headers in row 2, data from row 3. (The Mumbai book uses 2/3/4.) */
const KAVACH_HEADER_ROW = 1;
const KAVACH_SUB_HEADER_ROW = 2;
const KAVACH_DATA_START_ROW = 3;
const KAVACH_SETUP_BATCH_SIZE = 3;
const KAVACH_SETUP_NEXT_INDEX_KEY = "KAVACH_SETUP_NEXT_INDEX";
const KAVACH_ROW_COUNT_PROPERTY_PREFIX = "KAVACH_ROW_COUNT_";
const KAVACH_LAST_EDIT_PROPERTY_PREFIX = "KAVACH_LAST_EDIT_";
const KAVACH_SAFETY_SWEEP_NEXT_INDEX_KEY = "KAVACH_SAFETY_SWEEP_NEXT_INDEX";
const KAVACH_SAFETY_SWEEP_SHEETS_PER_RUN = 2;
const KAVACH_ONCHANGE_EDIT_FALLBACK_WINDOW_MS = 90 * 1000;
var KAVACH_SPREADSHEET_ID = "1Bg4BFnfQeZHHY1VpXGPNNWJLAYH_WX3dPTWZCxSqaoA";

/* The only tabs treated as month data. Compared upper-cased and trimmed. */
const KAVACH_MONTH_SHEETS = ["AUG", "JULY", "JUNE", "MAY"];

/* These five are `var` on purpose: the setup page can replace them at the start
   of a request so one deployment can serve any spreadsheet. */
var KAVACH_DASHBOARD_TITLE = "NR2 Train Movements Dashboard";
var KAVACH_DASHBOARD_SUBTITLE = "TKJ-PWL section operational monitoring";
const KAVACH_CONFIG_KEY = "KAVACH_ACTIVE_CONFIG";
const KAVACH_CONFIG_SHEET = "Dashboard Config";
/* Optional shared secret for the JSON API. Leave blank to allow any caller.
   When set, every request must carry ?key=<this value>. */
const KAVACH_API_KEY = "";
const KAVACH_SUMMARY_CACHE_KEY = "KAVACH_SUMMARY_V1";
const KAVACH_SUMMARY_CACHE_SECONDS = 1800;
const KAVACH_SUMMARY_MAX_SHEETS = 14;
const KAVACH_DAY_CACHE_KEY = "KAVACH_DAY_V1";
const KAVACH_DAY_CACHE_SECONDS = 60;
const KAVACH_SUMMARY_TIME_BUDGET_MS = 200 * 1000;
/* getLastRow() counts stray formatting, so find the real end of the data and
   never read past these bounds. */
const KAVACH_SCAN_LIMIT = 20000;
const KAVACH_MAX_DATA_ROWS = 6000;
const KAVACH_MIN_READ_WIDTH = 30;

const KAVACH_LOG_HEADERS = [
  "Timestamp",
  "SheetName",
  "RowID",
  "RowNumber",
  "Column",
  "Action",
  "OldDate",
  "NewDate",
  "ChangeType",
  "User",
];
const KAVACH_REASON_MASTER_HEADERS = [
  "SectionTitle",
  "Metric",
  "Reason",
  "SourceColumn",
  "UpdatedAt",
];

/* Each tile on the dashboard. `match` is tried in order against the merged
   header title in row 2 of a month sheet; first hit wins. */
const KAVACH_METRICS = [
  {
    key: "modeDegradation",
    label: "Mode Degradation",
    altLabel: "Mode Change",
    tone: "orange",
    match: ["MODE CHANGE ANALYSIS", "MODE DEGRADATION ANALYSIS", "MODE DEGRADATION", "MODE CHANGE"],
  },
  {
    key: "undesirableBrake",
    label: "Undesirable Brake",
    tone: "crimson",
    match: ["UNDUE BRAKING ANALYSIS", "UNDESIRABLE BRAKING", "UNDESIRABLE BRAKE", "UNDUE BRAKING"],
  },
  {
    key: "desirableBrake",
    label: "Desirable Brake",
    tone: "green",
    match: ["DESIRABLE BRAKING", "DESIRABLE BRAKE"],
  },
  {
    key: "locoIsolated",
    label: "Loco Isolated",
    tone: "aqua",
    match: ["LOCO ISOLATED", "LOCO ISOLATION", "ISOLATION OF KAVACH", "ISOLATED"],
  },
  {
    key: "rfidMissing",
    label: "RFID Missing",
    tone: "blue",
    match: ["RFID DIAGNOSTIC ANALYSIS", "RFID MISSING", "MISSING RFID", "RFID MISS", "RFID"],
  },
];

const KAVACH_TRAIN_MATCH = ["TRAIN DETAILS", "TRAIN DETAIL", "TOTAL TRAIN", "TRAIN RUN", "TRAIN"];

/* Explicit columns, in sheet letters. `columns` replaces title matching for the
   whole section; `reason` / `icms` / `count` can be given on their own to fix
   just one column while the section itself is still found by title. */
var KAVACH_SECTION_OVERRIDES = {
  modeDegradation: {
    columns: "Y:AA", reason: "Z", icms: "AA", remarks: "AW",
    location: "W", locationLabel: "Mode Change Station",
  },
  undesirableBrake: {
    columns: "AC:AI", reason: "AG", icms: "AH", remarks: "AX",
    location: "AC", locationLabel: "Brake Intervention Station",
    exclude: ["RB CODE", "RB"],
  },
  desirableBrake: {
    /* AO is the reason, not an ICMS column - no ICMS column known for this section. */
    columns: "AJ:AO", reason: "AO", icms: "", remarks: "AY",
    location: "AJ", locationLabel: "Desirable Braking Station",
  },
  locoIsolated: { columns: "AU:AV", reason: "AU", remarks: "" },
  /* AQ:AR decide whether a row counts; AS and AT are shown, not counted. */
  rfidMissing: {
    columns: "AQ:AR", reason: "AS",
    append: [{ column: "AT", label: "Attention" }],
  },
};

/* Absolute sheet columns used by the monthly reports and the availability
   calculation. Same letters on every month tab. */
var KAVACH_REPORT_COLUMNS = {
  loco: "C",
  km: "N",
  runningHours: "O",
  downHours: "Q",
  modeChange: "Y",
  modeReason: "Z",
  /* Leave blank to find the loco make / OEM column by its header text. */
  make: "",
  /* Column holding UP / DN. Blank falls back to a header search, then to a
     UP/DN suffix on the train or loco number. */
  direction: "G",
};

/* Columns for the row-level report. Blank means "not mapped yet" and renders as
   an empty cell - fill in the letters and the column fills itself. */
var KAVACH_DETAIL_COLUMNS = {
  trainNo: "B",
  mode: {
    type: "Y",
    reason: "Z",
    absLoc: "X",
    remarks: "AW",
    failureType: "AA",
    location: "W",
  },
  /* Brake application covers both braking sections. Type of Brake reads AD or
     AK and is tagged with which one it came from. */
  brake: {
    undesirable: {
      label: "Undesirable",
      section: "AC:AI",
      type: "AD",
      reason: "AG",
      absLoc: "AE",
      remarks: "AX",
      failureType: "AH",
      location: "AC",
    },
    desirable: {
      label: "Desirable",
      section: "AJ:AO",
      type: "AK",
      reason: "AO",
      absLoc: "AM",
      remarks: "AY",
      failureType: "AP",
      location: "AJ",
    },
  },
};

const KAVACH_DETAIL_MAX_ROWS = 3000;

/* Values in the mode-change column that mean "no mode change happened". */
const KAVACH_NEGATIVE_VALUES = ["", "-", "0", "NO", "NIL", "NA", "N/A", "NONE", "NO MODE CHANGE"];

/* Where the availability percentage comes from. Leave blank to auto-detect:
   a month-sheet column named "...Availability", else computed from down hours
   over train hours, else a date row on the Operational Availability sheet. */
const KAVACH_AVAILABILITY = { sheet: "", column: "" };

function kavachColumnToIndex_(letters) {
  const text = String(letters || "").trim().toUpperCase();
  if (!text) {
    return 0;
  }
  let index = 0;
  for (let position = 0; position < text.length; position += 1) {
    const code = text.charCodeAt(position) - 64;
    if (code < 1 || code > 26) {
      return 0;
    }
    index = index * 26 + code;
  }
  return index;
}

/* Widest column any configured range touches - nothing beyond this is read. */
function kavachReadWidth_() {
  let widest = KAVACH_MIN_READ_WIDTH;
  Object.keys(KAVACH_SECTION_OVERRIDES).forEach((key) => {
    const override = KAVACH_SECTION_OVERRIDES[key];
    ["columns", "reason", "icms", "count"].forEach((field) => {
      if (!override[field]) {
        return;
      }
      String(override[field]).split(":").forEach((letter) => {
        widest = Math.max(widest, kavachColumnToIndex_(letter));
      });
    });
  });
  Object.keys(KAVACH_REPORT_COLUMNS).forEach((key) => {
    widest = Math.max(widest, kavachColumnToIndex_(KAVACH_REPORT_COLUMNS[key]));
  });
  const walk = (value) => {
    if (!value) {
      return;
    }
    if (typeof value === "object") {
      Object.keys(value).forEach((key) => walk(value[key]));
      return;
    }
    String(value).split(":").forEach((letter) => {
      widest = Math.max(widest, kavachColumnToIndex_(letter));
    });
  };
  walk(KAVACH_DETAIL_COLUMNS);
  return widest;
}

/* Number of real data rows, found from the date and loco columns rather than
   trusting getLastRow(). */
function kavachDataRowCount_(sheet) {
  const reported = sheet.getLastRow();
  if (reported < KAVACH_DATA_START_ROW) {
    return 0;
  }
  const ceiling = Math.min(reported, KAVACH_DATA_START_ROW + KAVACH_SCAN_LIMIT - 1);
  const height = ceiling - KAVACH_DATA_START_ROW + 1;
  const probes = [findKavachDateColumn_(sheet), kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.loco)];
  let count = 0;
  probes.forEach((column) => {
    if (!column) {
      return;
    }
    const values = sheet.getRange(KAVACH_DATA_START_ROW, column, height, 1).getDisplayValues();
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (String(values[index][0] || "").trim()) {
        count = Math.max(count, index + 1);
        break;
      }
    }
  });
  return Math.min(count, KAVACH_MAX_DATA_ROWS);
}

function kavachColumnAt_(layout, index) {
  if (!index) {
    return null;
  }
  return layout.columns.filter((column) => column.index === index)[0] || null;
}

function kavachOverrideBlock_(layout, metric) {
  const override = KAVACH_SECTION_OVERRIDES[metric.key];
  if (!override || !override.columns) {
    return null;
  }
  const parts = String(override.columns).split(":");
  const start = kavachColumnToIndex_(parts[0]);
  const end = parts.length > 1 ? kavachColumnToIndex_(parts[1]) : start;
  if (!start || !end || end < start) {
    return null;
  }
  const columns = layout.columns.filter((column) => column.index >= start && column.index <= end);
  if (!columns.length) {
    return null;
  }
  return { title: `${metric.label.toUpperCase()} (columns ${override.columns})`, columns: columns, override: override };
}

function kavachResolveBlock_(layout, metric) {
  const block = kavachOverrideBlock_(layout, metric) || kavachBlockFor_(layout, metric.match);
  if (block) {
    block.override = KAVACH_SECTION_OVERRIDES[metric.key] || {};
  }
  return block;
}

/* Small tiles under "Yesterday Position". Unmapped ones render as an em dash. */
const KAVACH_EXTRA_TILES = [
  { key: "highRev", label: "High REV Power STN", tone: "blue", match: [/HIGH\s*REV/] },
  { key: "lowFwd", label: "Low FWD Power STN", tone: "aqua", match: [/LOW\s*FWD/] },
  { key: "exceptionFaults", label: "Total Exception Faults", tone: "crimson", match: [/EXCEPTION/] },
  { key: "stationsDue", label: "Stations with Maintenance Due", tone: "violet", match: [/STATION.*MAINT/] },
  { key: "hutsDue", label: "Huts with Maintenance Due", tone: "green", match: [/HUT.*MAINT/] },
];

var KAVACH_GRID_CACHE = {};
var KAVACH_LAYOUT_CACHE = {};

/* ============================================================
   Web app entry points
   ============================================================ */

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = String(params.action || "").toLowerCase();
  const callback = params.callback || "";
  kavachApplyConfig_();
  if (String(params.page || "").toLowerCase() === "setup") {
    return HtmlService.createHtmlOutputFromFile("Setup")
      .setTitle("Kavach Dashboard setup")
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  }
  if (!action || action === "dashboard") {
    return HtmlService.createHtmlOutputFromFile("Dashboard")
      .setTitle("Kavach BC Dashboard")
      .addMetaTag("viewport", "width=device-width, initial-scale=1");
  }
  try {
    if (KAVACH_API_KEY && String(params.key || "") !== KAVACH_API_KEY) {
      return kavachJsonResponse_({ ok: false, error: "Bad or missing key." }, callback);
    }
    let payload;
    if (action === "ping") {
      payload = { ok: true, time: new Date().toISOString() };
    } else if (action === "range") {
      payload = {
        ok: true,
        report: kavachRangeReport({ from: params.from, to: params.to, make: params.make }),
      };
    } else if (action === "detail") {
      payload = {
        ok: true,
        report: kavachDetailReport({
          from: params.from,
          to: params.to,
          report: params.report,
          brakeKind: params.brakeKind,
          makes: String(params.makes || "").split(",").filter((make) => make),
        }),
      };
    } else if (action === "data") {
      payload = { ok: true, data: kavachDashboardData({ refresh: params.refresh === "1" }) };
    } else if (action === "day") {
      payload = { ok: true, data: kavachDayData({ refresh: params.refresh === "1" }) };
    } else if (action === "summary") {
      payload = { ok: true, summary: kavachSummaryData({ refresh: params.refresh === "1" }) };
    } else if (action === "report") {
      payload = { ok: true, report: kavachReportData(params.type || "modeChange") };
    } else if (action === "csv") {
      if (String(params.type) === "detail") {
        const detail = kavachDetailReport({
          from: params.from,
          to: params.to,
          report: params.report,
          brakeKind: params.brakeKind,
          makes: String(params.makes || "").split(",").filter((make) => make),
        });
        return ContentService.createTextOutput(kavachDetailToCsv_(detail))
          .setMimeType(ContentService.MimeType.CSV)
          .downloadAsFile(detail.fileName);
      }
      const report = String(params.type) === "range"
        ? kavachRangeReport({ from: params.from, to: params.to, make: params.make })
        : kavachReportData(params.type || "modeChange");
      return ContentService.createTextOutput(kavachReportToCsv_(report))
        .setMimeType(ContentService.MimeType.CSV)
        .downloadAsFile(report.fileName);
    } else if (action === "columns") {
      payload = {
        ok: true,
        layout: kavachInspectColumns({ sheet: params.sheet || "", from: params.from || "Y", to: params.to || "AT" }),
      };
    } else if (action === "headers") {
      payload = { ok: true, layout: kavachInspectHeaders() };
    } else if (action === "reasons") {
      payload = { ok: true, reasons: readKavachReasonMaster_() };
    } else if (action === "changes") {
      payload = { ok: true, changes: readKavachChangeLog_(Number(params.limit || 200)) };
    } else if (action === "status") {
      payload = { ok: true, status: kavachTrackingStatus_() };
    } else {
      payload = { ok: false, error: `Unknown action: ${action}` };
    }
    return kavachJsonResponse_(payload, callback);
  } catch (error) {
    return kavachJsonResponse_({ ok: false, error: String((error && error.message) || error) }, callback);
  }
}

/* ============================================================
   Saved configuration - lets one deployment serve any spreadsheet
   ============================================================ */

/* Every mapping the dashboard needs, with the keyword used to auto-detect it. */
function kavachConfigSchema_() {
  return [
    { group: "Identity", key: "report.loco", label: "Loco No", detect: [/LOCO\s*(ID|NO)/, /^LOCO$/] },
    { group: "Identity", key: "detail.trainNo", label: "Train No", detect: [/TRAIN\s*NO/, /^TRAIN$/] },
    { group: "Identity", key: "report.make", label: "OEM / Loco Make", detect: [/LOCO\s*MAKE/, /^MAKE$/] },
    { group: "Identity", key: "report.direction", label: "Direction (UP/DN)", detect: [/DIRECTION/, /UP\s*\/?\s*DN/] },
    { group: "Summary", key: "report.km", label: "Run Km", detect: [/\bKM\b/, /KILOMET/] },
    { group: "Summary", key: "report.runningHours", label: "Running Hours", detect: [/RUN.*HOUR/, /TRAIN\s*HOUR/] },
    { group: "Summary", key: "report.downHours", label: "Down Hours", detect: [/DOWN\s*(HOUR|TIME)/, /LOSS/] },

    { group: "Mode change", key: "section.modeDegradation.columns", label: "Section range", range: true },
    { group: "Mode change", key: "section.modeDegradation.reason", label: "Reason", detect: [/REASON/] },
    { group: "Mode change", key: "section.modeDegradation.icms", label: "ICMS / Type of failure", detect: [/ICMS/, /FAILURE/] },
    { group: "Mode change", key: "section.modeDegradation.location", label: "Station / Location", detect: [/LOCATION|STATION/] },
    { group: "Mode change", key: "section.modeDegradation.remarks", label: "Remarks", detect: [/REMARK/] },

    { group: "Undesirable braking", key: "section.undesirableBrake.columns", label: "Section range", range: true },
    { group: "Undesirable braking", key: "section.undesirableBrake.reason", label: "Reason", detect: [/REASON/] },
    { group: "Undesirable braking", key: "section.undesirableBrake.icms", label: "ICMS / Type of failure", detect: [/ICMS/, /FAILURE/] },
    { group: "Undesirable braking", key: "section.undesirableBrake.location", label: "Station", detect: [/STATION/] },
    { group: "Undesirable braking", key: "section.undesirableBrake.remarks", label: "Remarks", detect: [/REMARK/] },
    { group: "Undesirable braking", key: "detail.brake.undesirable.type", label: "Type of brake", detect: [/TYPE/] },
    { group: "Undesirable braking", key: "detail.brake.undesirable.absLoc", label: "AbsLoc", detect: [/ABS/] },

    { group: "Desirable braking", key: "section.desirableBrake.columns", label: "Section range", range: true },
    { group: "Desirable braking", key: "section.desirableBrake.reason", label: "Reason", detect: [/REASON/] },
    { group: "Desirable braking", key: "section.desirableBrake.icms", label: "ICMS / Type of failure", detect: [/ICMS/, /FAILURE/] },
    { group: "Desirable braking", key: "section.desirableBrake.location", label: "Station", detect: [/STATION/] },
    { group: "Desirable braking", key: "section.desirableBrake.remarks", label: "Remarks", detect: [/REMARK/] },
    { group: "Desirable braking", key: "detail.brake.desirable.type", label: "Type of brake", detect: [/TYPE/] },
    { group: "Desirable braking", key: "detail.brake.desirable.absLoc", label: "AbsLoc", detect: [/ABS/] },

    { group: "Tag miss", key: "section.rfidMissing.columns", label: "Section range", range: true },
    { group: "Tag miss", key: "section.rfidMissing.reason", label: "Reason", detect: [/REASON/] },

    { group: "Loco isolated", key: "section.locoIsolated.columns", label: "Section range", range: true },
    { group: "Loco isolated", key: "section.locoIsolated.reason", label: "Reason", detect: [/REASON/] },
    { group: "Loco isolated", key: "section.locoIsolated.remarks", label: "Remarks", detect: [/REMARK/] },
  ];
}

function kavachCurrentConfigValues_() {
  const values = {};
  kavachConfigSchema_().forEach((field) => {
    values[field.key] = kavachReadConfigPath_(field.key);
  });
  return values;
}

function kavachReadConfigPath_(path) {
  const parts = String(path).split(".");
  const roots = {
    report: KAVACH_REPORT_COLUMNS,
    detail: KAVACH_DETAIL_COLUMNS,
    section: KAVACH_SECTION_OVERRIDES,
  };
  let node = roots[parts[0]];
  for (let index = 1; index < parts.length; index += 1) {
    if (!node) {
      return "";
    }
    node = node[parts[index]];
  }
  return typeof node === "string" ? node : "";
}

function kavachWriteConfigPath_(path, value) {
  const parts = String(path).split(".");
  const roots = {
    report: KAVACH_REPORT_COLUMNS,
    detail: KAVACH_DETAIL_COLUMNS,
    section: KAVACH_SECTION_OVERRIDES,
  };
  let node = roots[parts[0]];
  for (let index = 1; index < parts.length - 1; index += 1) {
    if (!node[parts[index]]) {
      node[parts[index]] = {};
    }
    node = node[parts[index]];
  }
  if (node) {
    node[parts[parts.length - 1]] = String(value || "").trim().toUpperCase();
  }
}

function kavachStoredConfig_() {
  try {
    const raw = PropertiesService.getDocumentProperties().getProperty(KAVACH_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

/* Called at the top of every request so saved mappings replace the defaults. */
function kavachApplyConfig_() {
  const config = kavachStoredConfig_();
  if (!config) {
    return null;
  }
  if (config.spreadsheetId) {
    KAVACH_SPREADSHEET_ID = config.spreadsheetId;
  }
  if (config.title) {
    KAVACH_DASHBOARD_TITLE = config.title;
  }
  if (config.subtitle) {
    KAVACH_DASHBOARD_SUBTITLE = config.subtitle;
  }
  Object.keys(config.values || {}).forEach((key) => {
    kavachWriteConfigPath_(key, config.values[key]);
  });
  /* Mode-change detail columns mirror the mode section. */
  const mode = KAVACH_SECTION_OVERRIDES.modeDegradation || {};
  KAVACH_DETAIL_COLUMNS.mode.reason = mode.reason || KAVACH_DETAIL_COLUMNS.mode.reason;
  KAVACH_DETAIL_COLUMNS.mode.remarks = mode.remarks || KAVACH_DETAIL_COLUMNS.mode.remarks;
  KAVACH_DETAIL_COLUMNS.mode.location = mode.location || KAVACH_DETAIL_COLUMNS.mode.location;
  KAVACH_DETAIL_COLUMNS.mode.failureType = mode.icms || KAVACH_DETAIL_COLUMNS.mode.failureType;
  ["undesirable", "desirable"].forEach((kind) => {
    const sectionKey = kind === "undesirable" ? "undesirableBrake" : "desirableBrake";
    const section = KAVACH_SECTION_OVERRIDES[sectionKey] || {};
    const target = KAVACH_DETAIL_COLUMNS.brake[kind];
    target.section = section.columns || target.section;
    target.reason = section.reason || target.reason;
    target.remarks = section.remarks || target.remarks;
    target.location = section.location || target.location;
    target.failureType = section.icms || target.failureType;
  });
  return config;
}

function kavachSpreadsheetIdFromUrl_(text) {
  const match = String(text || "").match(/[-\w]{25,}/);
  return match ? match[0] : "";
}

/* Opens the target book, reads the first month tab, and guesses each mapping. */
function kavachDetectConfig(input) {
  const settings = input || {};
  const id = kavachSpreadsheetIdFromUrl_(settings.url) || KAVACH_SPREADSHEET_ID;
  if (!id) {
    throw new Error("Paste a Google Sheets link first.");
  }
  const book = SpreadsheetApp.openById(id);
  const sheets = book.getSheets().filter((sheet) => isKavachMonthSheet_(sheet.getName()));
  if (!sheets.length) {
    throw new Error(`No month tabs (like AUG-26) found in "${book.getName()}".`);
  }
  const sheet = sheets[0];
  const layout = kavachLayout_(sheet);
  const rowCount = kavachDataRowCount_(sheet);
  const samples = rowCount
    ? sheet.getRange(KAVACH_DATA_START_ROW, 1, Math.min(rowCount, 6), layout.lastColumn).getDisplayValues()
    : [];

  const columns = layout.columns.map((column, index) => ({
    letter: kavachIndexToColumn_(column.index),
    title: column.group || "",
    header: column.label || "",
    samples: samples.map((row) => String(row[index] || "").trim()).filter((value) => value).slice(0, 2),
  }));

  const detected = {};
  kavachConfigSchema_().forEach((field) => {
    if (field.range) {
      const parts = String(field.key).split(".");
      const block = kavachBlockFor_(layout, (KAVACH_METRICS.filter((metric) => metric.key === parts[1])[0] || {}).match || []);
      detected[field.key] = block
        ? `${kavachIndexToColumn_(block.columns[0].index)}:${kavachIndexToColumn_(block.columns[block.columns.length - 1].index)}`
        : "";
      return;
    }
    const scope = kavachDetectScope_(layout, field.key, detected);
    const hit = kavachFindColumn_(scope, field.detect || []);
    detected[field.key] = hit ? kavachIndexToColumn_(hit.index) : "";
  });

  return {
    spreadsheetId: id,
    spreadsheetName: book.getName(),
    sheetName: sheet.getName(),
    monthTabs: sheets.map((item) => item.getName()),
    columns: columns,
    detected: detected,
    current: kavachCurrentConfigValues_(),
    schema: kavachConfigSchema_().map((field) => ({
      key: field.key, label: field.label, group: field.group, range: Boolean(field.range),
    })),
  };
}

/* Section-scoped fields only search inside that section's detected range. */
function kavachDetectScope_(layout, key, detected) {
  const parts = String(key).split(".");
  if (parts[0] !== "section") {
    return layout.columns;
  }
  const span = kavachRangeIndexes_(detected[`section.${parts[1]}.columns`]);
  if (!span) {
    return layout.columns;
  }
  return layout.columns.filter((column) => column.index >= span.start && column.index <= span.end);
}

function kavachSaveConfig(payload) {
  const settings = payload || {};
  const id = kavachSpreadsheetIdFromUrl_(settings.url) || settings.spreadsheetId;
  if (!id) {
    throw new Error("A spreadsheet link is required.");
  }
  const config = {
    spreadsheetId: id,
    title: String(settings.title || "").trim() || KAVACH_DASHBOARD_TITLE,
    subtitle: String(settings.section || settings.subtitle || "").trim() || KAVACH_DASHBOARD_SUBTITLE,
    values: {},
    savedAt: new Date().toISOString(),
  };
  kavachConfigSchema_().forEach((field) => {
    const value = String((settings.values || {})[field.key] || "").trim().toUpperCase();
    if (value) {
      config.values[field.key] = value;
    }
  });
  PropertiesService.getDocumentProperties().setProperty(KAVACH_CONFIG_KEY, JSON.stringify(config));
  kavachMirrorConfigToSheet_(config);
  return { ok: true, config: config };
}

/* Also write the mapping to a tab so it is visible and reviewable. */
function kavachMirrorConfigToSheet_(config) {
  try {
    const book = SpreadsheetApp.getActive() || SpreadsheetApp.openById(config.spreadsheetId);
    let sheet = book.getSheetByName(KAVACH_CONFIG_SHEET);
    if (!sheet) {
      sheet = book.insertSheet(KAVACH_CONFIG_SHEET);
    }
    sheet.clearContents();
    const rows = [
      ["Setting", "Value"],
      ["Spreadsheet ID", config.spreadsheetId],
      ["Title", config.title],
      ["Section", config.subtitle],
      ["Saved at", config.savedAt],
      ["", ""],
      ["Field", "Column"],
    ];
    kavachConfigSchema_().forEach((field) => {
      rows.push([`${field.group} - ${field.label}`, config.values[field.key] || ""]);
    });
    sheet.getRange(1, 1, rows.length, 2).setValues(rows);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 320);
  } catch (error) {
    /* mirroring is best-effort - the saved property is the source of truth */
  }
}

function kavachClearConfig() {
  PropertiesService.getDocumentProperties().deleteProperty(KAVACH_CONFIG_KEY);
  return { ok: true };
}

function kavachActiveConfig() {
  const config = kavachStoredConfig_();
  return {
    configured: Boolean(config),
    config: config,
    defaults: {
      title: KAVACH_DASHBOARD_TITLE,
      subtitle: KAVACH_DASHBOARD_SUBTITLE,
      values: kavachCurrentConfigValues_(),
    },
    schema: kavachConfigSchema_().map((field) => ({
      key: field.key, label: field.label, group: field.group, range: Boolean(field.range),
    })),
  };
}

/* ============================================================
   Install a standalone copy into other spreadsheets
   ============================================================ */

function kavachApiError_(response, what) {
  let detail = "";
  try {
    const body = JSON.parse(response.getContentText());
    detail = (body.error && body.error.message) || "";
  } catch (error) {
    detail = String(response.getContentText() || "").slice(0, 200);
  }
  if (response.getResponseCode() === 403) {
    detail += " Turn the Apps Script API on at script.google.com/home/usersettings, then try again.";
  }
  return new Error(`${what} failed (${response.getResponseCode()}). ${detail}`);
}

/* This project's own source, straight from the Apps Script API. */
function kavachProjectFiles_() {
  const response = UrlFetchApp.fetch(
    `https://script.googleapis.com/v1/projects/${ScriptApp.getScriptId()}/content`,
    { headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }, muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) {
    throw kavachApiError_(response, "Reading this project");
  }
  const files = JSON.parse(response.getContentText()).files || [];
  if (!files.length) {
    throw new Error("This project reported no files.");
  }
  return files;
}

/* Creates a bound script in each spreadsheet and copies the code into it. Each
   copy is standalone - it reads its own container and keeps its own config, so
   this file can be unlinked afterwards. */
function kavachInstallToSpreadsheets(payload) {
  const links = ((payload || {}).urls || [])
    .map((link) => String(link || "").trim())
    .filter((link) => link);
  if (!links.length) {
    throw new Error("Paste at least one spreadsheet link.");
  }
  const files = kavachProjectFiles_();
  const token = ScriptApp.getOAuthToken();
  const headers = { Authorization: `Bearer ${token}` };
  const results = [];

  links.forEach((link) => {
    const id = kavachSpreadsheetIdFromUrl_(link);
    try {
      if (!id) {
        throw new Error("That is not a Google Sheets link.");
      }
      const book = SpreadsheetApp.openById(id);
      const name = book.getName();

      const created = UrlFetchApp.fetch("https://script.googleapis.com/v1/projects", {
        method: "post",
        contentType: "application/json",
        headers: headers,
        payload: JSON.stringify({ title: `${name} - Kavach Dashboard`, parentId: id }),
        muteHttpExceptions: true,
      });
      if (created.getResponseCode() !== 200) {
        throw kavachApiError_(created, "Creating the script");
      }
      const newScriptId = JSON.parse(created.getContentText()).scriptId;

      const pushed = UrlFetchApp.fetch(`https://script.googleapis.com/v1/projects/${newScriptId}/content`, {
        method: "put",
        contentType: "application/json",
        headers: headers,
        payload: JSON.stringify({ files: files }),
        muteHttpExceptions: true,
      });
      if (pushed.getResponseCode() !== 200) {
        throw kavachApiError_(pushed, "Copying the code");
      }

      results.push({
        ok: true,
        link: link,
        name: name,
        scriptId: newScriptId,
        scriptUrl: `https://script.google.com/d/${newScriptId}/edit`,
        files: files.map((file) => file.name),
      });
    } catch (error) {
      results.push({ ok: false, link: link, message: String((error && error.message) || error) });
    }
  });
  return results;
}

function kavachJsonResponse_(payload, callback) {
  const json = JSON.stringify(payload);
  if (callback) {
    return ContentService.createTextOutput(`${callback}(${json});`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* A configured spreadsheet wins over the container, so the setup page can point
   this deployment at a different book. */
function kavachSpreadsheet_() {
  if (KAVACH_SPREADSHEET_ID) {
    const active = SpreadsheetApp.getActive();
    if (active && active.getId() === KAVACH_SPREADSHEET_ID) {
      return active;
    }
    return SpreadsheetApp.openById(KAVACH_SPREADSHEET_ID);
  }
  const active = SpreadsheetApp.getActive();
  if (active) {
    return active;
  }
  throw new Error("No spreadsheet context. Open the setup page and pick a spreadsheet.");
}

/* ============================================================
   Dashboard data
   ============================================================ */

/* Phase 1 - only the one or two month sheets the two dates live in, so the
   tiles paint in a couple of seconds. Cached briefly: uncached, this was
   slow enough on a cold call to trip the browser's connection-reset
   threshold before it finished. */
function kavachDayData(options) {
  const settings = options || {};
  const cache = CacheService.getDocumentCache();
  const cacheKey = KAVACH_DAY_CACHE_KEY + ":" + (settings.date || "now");
  if (!settings.refresh && cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (error) {
        /* fall through and recompute */
      }
    }
  }
  kavachApplyConfig_();
  KAVACH_GRID_CACHE = {};
  KAVACH_LAYOUT_CACHE = {};
  const ss = kavachSpreadsheet_();
  const tz = ss.getSpreadsheetTimeZone();
  const now = new Date();
  const today = settings.date ? kavachParseIsoDate_(settings.date) : now;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const data = {
    title: KAVACH_DASHBOARD_TITLE,
    subtitle: KAVACH_DASHBOARD_SUBTITLE,
    liveLabel: Utilities.formatDate(now, tz, "MMM d, yyyy h:mm a"),
    webAppUrl: kavachWebAppUrl_(),
    today: kavachDayReport_(ss, today, tz),
    yesterday: kavachDayReport_(ss, yesterday, tz),
    extras: kavachExtraTiles_(ss, yesterday, tz),
  };
  if (cache) {
    try {
      cache.put(cacheKey, JSON.stringify(data), KAVACH_DAY_CACHE_SECONDS);
    } catch (error) {
      /* payload too large to cache - recompute next time */
    }
  }
  return data;
}

/* Phase 2 - the all-months scan. Cached, and called separately so a slow or
   failed scan can never stop the tiles from rendering. */
function kavachSummaryData(options) {
  const settings = options || {};
  kavachApplyConfig_();
  KAVACH_GRID_CACHE = {};
  KAVACH_LAYOUT_CACHE = {};
  const ss = kavachSpreadsheet_();
  return kavachIncidenceSummary_(ss, ss.getSpreadsheetTimeZone(), Boolean(settings.refresh));
}

function kavachDashboardData(options) {
  const data = kavachDayData(options);
  data.summary = kavachSummaryData(options);
  return data;
}

function kavachWebAppUrl_() {
  try {
    return ScriptApp.getService().getUrl() || "";
  } catch (error) {
    return "";
  }
}

function kavachParseIsoDate_(text) {
  const parts = String(text).split("-");
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function kavachMonthSheetForDate_(ss, date) {
  const tz = ss.getSpreadsheetTimeZone();
  const keys = [
    Utilities.formatDate(date, tz, "MMM-yy").toUpperCase(),
    Utilities.formatDate(date, tz, "MMMM-yy").toUpperCase(),
    Utilities.formatDate(date, tz, "MMM-yyyy").toUpperCase(),
    Utilities.formatDate(date, tz, "MMMM-yyyy").toUpperCase(),
    /* This book names tabs bare - AUG, JULY - so match those too. A bare name
       carries no year, so it resolves regardless of one; fine while the book
       holds a single year, and the suffixed forms above still take priority. */
    Utilities.formatDate(date, tz, "MMM").toUpperCase(),
    Utilities.formatDate(date, tz, "MMMM").toUpperCase(),
  ];
  const sheets = ss.getSheets().filter((sheet) => isKavachMonthSheet_(sheet.getName()));
  let hit = null;
  sheets.forEach((sheet) => {
    const name = sheet.getName().trim().toUpperCase().replace(/[\s_]+/g, "-");
    if (!hit && keys.indexOf(name) >= 0) {
      hit = sheet;
    }
  });
  return hit;
}

/* Column map for one month sheet. Row 2 holds merged section titles, row 3 the
   sub-headers; merged ranges give the exact span of each section. */
function kavachLayout_(sheet) {
  const key = sheet.getName();
  if (KAVACH_LAYOUT_CACHE[key]) {
    return KAVACH_LAYOUT_CACHE[key];
  }
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const titleRange = sheet.getRange(KAVACH_HEADER_ROW, 1, 1, lastColumn);
  const titles = titleRange.getValues()[0];
  const subs = sheet.getRange(KAVACH_SUB_HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  const groupByColumn = {};
  titleRange.getMergedRanges().forEach((range) => {
    const text = normalizeHeaderText_(range.getValue());
    for (let column = range.getColumn(); column <= range.getLastColumn(); column += 1) {
      groupByColumn[column] = text;
    }
  });
  const columns = [];
  for (let index = 0; index < lastColumn; index += 1) {
    const column = index + 1;
    const group = groupByColumn[column] || normalizeHeaderText_(titles[index]);
    const header = normalizeHeaderText_(subs[index]) || normalizeHeaderText_(titles[index]);
    columns.push({
      index: column,
      group: group,
      header: header,
      label: String(subs[index] || titles[index] || "").replace(/\s+/g, " ").trim(),
    });
  }
  const layout = { sheetName: sheet.getName(), lastColumn: lastColumn, columns: columns };
  KAVACH_LAYOUT_CACHE[key] = layout;
  return layout;
}

/* Displayed cell text for every data row, plus a yyyy-MM-dd key per row. */
function kavachSheetGrid_(sheet, layout, tz) {
  const key = sheet.getName();
  if (KAVACH_GRID_CACHE[key]) {
    return KAVACH_GRID_CACHE[key];
  }
  const rowCount = kavachDataRowCount_(sheet);
  const width = Math.min(layout.lastColumn, kavachReadWidth_());
  const grid = { display: [], dateKeys: [], firstRow: KAVACH_DATA_START_ROW };
  if (rowCount > 0) {
    const range = sheet.getRange(KAVACH_DATA_START_ROW, 1, rowCount, width);
    grid.display = range.getDisplayValues();
    const dateColumn = findKavachDateColumn_(sheet);
    const rawDates = sheet.getRange(KAVACH_DATA_START_ROW, dateColumn, rowCount, 1).getValues();
    let lastKey = "";
    for (let index = 0; index < rowCount; index += 1) {
      const value = rawDates[index][0];
      let dateKey = "";
      if (value instanceof Date) {
        dateKey = Utilities.formatDate(value, tz, "yyyy-MM-dd");
      } else if (String(value || "").trim()) {
        dateKey = kavachNormalizeDateText_(String(value).trim());
      }
      if (dateKey) {
        lastKey = dateKey;
      }
      /* Merged/blank date cells belong to the last dated row above them. */
      grid.dateKeys.push(dateKey || lastKey);
    }
  }
  KAVACH_GRID_CACHE[key] = grid;
  return grid;
}

function kavachNormalizeDateText_(text) {
  const match = String(text).match(/(\d{1,4})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (!match) {
    return "";
  }
  let year = match[1];
  let month = match[2];
  let day = match[3];
  if (String(match[1]).length <= 2) {
    day = match[1];
    year = match[3];
  }
  if (String(year).length === 2) {
    year = `20${year}`;
  }
  return `${year}-${`0${month}`.slice(-2)}-${`0${day}`.slice(-2)}`;
}

/* "DESIRABLE BRAKING" must not match inside "UNDESIRABLE BRAKING", so the hit
   has to start at a word boundary. */
function kavachTitleMatches_(group, needle) {
  const position = group.indexOf(needle);
  if (position < 0) {
    return false;
  }
  return position === 0 || !/[A-Z0-9]/.test(group.charAt(position - 1));
}

function kavachBlockFor_(layout, matchList) {
  for (let index = 0; index < matchList.length; index += 1) {
    const needle = matchList[index];
    const columns = layout.columns.filter((column) => column.group && kavachTitleMatches_(column.group, needle));
    if (columns.length) {
      return { title: columns[0].group, columns: columns };
    }
  }
  return null;
}

function kavachFindColumn_(columns, patterns) {
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    const hit = columns.filter((column) => pattern.test(column.header))[0];
    if (hit) {
      return hit;
    }
  }
  return null;
}

function kavachDayReport_(ss, date, tz) {
  const iso = Utilities.formatDate(date, tz, "yyyy-MM-dd");
  const display = Utilities.formatDate(date, tz, "yyyy-MM-dd");
  const sheet = kavachMonthSheetForDate_(ss, date);
  if (!sheet) {
    return { date: iso, display: display, sheetName: "", found: false, metrics: [], train: null, availability: null };
  }
  const layout = kavachLayout_(sheet);
  const grid = kavachSheetGrid_(sheet, layout, tz);
  const rowIndexes = [];
  grid.dateKeys.forEach((key, index) => {
    if (key === iso) {
      rowIndexes.push(index);
    }
  });
  return {
    date: iso,
    display: display,
    sheetName: sheet.getName(),
    found: true,
    rowCount: rowIndexes.length,
    train: kavachTrainSummary_(layout, grid, rowIndexes),
    metrics: KAVACH_METRICS.map((metric) => kavachMetricReport_(layout, grid, rowIndexes, metric)),
    availability: kavachAvailability_(ss, layout, grid, rowIndexes, tz, date),
  };
}

function kavachDirectionOf_(value) {
  const text = String(value || "").toUpperCase();
  if (!text) {
    return "";
  }
  if (/(^|[^A-Z])UP([^A-Z]|$)|\bU$/.test(text)) {
    return "UP";
  }
  if (/(^|[^A-Z])(DN|DOWN)([^A-Z]|$)|\bD$/.test(text)) {
    return "DN";
  }
  return "";
}

function kavachTrainSummary_(layout, grid, rowIndexes) {
  const block = kavachBlockFor_(layout, KAVACH_TRAIN_MATCH);
  const scope = block ? block.columns : layout.columns;
  const trainColumn = kavachColumnAt_(layout, kavachColumnToIndex_(KAVACH_DETAIL_COLUMNS.trainNo))
    || kavachFindColumn_(scope, [/TRAIN\s*NO/, /^TRAIN$/, /TRAIN\s*NUMBER/]);
  const locoColumn = kavachColumnAt_(layout, kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.loco));
  const directionColumn = KAVACH_REPORT_COLUMNS.direction
    ? kavachColumnAt_(layout, kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.direction))
    : (kavachFindColumn_(scope, [/DIRECTION/, /UP\s*\/?\s*DN/])
      || kavachFindColumn_(layout.columns, [/DIRECTION/, /UP\s*\/?\s*DN/]));
  const makeColumn = kavachMakeColumn_(layout);
  const anchorColumn = locoColumn || trainColumn;
  if (!anchorColumn) {
    return { mapped: false, total: 0, up: 0, dn: 0, makes: [], directionFound: false };
  }

  let total = 0;
  let up = 0;
  let dn = 0;
  const makes = {};
  const allLocos = {};

  rowIndexes.forEach((index) => {
    const row = grid.display[index];
    const anchor = String(row[anchorColumn.index - 1] || "").trim();
    if (!anchor) {
      return;
    }
    total += 1;

    /* UP/DN can sit in its own column, or be a suffix on the train or loco. */
    const candidates = [];
    if (directionColumn) {
      candidates.push(row[directionColumn.index - 1]);
    }
    if (trainColumn) {
      candidates.push(row[trainColumn.index - 1]);
    }
    if (locoColumn) {
      candidates.push(row[locoColumn.index - 1]);
    }
    let direction = "";
    candidates.some((candidate) => {
      direction = kavachDirectionOf_(candidate);
      return Boolean(direction);
    });
    if (direction === "UP") {
      up += 1;
    } else if (direction === "DN") {
      dn += 1;
    }

    const loco = locoColumn ? String(row[locoColumn.index - 1] || "").trim().toUpperCase() : "";
    if (loco) {
      allLocos[loco] = true;
    }
    const make = makeColumn ? String(row[makeColumn.index - 1] || "").trim().toUpperCase() : "";
    const key = make || "UNSPECIFIED";
    if (!makes[key]) {
      makes[key] = { trains: 0, up: 0, dn: 0, locos: {} };
    }
    makes[key].trains += 1;
    if (direction === "UP") {
      makes[key].up += 1;
    } else if (direction === "DN") {
      makes[key].dn += 1;
    }
    if (loco) {
      makes[key].locos[loco] = true;
    }
  });

  return {
    mapped: true,
    total: total,
    up: up,
    dn: dn,
    uniqueLocos: Object.keys(allLocos).length,
    directionFound: Boolean(directionColumn) || up + dn > 0,
    makeFound: Boolean(makeColumn),
    makes: Object.keys(makes).sort().map((name) => ({
      name: name,
      count: makes[name].trains,
      up: makes[name].up,
      dn: makes[name].dn,
      locos: Object.keys(makes[name].locos).length,
    })),
  };
}

function kavachMetricReport_(layout, grid, rowIndexes, metric) {
  const block = kavachResolveBlock_(layout, metric);
  const base = {
    key: metric.key,
    label: metric.label,
    altLabel: metric.altLabel || metric.label,
    tone: metric.tone,
    mapped: Boolean(block),
    section: block ? block.title : "",
    count: 0,
    icms: 0,
    nonIcms: 0,
    columns: [],
    events: [],
  };
  if (!block) {
    return base;
  }
  const override = block.override || {};
  const countColumn = override.count
    ? kavachColumnAt_(layout, kavachColumnToIndex_(override.count))
    : kavachFindColumn_(block.columns, [/^(NO\.?\s*OF|COUNT|TOTAL)\b/]);
  const icmsColumn = override.icms
    ? kavachColumnAt_(layout, kavachColumnToIndex_(override.icms))
    : kavachFindColumn_(block.columns, [/ICMS/]);
  const detailColumns = kavachDetailColumns_(layout, block);
  base.columns = detailColumns.map((column) => column.label || column.header);
  let sum = 0;
  rowIndexes.forEach((index) => {
    const row = grid.display[index];
    const own = block.columns.map((column) => String(row[column.index - 1] || "").trim());
    if (!own.some((value) => value)) {
      return;
    }
    if (countColumn) {
      sum += Number(String(row[countColumn.index - 1] || "").replace(/[^0-9.\-]/g, "")) || 0;
    }
    const icms = icmsColumn ? String(row[icmsColumn.index - 1] || "").trim() : "";
    if (/NON/i.test(icms)) {
      base.nonIcms += 1;
    } else if (/ICMS/i.test(icms)) {
      base.icms += 1;
    }
    base.events.push({
      rowNumber: index + KAVACH_DATA_START_ROW,
      cells: detailColumns.map((column) => String(row[column.index - 1] || "").trim()),
    });
  });
  base.count = countColumn ? sum : base.events.length;
  return base;
}

/* Drill-down columns: train identity first, then the section's own columns, then
   reason and remarks if they sit outside the section. The date is not repeated -
   it is already on the chip above the table. */
function kavachDetailColumns_(layout, block) {
  const override = block.override || {};
  const excluded = (override.exclude || []).map((value) => String(value).trim().toUpperCase());
  const chosen = [];
  const seen = {};

  /* fallbackLabel covers configured columns whose header cell is blank in the
     sheet - without it the table renders a heading-less column. */
  const add = (column, fallbackLabel) => {
    if (!column || seen[column.index]) {
      return;
    }
    const header = String(column.header || "").toUpperCase();
    const letter = kavachIndexToColumn_(column.index);
    const drop = excluded.some((value) => value && (header === value || header.indexOf(value) === 0 || letter === value));
    if (drop) {
      return;
    }
    seen[column.index] = true;
    chosen.push({
      index: column.index,
      header: column.header,
      label: String(column.label || "").trim() || fallbackLabel || "",
    });
  };

  [/TRAIN\s*NO/, /LOCO\s*(ID|NO)/, /^MAKE$/, /LOCO\s*MAKE/, /^SHED$/].forEach((pattern) => {
    add(kavachFindColumn_(layout.columns, [pattern]));
  });
  /* A configured field can sit inside the section itself - keep its fallback
     heading so it does not render as a blank column header. */
  const fallbackByIndex = {};
  if (override.reason) {
    fallbackByIndex[kavachColumnToIndex_(override.reason)] = "Reason";
  }
  if (override.location) {
    fallbackByIndex[kavachColumnToIndex_(override.location)] = override.locationLabel || "Station";
  }
  if (override.remarks) {
    fallbackByIndex[kavachColumnToIndex_(override.remarks)] = "Remarks";
  }
  block.columns.forEach((column) => {
    if (column.header || fallbackByIndex[column.index]) {
      add(column, fallbackByIndex[column.index]);
    }
  });
  if (override.reason) {
    add(kavachColumnAt_(layout, kavachColumnToIndex_(override.reason)), "Reason");
  }
  if (override.location) {
    add(kavachColumnAt_(layout, kavachColumnToIndex_(override.location)), override.locationLabel || "Station");
  }
  if (override.remarks) {
    add(kavachColumnAt_(layout, kavachColumnToIndex_(override.remarks)), "Remarks");
  }
  (override.append || []).forEach((extra) => {
    add(kavachColumnAt_(layout, kavachColumnToIndex_(extra.column)), extra.label);
  });
  return chosen;
}

function kavachAvailability_(ss, layout, grid, rowIndexes, tz, date) {
  const computed = kavachAvailabilityFromHours_(layout, grid, rowIndexes);
  if (computed) {
    return computed;
  }
  const configured = KAVACH_AVAILABILITY.column
    ? kavachColumnAt_(layout, kavachColumnToIndex_(KAVACH_AVAILABILITY.column))
    : null;
  const column = configured || kavachFindColumn_(layout.columns, [/AVAILABILITY/]);
  if (column && rowIndexes.length) {
    for (let index = rowIndexes.length - 1; index >= 0; index -= 1) {
      const value = String(grid.display[rowIndexes[index]][column.index - 1] || "").trim();
      if (value) {
        return /%/.test(value) ? value : `${value}%`;
      }
    }
  }
  return kavachAvailabilityFromSheet_(ss, tz, date);
}

/* availability = ((running hours - down hours) / running hours) x 100 */
function kavachAvailabilityFromHours_(layout, grid, rowIndexes) {
  const runningIndex = kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.runningHours);
  const downIndex = kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.downHours);
  if (!runningIndex || !downIndex || !rowIndexes.length) {
    return null;
  }
  let running = 0;
  let down = 0;
  rowIndexes.forEach((index) => {
    running += kavachDurationToSeconds_(grid.display[index][runningIndex - 1]);
    down += kavachDurationToSeconds_(grid.display[index][downIndex - 1]);
  });
  if (!running) {
    return null;
  }
  return `${(((running - down) / running) * 100).toFixed(2)}%`;
}

function kavachNumber_(value) {
  return Number(String(value === null || value === undefined ? "" : value).replace(/[^0-9.\-]/g, "")) || 0;
}

/* Running and down hours are hh:mm:ss. Anything that is not a clean duration
   (a stray date, a merged label, a typo) is counted as unreadable and skipped
   rather than silently turned into a huge number. */
const KAVACH_DURATION_PATTERN = /^-?\d{1,6}:[0-5]?\d(:[0-5]?\d(\.\d+)?)?$/;
const KAVACH_BARE_HOURS_LIMIT = 1000;

function kavachIsDuration_(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) {
    return true;
  }
  if (KAVACH_DURATION_PATTERN.test(text)) {
    return true;
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Math.abs(Number(text)) <= KAVACH_BARE_HOURS_LIMIT;
  }
  return false;
}

function kavachDurationToSeconds_(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) {
    return 0;
  }
  if (KAVACH_DURATION_PATTERN.test(text)) {
    const sign = text.charAt(0) === "-" ? -1 : 1;
    const parts = text.replace(/^-/, "").split(":");
    const hours = Number(parts[0]) || 0;
    const minutes = Number(parts[1] || 0) || 0;
    const seconds = Number(parts[2] || 0) || 0;
    return sign * (hours * 3600 + minutes * 60 + seconds);
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    return Math.abs(number) <= KAVACH_BARE_HOURS_LIMIT ? number * 3600 : 0;
  }
  return 0;
}

function kavachSecondsToDuration_(total) {
  const rounded = Math.round(Number(total) || 0);
  const sign = rounded < 0 ? "-" : "";
  const absolute = Math.abs(rounded);
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor((absolute % 3600) / 60);
  const seconds = absolute % 60;
  return `${sign}${hours}:${`0${minutes}`.slice(-2)}:${`0${seconds}`.slice(-2)}`;
}

/* Last resort: a date row on the Operational Availability sheet - take the
   percentage cell from the row whose date matches. */
function kavachAvailabilityFromSheet_(ss, tz, date) {
  const sheet = ss.getSheetByName(KAVACH_AVAILABILITY.sheet || "Operational Availability");
  if (!sheet || sheet.getLastRow() < 1) {
    return null;
  }
  const iso = Utilities.formatDate(date, tz, "yyyy-MM-dd");
  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), Math.max(sheet.getLastColumn(), 1))
    .getDisplayValues();
  for (let row = 0; row < values.length; row += 1) {
    const hasDate = values[row].some((cell) => kavachNormalizeDateText_(String(cell || "")) === iso);
    if (!hasDate) {
      continue;
    }
    for (let column = values[row].length - 1; column >= 0; column -= 1) {
      const value = String(values[row][column] || "").trim();
      if (/^\d{1,3}(\.\d+)?\s*%$/.test(value)) {
        return value;
      }
    }
  }
  return null;
}

function kavachExtraTiles_(ss, date, tz) {
  const sheet = kavachMonthSheetForDate_(ss, date);
  if (!sheet) {
    return KAVACH_EXTRA_TILES.map((tile) => ({ key: tile.key, label: tile.label, tone: tile.tone, value: null }));
  }
  const layout = kavachLayout_(sheet);
  const grid = kavachSheetGrid_(sheet, layout, tz);
  const iso = Utilities.formatDate(date, tz, "yyyy-MM-dd");
  const rowIndexes = [];
  grid.dateKeys.forEach((key, index) => {
    if (key === iso) {
      rowIndexes.push(index);
    }
  });
  return KAVACH_EXTRA_TILES.map((tile) => {
    const column = kavachFindColumn_(layout.columns, tile.match);
    if (!column) {
      return { key: tile.key, label: tile.label, tone: tile.tone, value: null };
    }
    let total = 0;
    rowIndexes.forEach((index) => {
      const text = String(grid.display[index][column.index - 1] || "").replace(/[^0-9.\-]/g, "");
      total += Number(text) || 0;
    });
    return { key: tile.key, label: tile.label, tone: tile.tone, value: total };
  });
}

/* Totals across every month sheet - cached, since it reads the whole book. */
function kavachIncidenceSummary_(ss, tz, refresh) {
  const cache = CacheService.getDocumentCache();
  if (!refresh && cache) {
    const cached = cache.get(KAVACH_SUMMARY_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (error) {
        /* fall through and recompute */
      }
    }
  }
  const allSheets = ss.getSheets().filter((sheet) => isKavachMonthSheet_(sheet.getName()));
  const sheets = allSheets.slice(-KAVACH_SUMMARY_MAX_SHEETS);
  const totals = {};
  const reasons = {};
  KAVACH_METRICS.forEach((metric) => {
    totals[metric.key] = { key: metric.key, label: metric.label, tone: metric.tone, count: 0, icms: 0, nonIcms: 0 };
    reasons[metric.key] = {};
  });
  let trainRuns = 0;
  let skipped = 0;
  const started = Date.now();
  const months = [];
  sheets.forEach((sheet) => {
    if (Date.now() - started > KAVACH_SUMMARY_TIME_BUDGET_MS) {
      skipped += 1;
      return;
    }
    const layout = kavachLayout_(sheet);
    const rowCount = kavachDataRowCount_(sheet);
    if (!rowCount) {
      return;
    }
    const values = sheet
      .getRange(KAVACH_DATA_START_ROW, 1, rowCount, Math.min(layout.lastColumn, kavachReadWidth_()))
      .getDisplayValues();
    const allRows = values.map((row, index) => index);
    const trainBlock = kavachBlockFor_(layout, KAVACH_TRAIN_MATCH);
    const trainColumn = kavachFindColumn_(trainBlock ? trainBlock.columns : layout.columns, [
      /TRAIN\s*NO/,
      /^TRAIN$/,
    ]);
    let monthRuns = 0;
    if (trainColumn) {
      values.forEach((row) => {
        if (String(row[trainColumn.index - 1] || "").trim()) {
          monthRuns += 1;
        }
      });
    }
    trainRuns += monthRuns;
    months.push({ sheet: sheet.getName(), runs: monthRuns });
    KAVACH_METRICS.forEach((metric) => {
      const block = kavachResolveBlock_(layout, metric);
      if (!block) {
        return;
      }
      const override = block.override || {};
      const icmsColumn = override.icms
        ? kavachColumnAt_(layout, kavachColumnToIndex_(override.icms))
        : kavachFindColumn_(block.columns, [/ICMS/]);
      const reasonColumn = override.reason
        ? kavachColumnAt_(layout, kavachColumnToIndex_(override.reason))
        : kavachFindColumn_(block.columns, [/REASON/]);
      allRows.forEach((index) => {
        const row = values[index];
        const own = block.columns.map((column) => String(row[column.index - 1] || "").trim());
        if (!own.some((value) => value)) {
          return;
        }
        totals[metric.key].count += 1;
        const icms = icmsColumn ? String(row[icmsColumn.index - 1] || "") : "";
        if (/NON/i.test(icms)) {
          totals[metric.key].nonIcms += 1;
        } else if (/ICMS/i.test(icms)) {
          totals[metric.key].icms += 1;
        }
        if (reasonColumn) {
          const reason = String(row[reasonColumn.index - 1] || "").trim();
          if (reason && isValidReasonMasterText_(reason)) {
            reasons[metric.key][reason] = (reasons[metric.key][reason] || 0) + 1;
          }
        }
      });
    });
  });

  const topReasons = KAVACH_METRICS.map((metric) => {
    const tally = reasons[metric.key];
    const names = Object.keys(tally);
    if (!names.length) {
      return null;
    }
    names.sort((a, b) => tally[b] - tally[a]);
    const total = names.reduce((sum, name) => sum + tally[name], 0);
    return {
      key: metric.key,
      label: metric.label,
      tone: metric.tone,
      reason: names[0],
      count: tally[names[0]],
      share: total ? Math.round((tally[names[0]] / total) * 1000) / 10 : 0,
    };
  }).filter((entry) => entry);

  const summary = {
    generatedAt: Utilities.formatDate(new Date(), tz, "MMM d, yyyy h:mm a"),
    monthSheets: sheets.length - skipped,
    skipped: skipped,
    trainRuns: trainRuns,
    months: months,
    totals: KAVACH_METRICS.map((metric) => totals[metric.key]),
    topReasons: topReasons,
  };
  if (cache) {
    try {
      cache.put(KAVACH_SUMMARY_CACHE_KEY, JSON.stringify(summary), KAVACH_SUMMARY_CACHE_SECONDS);
    } catch (error) {
      /* summary too large to cache - recompute next time */
    }
  }
  return summary;
}

/* ============================================================
   Monthly reports
   ============================================================ */

const KAVACH_MONTH_NAMES = {
  JAN: "January", FEB: "February", MAR: "March", APR: "April", MAY: "May", JUN: "June",
  JUL: "July", AUG: "August", SEP: "September", OCT: "October", NOV: "November", DEC: "December",
};

function kavachMonthLabel_(sheetName) {
  const text = String(sheetName || "").trim().toUpperCase();
  const key = text.slice(0, 3);
  return KAVACH_MONTH_NAMES[key] || sheetName;
}

/* One read per month sheet, covering only the report columns. */
function kavachReportRows_(sheet) {
  const indexes = {
    loco: kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.loco),
    km: kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.km),
    running: kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.runningHours),
    down: kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.downHours),
    modeChange: kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.modeChange),
    reason: kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.modeReason),
  };
  const used = Object.keys(indexes).map((key) => indexes[key]).filter((value) => value > 0);
  const first = Math.min.apply(null, used);
  const last = Math.max.apply(null, used);
  const rowCount = kavachDataRowCount_(sheet);
  if (!rowCount) {
    return { rows: [], indexes: indexes, first: first };
  }
  const values = sheet
    .getRange(KAVACH_DATA_START_ROW, first, rowCount, last - first + 1)
    .getDisplayValues();
  return { rows: values, indexes: indexes, first: first };
}

function kavachCell_(row, indexes, key, first) {
  const index = indexes[key];
  if (!index) {
    return "";
  }
  return String(row[index - first] || "").trim();
}

function kavachIsPositive_(value) {
  return KAVACH_NEGATIVE_VALUES.indexOf(String(value || "").trim().toUpperCase()) < 0;
}

function kavachMonthSheetsForReport_(ss) {
  return ss.getSheets().filter((sheet) => isKavachMonthSheet_(sheet.getName()));
}

function kavachModeChangeReport_(sheets) {
  const months = [];
  const reasonTotals = {};
  const started = Date.now();
  sheets.forEach((sheet) => {
    if (Date.now() - started > KAVACH_SUMMARY_TIME_BUDGET_MS) {
      return;
    }
    const read = kavachReportRows_(sheet);
    const locos = {};
    const modeLocos = {};
    let trips = 0;
    let withMode = 0;
    const reasons = {};
    read.rows.forEach((row) => {
      const loco = kavachCell_(row, read.indexes, "loco", read.first);
      const modeChange = kavachCell_(row, read.indexes, "modeChange", read.first);
      const reason = kavachCell_(row, read.indexes, "reason", read.first);
      if (loco) {
        trips += 1;
        locos[loco.toUpperCase()] = true;
      }
      if (kavachIsPositive_(modeChange) && modeChange) {
        withMode += 1;
      }
      if (reason && kavachIsPositive_(reason) && isValidReasonMasterText_(reason)) {
        reasons[reason] = (reasons[reason] || 0) + 1;
        reasonTotals[reason] = (reasonTotals[reason] || 0) + 1;
        if (loco) {
          modeLocos[loco.toUpperCase()] = true;
        }
      }
    });
    const uniqueLocos = Object.keys(locos).length;
    const modeLocoCount = Object.keys(modeLocos).length;
    months.push({
      label: kavachMonthLabel_(sheet.getName()),
      sheet: sheet.getName(),
      trips: trips,
      withMode: withMode,
      withoutMode: Math.max(trips - withMode, 0),
      uniqueLocos: uniqueLocos,
      modeLocoCount: modeLocoCount,
      noModeLocoCount: Math.max(uniqueLocos - modeLocoCount, 0),
      reasons: reasons,
    });
  });

  const rows = [
    { item: "Total Trips Travelled", values: months.map((month) => month.trips) },
    { item: "Trips with Mode Change", values: months.map((month) => month.withMode) },
    { item: "Trips without Mode Change", values: months.map((month) => month.withoutMode) },
    { item: "Total Unique Locos Travelled", values: months.map((month) => month.uniqueLocos) },
    { item: "Mode Change Observed Loco Count", values: months.map((month) => month.modeLocoCount) },
    { item: "No Mode Change Observed Loco Count", values: months.map((month) => month.noModeLocoCount) },
  ];
  Object.keys(reasonTotals)
    .sort((a, b) => reasonTotals[b] - reasonTotals[a])
    .forEach((reason) => {
      rows.push({ item: reason, values: months.map((month) => month.reasons[reason] || 0) });
    });

  return {
    type: "modeChange",
    title: "Mode Change Status",
    fileName: `KAVACH_MODE_CHANGE_STATUS_${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd_MM_yyyy")}.csv`,
    columns: months.map((month) => month.label),
    rows: rows.map((row, index) => ({ sno: index + 1, item: row.item, values: row.values })),
  };
}

function kavachSummaryReport_(sheets) {
  const months = [];
  const started = Date.now();
  sheets.forEach((sheet) => {
    if (Date.now() - started > KAVACH_SUMMARY_TIME_BUDGET_MS) {
      return;
    }
    const read = kavachReportRows_(sheet);
    let running = 0;
    let down = 0;
    let km = 0;
    let runs = 0;
    let unreadable = 0;
    read.rows.forEach((row) => {
      if (kavachCell_(row, read.indexes, "loco", read.first)) {
        runs += 1;
      }
      const runningCell = kavachCell_(row, read.indexes, "running", read.first);
      const downCell = kavachCell_(row, read.indexes, "down", read.first);
      if (!kavachIsDuration_(runningCell) || !kavachIsDuration_(downCell)) {
        unreadable += 1;
      }
      running += kavachDurationToSeconds_(runningCell);
      down += kavachDurationToSeconds_(downCell);
      km += kavachNumber_(kavachCell_(row, read.indexes, "km", read.first));
    });
    months.push({
      label: kavachMonthLabel_(sheet.getName()),
      sheet: sheet.getName(),
      running: running,
      down: down,
      km: km,
      runs: runs,
      unreadable: unreadable,
    });
  });

  const rows = [
    { item: "Total Running Hours of all Trains", values: months.map((month) => kavachSecondsToDuration_(month.running)) },
    { item: "Total Down Hours", values: months.map((month) => kavachSecondsToDuration_(month.down)) },
    { item: "Total Train Runs (UP + DN)", values: months.map((month) => month.runs) },
    {
      item: "Average Running Hours",
      values: months.map((month) => (month.runs ? kavachSecondsToDuration_(month.running / month.runs) : "-")),
    },
    {
      item: "Average running Km / Actual Section Km",
      values: months.map((month) => (month.runs ? (month.km / month.runs).toFixed(2) : "-")),
    },
    {
      item: "Operational Availability",
      values: months.map((month) =>
        month.running ? `${(((month.running - month.down) / month.running) * 100).toFixed(2)}%` : "-"
      ),
    },
  ];

  const flagged = months.filter((month) => month.unreadable);
  return {
    type: "summary",
    title: "Summary",
    fileName: `KAVACH_SUMMARY_${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd_MM_yyyy")}.csv`,
    columns: months.map((month) => month.label),
    rows: rows.map((row, index) => ({ sno: index + 1, item: row.item, values: row.values })),
    notes: flagged.length
      ? [
        `Skipped cells that are not valid hh:mm:ss in ${KAVACH_REPORT_COLUMNS.runningHours}/`
        + `${KAVACH_REPORT_COLUMNS.downHours}: `
        + flagged.map((month) => `${month.sheet} (${month.unreadable} rows)`).join(", ")
        + ". Open ?action=columns&sheet=<tab> to see the offending values.",
      ]
      : [],
  };
}

function kavachIndexToColumn_(index) {
  let text = "";
  let remaining = Number(index) || 0;
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    text = String.fromCharCode(65 + remainder) + text;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return text;
}

/* Lists every column in a range with its two header rows and a few real values,
   plus any cell in the hours columns that is not a readable duration. */
function kavachInspectColumns(options) {
  const settings = options || {};
  const ss = kavachSpreadsheet_();
  const sheet = settings.sheet
    ? ss.getSheetByName(settings.sheet)
    : kavachMonthSheetsForReport_(ss)[0];
  if (!sheet) {
    return { error: `Sheet not found: ${settings.sheet || "(first month sheet)"}` };
  }
  const from = kavachColumnToIndex_(settings.from || "Y");
  const to = Math.min(kavachColumnToIndex_(settings.to || "AT"), sheet.getLastColumn());
  if (!from || to < from) {
    return { error: "Bad column range." };
  }
  const width = to - from + 1;
  const titles = sheet.getRange(KAVACH_HEADER_ROW, from, 1, width).getDisplayValues()[0];
  const subs = sheet.getRange(KAVACH_SUB_HEADER_ROW, from, 1, width).getDisplayValues()[0];
  const rowCount = kavachDataRowCount_(sheet);
  const samples = rowCount
    ? sheet.getRange(KAVACH_DATA_START_ROW, from, Math.min(rowCount, 8), width).getDisplayValues()
    : [];
  const columns = [];
  for (let offset = 0; offset < width; offset += 1) {
    columns.push({
      letter: kavachIndexToColumn_(from + offset),
      title: String(titles[offset] || "").trim(),
      header: String(subs[offset] || "").trim(),
      samples: samples
        .map((row) => String(row[offset] || "").trim())
        .filter((value) => value)
        .slice(0, 3),
    });
  }
  return {
    sheet: sheet.getName(),
    dataRows: rowCount,
    columns: columns,
    durations: kavachDurationAudit_(sheet),
  };
}

function kavachDurationAudit_(sheet) {
  const audit = {};
  ["runningHours", "downHours"].forEach((key) => {
    const letter = KAVACH_REPORT_COLUMNS[key];
    const index = kavachColumnToIndex_(letter);
    const rowCount = kavachDataRowCount_(sheet);
    if (!index || !rowCount) {
      return;
    }
    const values = sheet.getRange(KAVACH_DATA_START_ROW, index, rowCount, 1).getDisplayValues();
    const bad = {};
    let badRows = 0;
    values.forEach((row, offset) => {
      const text = String(row[0] || "").trim();
      if (text && !kavachIsDuration_(text)) {
        badRows += 1;
        const label = `${text} (row ${offset + KAVACH_DATA_START_ROW})`;
        bad[text] = bad[text] || label;
      }
    });
    audit[key] = {
      column: letter,
      unreadableCells: badRows,
      examples: Object.keys(bad).slice(0, 10).map((text) => bad[text]),
    };
  });
  return audit;
}

/* ============================================================
   Date range summary, by OEM
   ============================================================ */

function kavachMakeColumn_(layout) {
  if (KAVACH_REPORT_COLUMNS.make) {
    return kavachColumnAt_(layout, kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.make));
  }
  return kavachFindColumn_(layout.columns, [/^LOCO\s*MAKE$/, /^MAKE$/, /\bMAKE\b/]);
}

function kavachSheetMonthValue_(name) {
  const match = String(name || "").trim().toUpperCase().match(/^([A-Z]+)[\s_-]*(\d{2,4})$/);
  if (!match) {
    return null;
  }
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const month = months.indexOf(match[1].slice(0, 3));
  if (month < 0) {
    return null;
  }
  const year = Number(match[2]) < 100 ? Number(match[2]) + 2000 : Number(match[2]);
  return year * 12 + month;
}

/* Only the month tabs the range actually touches get read. */
function kavachSheetsInRange_(ss, fromKey, toKey) {
  const from = kavachParseIsoDate_(fromKey);
  const to = kavachParseIsoDate_(toKey);
  const start = from.getFullYear() * 12 + from.getMonth();
  const end = to.getFullYear() * 12 + to.getMonth();
  return kavachMonthSheetsForReport_(ss).filter((sheet) => {
    const value = kavachSheetMonthValue_(sheet.getName());
    return value === null || (value >= start && value <= end);
  });
}

function kavachRangeReport(options) {
  const settings = options || {};
  kavachApplyConfig_();
  const first = String(settings.from || "").trim();
  const second = String(settings.to || "").trim();
  if (!first || !second) {
    throw new Error("Pick both a from and a to date.");
  }
  const fromKey = first <= second ? first : second;
  const toKey = first <= second ? second : first;
  const makeFilter = String(settings.make || "").trim().toUpperCase();

  const ss = kavachSpreadsheet_();
  const tz = ss.getSpreadsheetTimeZone();
  const sheets = kavachSheetsInRange_(ss, fromKey, toKey);
  const makes = {};
  const locos = {};
  let running = 0;
  let down = 0;
  let km = 0;
  let runs = 0;
  let unreadable = 0;
  const started = Date.now();

  sheets.forEach((sheet) => {
    if (Date.now() - started > KAVACH_SUMMARY_TIME_BUDGET_MS) {
      return;
    }
    const layout = kavachLayout_(sheet);
    const rowCount = kavachDataRowCount_(sheet);
    if (!rowCount) {
      return;
    }
    const values = sheet
      .getRange(KAVACH_DATA_START_ROW, 1, rowCount, Math.min(layout.lastColumn, kavachReadWidth_()))
      .getDisplayValues();
    const dateColumn = findKavachDateColumn_(sheet);
    const rawDates = sheet.getRange(KAVACH_DATA_START_ROW, dateColumn, rowCount, 1).getValues();
    const makeColumn = kavachMakeColumn_(layout);
    const locoIndex = kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.loco);
    const runningIndex = kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.runningHours);
    const downIndex = kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.downHours);
    const kmIndex = kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.km);
    let lastKey = "";

    for (let offset = 0; offset < rowCount; offset += 1) {
      const value = rawDates[offset][0];
      let key = value instanceof Date
        ? Utilities.formatDate(value, tz, "yyyy-MM-dd")
        : kavachNormalizeDateText_(String(value || ""));
      if (key) {
        lastKey = key;
      } else {
        key = lastKey;
      }
      if (!key || key < fromKey || key > toKey) {
        continue;
      }
      const row = values[offset];
      const make = makeColumn ? String(row[makeColumn.index - 1] || "").trim().toUpperCase() : "";
      if (make) {
        makes[make] = (makes[make] || 0) + 1;
      }
      if (makeFilter && make !== makeFilter) {
        continue;
      }
      const loco = locoIndex ? String(row[locoIndex - 1] || "").trim() : "";
      if (loco) {
        runs += 1;
        locos[loco.toUpperCase()] = true;
      }
      const runningCell = runningIndex ? row[runningIndex - 1] : "";
      const downCell = downIndex ? row[downIndex - 1] : "";
      if (!kavachIsDuration_(runningCell) || !kavachIsDuration_(downCell)) {
        unreadable += 1;
      }
      running += kavachDurationToSeconds_(runningCell);
      down += kavachDurationToSeconds_(downCell);
      km += kmIndex ? kavachNumber_(row[kmIndex - 1]) : 0;
    }
  });

  const label = makeFilter || "All OEMs";
  const rows = [
    { item: "Total Running Hours of all Trains", value: kavachSecondsToDuration_(running) },
    { item: "Total Down Hours", value: kavachSecondsToDuration_(down) },
    { item: "Total Train Runs (UP + DN)", value: runs },
    { item: "Total Unique Locos Travelled", value: Object.keys(locos).length },
    { item: "Average Running Hours", value: runs ? kavachSecondsToDuration_(running / runs) : "-" },
    { item: "Average running Km / Actual Section Km", value: runs ? (km / runs).toFixed(2) : "-" },
    { item: "Total Running Km", value: km.toFixed(2) },
    {
      item: "Operational Availability",
      value: running ? `${(((running - down) / running) * 100).toFixed(2)}%` : "-",
    },
  ];

  return {
    type: "range",
    title: "Date range summary",
    from: fromKey,
    to: toKey,
    make: makeFilter,
    sheetsRead: sheets.map((sheet) => sheet.getName()),
    makes: Object.keys(makes).sort().map((name) => ({ name: name, count: makes[name] })),
    makeColumnFound: sheets.length ? Boolean(kavachMakeColumn_(kavachLayout_(sheets[0]))) : false,
    fileName: `KAVACH_SUMMARY_${label.replace(/[^A-Z0-9]+/gi, "_")}_${fromKey}_to_${toKey}.csv`,
    columns: [label],
    rows: rows.map((row, index) => ({ sno: index + 1, item: row.item, values: [row.value] })),
    notes: unreadable
      ? [`${unreadable} row(s) in the range have an unreadable value in ${KAVACH_REPORT_COLUMNS.runningHours}/`
        + `${KAVACH_REPORT_COLUMNS.downHours} and were skipped in the hour totals.`]
      : [],
  };
}

/* ============================================================
   Row-level report: mode change / brake application / both
   ============================================================ */

function kavachRangeIndexes_(letters) {
  const parts = String(letters || "").split(":");
  const start = kavachColumnToIndex_(parts[0]);
  const end = parts.length > 1 ? kavachColumnToIndex_(parts[1]) : start;
  return start && end && end >= start ? { start: start, end: end } : null;
}

function kavachRowHasData_(row, span) {
  if (!span) {
    return false;
  }
  for (let column = span.start; column <= span.end; column += 1) {
    if (String(row[column - 1] || "").trim()) {
      return true;
    }
  }
  return false;
}

function kavachDetailCell_(row, letter) {
  const index = kavachColumnToIndex_(letter);
  return index ? String(row[index - 1] || "").trim() : "";
}

/* Column order follows the spec: Date, Time, Loco No, Train No, [OEM Make],
   type column(s), AbsLoc, Reason, Remarks, Type of failure. OEM Make is only
   included when more than one make is in play. */
function kavachDetailColumnPlan_(reportType, showMake) {
  const columns = [
    { key: "date", label: "Date" },
    { key: "loco", label: "Loco No" },
    { key: "train", label: "Train No" },
  ];
  if (showMake) {
    columns.push({ key: "make", label: "OEM Make" });
  }
  /* Location replaces the old "Type of Mode Change" slot: mode change location
     for mode reports, brake intervention station for brake reports. */
  const locationLabel = reportType === "mode"
    ? "Mode Change Location"
    : (reportType === "brake" ? "Brake Intervention Station" : "Location / Station");
  columns.push({ key: "location", label: locationLabel });
  if (reportType === "brake" || reportType === "both") {
    columns.push({ key: "brakeType", label: "Type of Brake" });
  }
  columns.push({ key: "absLoc", label: "AbsLoc" });
  columns.push({ key: "reason", label: "Reason" });
  columns.push({ key: "remarks", label: "Remarks" });
  columns.push({ key: "failureType", label: "Type of Failure" });
  return columns;
}

/* Tag Miss rows across a date range - same columns as the Today Status
   drill-down, with Date added in front. */
function kavachTagMissReport_(ss, tz, fromKey, toKey, wanted) {
  const sheets = kavachSheetsInRange_(ss, fromKey, toKey);
  const metric = KAVACH_METRICS.filter((item) => item.key === "rfidMissing")[0];
  const span = kavachRangeIndexes_((KAVACH_SECTION_OVERRIDES.rfidMissing || {}).columns);
  const makes = {};
  const rows = [];
  let labels = null;
  let truncated = false;
  const started = Date.now();

  sheets.forEach((sheet) => {
    if (truncated || !metric || Date.now() - started > KAVACH_SUMMARY_TIME_BUDGET_MS) {
      return;
    }
    const layout = kavachLayout_(sheet);
    const rowCount = kavachDataRowCount_(sheet);
    const block = kavachResolveBlock_(layout, metric);
    if (!rowCount || !block) {
      return;
    }
    const detailColumns = kavachDetailColumns_(layout, block);
    if (!labels) {
      labels = detailColumns.map((column) => column.label || column.header || "");
    }
    const values = sheet
      .getRange(KAVACH_DATA_START_ROW, 1, rowCount, Math.min(layout.lastColumn, kavachReadWidth_()))
      .getDisplayValues();
    const dateColumn = findKavachDateColumn_(sheet);
    const rawDates = sheet.getRange(KAVACH_DATA_START_ROW, dateColumn, rowCount, 1).getValues();
    const makeColumn = kavachMakeColumn_(layout);

    /* Identity columns are written once per group, so carry them down. */
    const carry = {};
    [
      kavachColumnToIndex_(KAVACH_DETAIL_COLUMNS.trainNo),
      kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.loco),
      makeColumn ? makeColumn.index : 0,
    ].forEach((index) => {
      if (index) {
        carry[index] = "";
      }
    });

    let lastKey = "";
    for (let offset = 0; offset < rowCount; offset += 1) {
      if (rows.length >= KAVACH_DETAIL_MAX_ROWS) {
        truncated = true;
        return;
      }
      const row = values[offset];
      Object.keys(carry).forEach((index) => {
        const value = String(row[Number(index) - 1] || "").trim();
        if (value) {
          carry[index] = value;
        }
      });

      const value = rawDates[offset][0];
      let key = value instanceof Date
        ? Utilities.formatDate(value, tz, "yyyy-MM-dd")
        : kavachNormalizeDateText_(String(value || ""));
      if (key) {
        lastKey = key;
      } else {
        key = lastKey;
      }
      if (!key || key < fromKey || key > toKey || !kavachRowHasData_(row, span)) {
        continue;
      }

      const make = makeColumn
        ? (String(row[makeColumn.index - 1] || "").trim().toUpperCase() || carry[makeColumn.index] || "")
        : "";
      if (make) {
        makes[make] = (makes[make] || 0) + 1;
      }
      if (wanted.length && wanted.indexOf(make) < 0) {
        continue;
      }

      /* `make` is not rendered (the columns are c0..cN) but the OEM filter on
         the page reads it, so every row has to carry it. */
      const record = { c0: key, make: make };
      detailColumns.forEach((column, position) => {
        const cell = String(row[column.index - 1] || "").trim();
        record[`c${position + 1}`] = cell || carry[column.index] || "";
      });
      rows.push(record);
    }
  });

  const columnLabels = ["Date"].concat(labels || []);
  return {
    type: "detail",
    reportType: "tag",
    title: "Tag Miss",
    from: fromKey,
    to: toKey,
    makes: Object.keys(makes).sort().map((name) => ({ name: name, count: makes[name] })),
    selectedMakes: wanted,
    showMake: false,
    truncated: truncated,
    sheetsRead: sheets.map((sheet) => sheet.getName()),
    makeColumnFound: true,
    unmapped: [],
    fileName: `KAVACH_ADDITIONAL_REPORT_Tag_Miss_${fromKey}_to_${toKey}.csv`,
    columns: columnLabels,
    keys: columnLabels.map((label, index) => `c${index}`),
    rows: rows,
  };
}

function kavachDetailReport(options) {
  const settings = options || {};
  kavachApplyConfig_();
  const first = String(settings.from || "").trim();
  const second = String(settings.to || "").trim();
  if (!first || !second) {
    throw new Error("Pick both a from and a to date.");
  }
  const fromKey = first <= second ? first : second;
  const toKey = first <= second ? second : first;
  const requested = String(settings.report || "mode").toLowerCase();
  const reportType = ["mode", "brake", "both", "tag"].indexOf(requested) >= 0 ? requested : "mode";
  const wanted = (settings.makes || [])
    .map((make) => String(make).trim().toUpperCase())
    .filter((make) => make);

  const ss = kavachSpreadsheet_();
  const tz = ss.getSpreadsheetTimeZone();
  if (reportType === "tag") {
    return kavachTagMissReport_(ss, tz, fromKey, toKey, wanted);
  }
  const sheets = kavachSheetsInRange_(ss, fromKey, toKey);
  const modeSource = KAVACH_DETAIL_COLUMNS.mode || {};
  /* Brake application can be narrowed to one kind. When it is, the Type of
     Brake value drops its "(Undesirable)" / "(Desirable)" tag. */
  const requestedKind = String(settings.brakeKind || "").toLowerCase();
  const brakeKind = ["undesirable", "desirable"].indexOf(requestedKind) >= 0 ? requestedKind : "";
  const brakeGroups = [
    (KAVACH_DETAIL_COLUMNS.brake || {}).undesirable,
    (KAVACH_DETAIL_COLUMNS.brake || {}).desirable,
  ].filter((group) => group && group.section
    && (!brakeKind || String(group.label).toLowerCase() === brakeKind));
  const brakeSpans = brakeGroups.map((group) => kavachRangeIndexes_(group.section));
  const makes = {};
  const rows = [];
  let truncated = false;
  const started = Date.now();

  sheets.forEach((sheet) => {
    if (truncated || Date.now() - started > KAVACH_SUMMARY_TIME_BUDGET_MS) {
      return;
    }
    const layout = kavachLayout_(sheet);
    const rowCount = kavachDataRowCount_(sheet);
    if (!rowCount) {
      return;
    }
    const values = sheet
      .getRange(KAVACH_DATA_START_ROW, 1, rowCount, Math.min(layout.lastColumn, kavachReadWidth_()))
      .getDisplayValues();
    const dateColumn = findKavachDateColumn_(sheet);
    const rawDates = sheet.getRange(KAVACH_DATA_START_ROW, dateColumn, rowCount, 1).getValues();
    const makeColumn = kavachMakeColumn_(layout);
    const locoIndex = kavachColumnToIndex_(KAVACH_REPORT_COLUMNS.loco);
    let lastKey = "";
    let lastLoco = "";
    let lastTrain = "";
    let lastMake = "";

    for (let offset = 0; offset < rowCount; offset += 1) {
      if (rows.length >= KAVACH_DETAIL_MAX_ROWS) {
        truncated = true;
        return;
      }
      const value = rawDates[offset][0];
      let key = value instanceof Date
        ? Utilities.formatDate(value, tz, "yyyy-MM-dd")
        : kavachNormalizeDateText_(String(value || ""));
      if (key) {
        lastKey = key;
      } else {
        key = lastKey;
      }
      if (!key || key < fromKey || key > toKey) {
        continue;
      }
      const row = values[offset];

      /* Loco, train and make are written once per group and left blank on the
         following event rows - carry the last value down so the report is not
         full of gaps. Counting elsewhere still treats a blank loco as "not a
         new run", so totals are unaffected. */
      const locoRaw = locoIndex ? String(row[locoIndex - 1] || "").trim() : "";
      if (locoRaw) {
        lastLoco = locoRaw;
      }
      const trainRaw = kavachDetailCell_(row, KAVACH_DETAIL_COLUMNS.trainNo);
      if (trainRaw) {
        lastTrain = trainRaw;
      }
      const makeRaw = makeColumn ? String(row[makeColumn.index - 1] || "").trim().toUpperCase() : "";
      if (makeRaw) {
        lastMake = makeRaw;
      }

      const modeType = kavachDetailCell_(row, modeSource.type);
      const hasMode = Boolean(modeType) && kavachIsPositive_(modeType);
      const activeBrakes = brakeGroups.filter((group, position) => kavachRowHasData_(row, brakeSpans[position]));
      const hasBrake = activeBrakes.length > 0;
      const keep = (reportType === "mode" && hasMode)
        || (reportType === "brake" && hasBrake)
        || (reportType === "both" && (hasMode || hasBrake));
      if (!keep) {
        continue;
      }

      const make = makeRaw || lastMake;
      if (make) {
        makes[make] = (makes[make] || 0) + 1;
      }
      if (wanted.length && wanted.indexOf(make) < 0) {
        continue;
      }

      /* Pull each field from whichever side of the row applies. A "both" report
         on a row with a mode change and a brake shows both, joined. */
      const sources = [];
      if (hasMode && reportType !== "brake") {
        sources.push(modeSource);
      }
      if (reportType !== "mode") {
        activeBrakes.forEach((group) => sources.push(group));
      }
      const pick = (field) => {
        const parts = [];
        sources.forEach((source) => {
          const value = kavachDetailCell_(row, source[field]);
          if (value && parts.indexOf(value) < 0) {
            parts.push(value);
          }
        });
        return parts.join(" | ");
      };

      /* "AD value (Undesirable)" / "AK value (Desirable)" - untagged when the
         report is already narrowed to one kind. */
      const brakeType = reportType === "mode"
        ? ""
        : activeBrakes.map((group) => {
          const value = kavachDetailCell_(row, group.type);
          if (!value) {
            return group.label;
          }
          return brakeKind ? value : `${value} (${group.label})`;
        }).join(" | ");

      rows.push({
        date: key,
        loco: locoRaw || lastLoco,
        train: trainRaw || lastTrain,
        make: make,
        location: pick("location"),
        brakeType: brakeType,
        absLoc: pick("absLoc"),
        reason: pick("reason"),
        remarks: pick("remarks"),
        failureType: pick("failureType"),
      });
    }
  });

  const makeList = Object.keys(makes).sort().map((name) => ({ name: name, count: makes[name] }));
  const distinctInResult = {};
  rows.forEach((row) => {
    if (row.make) {
      distinctInResult[row.make] = true;
    }
  });
  const showMake = Object.keys(distinctInResult).length > 1;
  const plan = kavachDetailColumnPlan_(reportType, showMake);
  const kindLabel = brakeKind ? `${brakeKind.charAt(0).toUpperCase()}${brakeKind.slice(1)}` : "";
  const titles = {
    mode: "Mode change",
    brake: kindLabel ? `Brake application - ${kindLabel}` : "Brake application",
    both: "Brake application and Mode change",
  };

  return {
    type: "detail",
    reportType: reportType,
    brakeKind: brakeKind,
    title: titles[reportType],
    from: fromKey,
    to: toKey,
    makes: makeList,
    selectedMakes: wanted,
    showMake: showMake,
    truncated: truncated,
    sheetsRead: sheets.map((sheet) => sheet.getName()),
    makeColumnFound: sheets.length ? Boolean(kavachMakeColumn_(kavachLayout_(sheets[0]))) : false,
    unmapped: kavachUnmappedDetailFields_(reportType),
    fileName: `KAVACH_ADDITIONAL_REPORT_${titles[reportType].replace(/[^A-Za-z]+/g, "_")}`
      + `_${fromKey}_to_${toKey}.csv`,
    columns: plan.map((column) => column.label),
    keys: plan.map((column) => column.key),
    rows: rows,
  };
}

function kavachUnmappedDetailFields_(reportType) {
  const missing = [];
  if (!KAVACH_DETAIL_COLUMNS.trainNo) {
    missing.push("Train No");
  }
  const check = (source, prefix, fields) => {
    fields.forEach((field) => {
      if (!source[field]) {
        missing.push(`${prefix} ${field}`);
      }
    });
  };
  if (reportType !== "brake") {
    check(KAVACH_DETAIL_COLUMNS.mode || {}, "mode change:", ["reason", "absLoc", "remarks", "failureType", "location"]);
  }
  if (reportType !== "mode") {
    const brake = KAVACH_DETAIL_COLUMNS.brake || {};
    ["undesirable", "desirable"].forEach((name) => {
      if (brake[name]) {
        check(brake[name], `${name} brake:`, ["type", "reason", "absLoc", "remarks", "failureType", "location"]);
      }
    });
  }
  return missing;
}

function kavachDetailToCsv_(report) {
  const lines = [["S.No"].concat(report.columns).map(kavachCsvCell_).join(",")];
  report.rows.forEach((row, index) => {
    const cells = report.keys.map((key) => row[key]);
    lines.push([index + 1].concat(cells).map(kavachCsvCell_).join(","));
  });
  return lines.join("\r\n");
}

function kavachReportData(type) {
  kavachApplyConfig_();
  const ss = kavachSpreadsheet_();
  const sheets = kavachMonthSheetsForReport_(ss);
  return String(type) === "summary" ? kavachSummaryReport_(sheets) : kavachModeChangeReport_(sheets);
}

function kavachReportToCsv_(report) {
  const lines = [];
  lines.push(["S.No", "Item"].concat(report.columns).map(kavachCsvCell_).join(","));
  report.rows.forEach((row) => {
    lines.push([row.sno, row.item].concat(row.values).map(kavachCsvCell_).join(","));
  });
  return lines.join("\r\n");
}

function kavachCsvCell_(value) {
  const text = String(value === null || value === undefined ? "" : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/* Run from the menu (or ?action=headers) to see exactly what the script found.
   Paste this output when a tile shows "not mapped". */
function kavachInspectHeaders() {
  KAVACH_LAYOUT_CACHE = {};
  const ss = kavachSpreadsheet_();
  const sheets = ss.getSheets().filter((sheet) => isKavachMonthSheet_(sheet.getName()));
  if (!sheets.length) {
    return { error: "No month sheets found." };
  }
  const sheet = sheets[0];
  const layout = kavachLayout_(sheet);
  const sections = [];
  layout.columns.forEach((column) => {
    const last = sections[sections.length - 1];
    if (last && last.section === column.group) {
      last.columns.push(column.label);
      return;
    }
    sections.push({ section: column.group, startColumn: column.index, columns: [column.label] });
  });
  const mapping = KAVACH_METRICS.map((metric) => {
    const block = kavachResolveBlock_(layout, metric);
    return {
      metric: metric.label,
      matchedSection: block ? block.title : "NOT MAPPED",
      columns: block ? `${block.columns[0].index}-${block.columns[block.columns.length - 1].index}` : "",
    };
  });
  const trainBlock = kavachBlockFor_(layout, KAVACH_TRAIN_MATCH);
  mapping.push({ metric: "Total Train", matchedSection: trainBlock ? trainBlock.title : "NOT MAPPED" });
  const availabilityColumn = KAVACH_AVAILABILITY.column
    ? kavachColumnAt_(layout, kavachColumnToIndex_(KAVACH_AVAILABILITY.column))
    : kavachFindColumn_(layout.columns, [/AVAILABILITY/]);
  const downColumn = kavachFindColumn_(layout.columns, [/DOWN\s*(HOUR|TIME)/, /LOSS\s*(HOUR|TIME)/]);
  const hoursColumn = kavachFindColumn_(layout.columns, [/TRAIN\s*HOUR/, /TOTAL\s*HOUR/, /RUN\s*HOUR/]);
  return {
    sheet: sheet.getName(),
    dateColumn: findKavachDateColumn_(sheet),
    sections: sections,
    mapping: mapping,
    availability: {
      column: availabilityColumn ? `col ${availabilityColumn.index} (${availabilityColumn.label})` : "NOT FOUND",
      downHours: downColumn ? `col ${downColumn.index}` : "NOT FOUND",
      trainHours: hoursColumn ? `col ${hoursColumn.index}` : "NOT FOUND",
      fallbackSheet: kavachSpreadsheet_().getSheetByName(KAVACH_AVAILABILITY.sheet || "Operational Availability")
        ? "present"
        : "missing",
    },
  };
}

function showKavachHeaderMap() {
  const layout = kavachInspectHeaders();
  const lines = [`Sheet: ${layout.sheet}`, `Date column: ${layout.dateColumn}`, "", "SECTIONS"];
  (layout.sections || []).forEach((section) => {
    lines.push(`- ${section.section || "(blank)"} @ col ${section.startColumn}: ${section.columns.join(" | ")}`);
  });
  lines.push("", "TILE MAPPING");
  (layout.mapping || []).forEach((entry) => {
    lines.push(`- ${entry.metric} -> ${entry.matchedSection}${entry.columns ? ` [cols ${entry.columns}]` : ""}`);
  });
  const availability = layout.availability || {};
  lines.push("", "AVAILABILITY");
  lines.push(`- column: ${availability.column}`);
  lines.push(`- down hours: ${availability.downHours} | train hours: ${availability.trainHours}`);
  lines.push(`- fallback sheet: ${availability.fallbackSheet}`);
  const text = lines.join("\n");
  Logger.log(text);
  try {
    SpreadsheetApp.getUi().alert(text.slice(0, 1400));
  } catch (error) {
    /* no UI context */
  }
  return text;
}

/* ============================================================
   Change log / reason master readers
   ============================================================ */

function readKavachReasonMaster_() {
  const sheet = kavachSpreadsheet_().getSheetByName(KAVACH_REASON_MASTER_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }
  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, KAVACH_REASON_MASTER_HEADERS.length)
    .getValues()
    .map((row) => ({
      sectionTitle: String(row[0] || ""),
      metric: String(row[1] || ""),
      reason: String(row[2] || ""),
      sourceColumn: String(row[3] || ""),
      updatedAt: row[4] ? new Date(row[4]).toISOString() : "",
    }))
    .filter((item) => item.reason);
}

function readKavachChangeLog_(limit) {
  const sheet = kavachSpreadsheet_().getSheetByName(KAVACH_CHANGE_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }
  const maxRows = Math.min(Math.max(limit || 200, 1), 2000);
  const totalRows = sheet.getLastRow() - 1;
  const rowCount = Math.min(maxRows, totalRows);
  const startRow = sheet.getLastRow() - rowCount + 1;
  return sheet
    .getRange(startRow, 1, rowCount, KAVACH_LOG_HEADERS.length)
    .getValues()
    .map((row) => {
      const item = {};
      KAVACH_LOG_HEADERS.forEach((header, index) => {
        const value = row[index];
        item[header.charAt(0).toLowerCase() + header.slice(1)] =
          value instanceof Date ? value.toISOString() : String(value === null || value === undefined ? "" : value);
      });
      return item;
    })
    .reverse();
}

/* ============================================================
   Menu + row tracking (unchanged behaviour)
   ============================================================ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Kavach Dashboard")
    .addItem("Setup Row Tracking", "setupKavachRowTracking")
    .addItem("Verify Row Tracking", "verifyKavachRowTrackingSetup")
    .addItem("Sync Reason Master", "syncKavachReasonMaster")
    .addItem("Show Header Map", "showKavachHeaderMap")
    .addToUi();
}

function setupKavachRowTracking() {
  const ss = kavachSpreadsheet_();
  ensureChangeLogSheet_(ss);
  syncKavachReasonMaster();
  installKavachTrackingTriggers_();
  snapshotKavachSheetRowCounts_(ss);
  PropertiesService.getDocumentProperties().setProperty(KAVACH_SETUP_NEXT_INDEX_KEY, "0");
  continueKavachRowTrackingSetup();
  verifyKavachRowTrackingSetup();
}

function verifyKavachRowTrackingSetup() {
  const status = kavachTrackingStatus_();
  const lines = [
    `Month sheets: ${status.monthSheets}`,
    `Change Log: ${status.changeLog ? "OK" : "Missing"}`,
    `Reason Master: ${status.reasonMaster ? "OK" : "Missing"}`,
    `Triggers: ${status.missingTriggers.length ? `Missing ${status.missingTriggers.join(", ")}` : "OK"}`,
    `Row IDs: ${status.rowIdIssues.length ? status.rowIdIssues.join("; ") : "OK"}`,
  ];
  Logger.log(lines.join("\n"));
  try {
    SpreadsheetApp.getUi().alert(`Kavach Row Tracking Status\n\n${lines.join("\n")}`);
  } catch (error) {
    /* No UI context (web app or time-based trigger) - the Logger output is enough. */
  }
  return status;
}

function kavachTrackingStatus_() {
  const ss = kavachSpreadsheet_();
  const monthSheets = ss.getSheets().filter((sheet) => isKavachMonthSheet_(sheet.getName()));
  const triggers = ScriptApp.getProjectTriggers().map((trigger) => trigger.getHandlerFunction());
  const missingTriggers = ["kavachOnEdit", "kavachOnChange", "syncKavachReasonMaster", "kavachSafetySweep"].filter(
    (handler) => !triggers.includes(handler)
  );
  const rowIdIssues = [];
  monthSheets.slice(0, 10).forEach((sheet) => {
    const rowIdColumn = findKavachRowIdColumn_(sheet);
    if (!rowIdColumn) {
      rowIdIssues.push(`${sheet.getName()}: missing ${KAVACH_ROW_ID_HEADER}`);
      return;
    }
    const lastRow = sheet.getLastRow();
    if (lastRow >= KAVACH_DATA_START_ROW) {
      const values = sheet
        .getRange(KAVACH_DATA_START_ROW, rowIdColumn, Math.min(lastRow - KAVACH_DATA_START_ROW + 1, 20), 1)
        .getValues();
      if (!values.some((row) => String(row[0] || "").trim())) {
        rowIdIssues.push(`${sheet.getName()}: no row IDs found in first data rows`);
      }
    }
  });
  return {
    monthSheets: monthSheets.length,
    changeLog: Boolean(ss.getSheetByName(KAVACH_CHANGE_LOG_SHEET)),
    reasonMaster: Boolean(ss.getSheetByName(KAVACH_REASON_MASTER_SHEET)),
    missingTriggers,
    rowIdIssues,
  };
}

function syncKavachReasonMaster() {
  const ss = kavachSpreadsheet_();
  const sourceSheet = ss.getSheets().find((sheet) => isKavachMonthSheet_(sheet.getName()));
  const master = ensureReasonMasterSheet_(ss);
  const rows = [];
  appendReasonRows_(rows, operationalAvailabilityReasonRows_(ss));
  if (sourceSheet) {
    const targets = reasonDropdownTargets_(sourceSheet);
    targets.forEach((target) => {
      const reasons = dropdownValuesForColumn_(sourceSheet, target.column).filter(isValidReasonMasterText_);
      const sourceRows = reasons.map((reason) => [target.section, target.metric, reason, target.header, new Date()]);
      appendReasonRows_(rows, sourceRows);
    });
  }
  if (!rows.length) {
    return;
  }
  master.clearContents();
  master.getRange(1, 1, 1, KAVACH_REASON_MASTER_HEADERS.length).setValues([KAVACH_REASON_MASTER_HEADERS]);
  master.getRange(2, 1, rows.length, KAVACH_REASON_MASTER_HEADERS.length).setValues(rows);
  master.setFrozenRows(1);
}

function operationalAvailabilityReasonRows_(ss) {
  const sheet = ss.getSheetByName("Operational Availability");
  if (!sheet) {
    return [];
  }
  const values = sheet.getDataRange().getValues();
  const sections = {
    "MODE CHANGE ANALYSIS": { section: "Mode change analysis", metric: "modeDegradation" },
    "UNDUE BRAKING ANALYSIS": { section: "Undue Braking Analysis", metric: "undesirableBrake" },
    "DESIRABLE BRAKING": { section: "Desirable Braking", metric: "desirableBrake" },
  };
  const rows = [];
  let current = null;
  let inTypeTable = false;
  values.forEach((row) => {
    const textCells = row.map((value) => String(value || "").trim());
    const upperCells = textCells.map((value) => value.toUpperCase());
    const sectionIndex = upperCells.findIndex((value) => sections[value]);
    const sectionKey = sectionIndex >= 0 ? upperCells[sectionIndex] : "";
    if (sectionKey && isOperationalSectionHeaderRow_(textCells, sectionIndex)) {
      current = sections[sectionKey];
      inTypeTable = false;
      return;
    }
    if (!current) {
      return;
    }
    if (upperCells.includes("TYPE")) {
      inTypeTable = true;
      return;
    }
    const reason = String(textCells[2] || "").trim();
    if (!inTypeTable || !isValidReasonMasterText_(reason)) {
      return;
    }
    rows.push([current.section, current.metric, reason, "Operational Availability Type", new Date()]);
  });
  return rows;
}

function isOperationalSectionHeaderRow_(cells, titleIndex) {
  const trailing = cells.slice(titleIndex + 1, titleIndex + 8);
  return !trailing.some((value) => String(value || "").trim());
}

function appendReasonRows_(target, rows) {
  rows.forEach((row) => {
    const section = String(row[0] || "").trim();
    const reason = String(row[2] || "").trim();
    if (!section || !isValidReasonMasterText_(reason)) {
      return;
    }
    const exists = target.some((existing) =>
      String(existing[0] || "").trim().toLowerCase() === section.toLowerCase()
      && String(existing[2] || "").trim().toLowerCase() === reason.toLowerCase()
    );
    if (!exists) {
      target.push(row);
    }
  });
}

function isValidReasonMasterText_(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }
  const lowered = text.toLowerCase();
  return !["total", "type", "icms", "non-icms", "non icms", "no issue", "no issues", "na", "n/a"].includes(lowered);
}

function continueKavachRowTrackingSetup() {
  const ss = kavachSpreadsheet_();
  const props = PropertiesService.getDocumentProperties();
  const sheets = ss.getSheets().filter((sheet) => isKavachMonthSheet_(sheet.getName()));
  let nextIndex = Number(props.getProperty(KAVACH_SETUP_NEXT_INDEX_KEY) || "0");
  const endIndex = Math.min(nextIndex + KAVACH_SETUP_BATCH_SIZE, sheets.length);
  for (let index = nextIndex; index < endIndex; index += 1) {
    backfillKavachRowIds_(sheets[index]);
  }
  nextIndex = endIndex;
  props.setProperty(KAVACH_SETUP_NEXT_INDEX_KEY, String(nextIndex));
  installKavachSetupContinuationTrigger_(nextIndex < sheets.length);
}

function kavachOnEdit(e) {
  if (!e || !e.range) {
    return;
  }
  const sheet = e.range.getSheet();
  if (!isKavachMonthSheet_(sheet.getName())) {
    return;
  }
  if (e.range.getRow() < KAVACH_DATA_START_ROW) {
    logKavachFullRefresh_(sheet, "header-edit", e.range.getRow(), e.range.getColumn());
    return;
  }

  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const rowIdColumn = ensureKavachRowIdColumn_(sheet);
    const startRow = e.range.getRow();
    const endRow = e.range.getLastRow();
    const changedColumn = e.range.getColumn();
    const rows = [];
    for (let row = startRow; row <= endRow; row += 1) {
      const rowId = ensureKavachRowIdForRow_(sheet, rowIdColumn, row);
      const hasData = rowHasKavachData_(sheet, row);
      const action = hasData ? editActionForRange_(sheet, e.range, row) : "blank";
      const newDate = kavachDateValueForRow_(sheet, row);
      const oldDate = oldDateFromEdit_(sheet, e, row, newDate);
      rows.push([
        new Date(),
        sheet.getName(),
        rowId,
        row,
        changedColumn,
        action,
        oldDate,
        newDate,
        "",
        activeUserEmail_(),
      ]);
    }
    appendKavachChangeRows_(rows);
    rememberKavachSheetRowCount_(sheet);
    rememberKavachRecentEdit_(sheet);
  } finally {
    lock.releaseLock();
  }
}

function kavachOnChange(e) {
  const changeType = e && e.changeType ? String(e.changeType) : "";
  const ss = kavachSpreadsheet_();
  if (/INSERT_COLUMN|REMOVE_COLUMN|OTHER/.test(changeType)) {
    syncKavachReasonMaster();
  }
  if (!/EDIT|FORMAT|INSERT_ROW|REMOVE_ROW|INSERT_COLUMN|REMOVE_COLUMN|OTHER/.test(changeType)) {
    return;
  }

  let targetSheets = [];
  if (/INSERT_ROW|REMOVE_ROW/.test(changeType)) {
    targetSheets = changedKavachSheetsByRowCount_(ss);
  }
  if (!targetSheets.length) {
    const sheet = ss.getActiveSheet();
    if (sheet && isKavachMonthSheet_(sheet.getName())) {
      targetSheets = [sheet];
    }
  }

  targetSheets.forEach((sheet) => {
    if (/EDIT|FORMAT/.test(changeType) && kavachRecentEditWasLogged_(sheet)) {
      return;
    }
    logKavachFullRefresh_(sheet, "structure-change", "", "", changeType);
    rememberKavachSheetRowCount_(sheet);
  });
  if (!targetSheets.length) {
    snapshotKavachSheetRowCounts_(ss);
  }
}

function backfillKavachRowIds_(sheet) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const rowIdColumn = ensureKavachRowIdColumn_(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow < KAVACH_DATA_START_ROW) {
      return;
    }
    const rowCount = lastRow - KAVACH_DATA_START_ROW + 1;
    const range = sheet.getRange(KAVACH_DATA_START_ROW, rowIdColumn, rowCount, 1);
    const values = range.getValues();
    const dataValues = sheet.getRange(KAVACH_DATA_START_ROW, 1, rowCount, Math.max(sheet.getLastColumn(), 1)).getValues();
    let changed = false;
    for (let index = 0; index < values.length; index += 1) {
      if (!String(values[index][0] || "").trim() && rowHasKavachDataValues_(dataValues[index], rowIdColumn)) {
        values[index][0] = Utilities.getUuid();
        changed = true;
      }
    }
    if (changed) {
      range.setValues(values);
    }
    sheet.hideColumns(rowIdColumn);
  } finally {
    lock.releaseLock();
  }
}

function ensureKavachRowIdColumn_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(KAVACH_HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  for (let index = 0; index < headers.length; index += 1) {
    if (String(headers[index] || "").trim().toUpperCase() === KAVACH_ROW_ID_HEADER) {
      sheet.hideColumns(index + 1);
      return index + 1;
    }
  }
  const newColumn = lastColumn + 1;
  sheet.getRange(KAVACH_HEADER_ROW, newColumn).setValue(KAVACH_ROW_ID_HEADER);
  sheet.hideColumns(newColumn);
  return newColumn;
}

function findKavachRowIdColumn_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(KAVACH_HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  for (let index = 0; index < headers.length; index += 1) {
    if (String(headers[index] || "").trim().toUpperCase() === KAVACH_ROW_ID_HEADER) {
      return index + 1;
    }
  }
  return null;
}

function ensureKavachRowIdForRow_(sheet, rowIdColumn, row) {
  const cell = sheet.getRange(row, rowIdColumn);
  let rowId = String(cell.getValue() || "").trim();
  if (!rowId) {
    rowId = Utilities.getUuid();
    cell.setValue(rowId);
  }
  return rowId;
}

function rowHasKavachData_(sheet, row) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const rowIdColumn = findKavachRowIdColumn_(sheet);
  const values = sheet.getRange(row, 1, 1, lastColumn).getValues()[0];
  return rowHasKavachDataValues_(values, rowIdColumn);
}

function rowHasKavachDataValues_(values, rowIdColumn) {
  return values.some((value, index) => {
    if (index + 1 === rowIdColumn) {
      return false;
    }
    return String(value || "").trim();
  });
}

function ensureChangeLogSheet_(ss) {
  let sheet = ss.getSheetByName(KAVACH_CHANGE_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(KAVACH_CHANGE_LOG_SHEET);
  }
  sheet.getRange(1, 1, 1, KAVACH_LOG_HEADERS.length).setValues([KAVACH_LOG_HEADERS]);
  sheet.setFrozenRows(1);
  return sheet;
}

function ensureReasonMasterSheet_(ss) {
  let sheet = ss.getSheetByName(KAVACH_REASON_MASTER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(KAVACH_REASON_MASTER_SHEET);
  }
  sheet.getRange(1, 1, 1, KAVACH_REASON_MASTER_HEADERS.length).setValues([KAVACH_REASON_MASTER_HEADERS]);
  sheet.setFrozenRows(1);
  return sheet;
}

function appendKavachChangeRows_(rows) {
  if (!rows.length) {
    return;
  }
  const sheet = ensureChangeLogSheet_(kavachSpreadsheet_());
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, KAVACH_LOG_HEADERS.length).setValues(rows);
}

function kavachRowCountPropertyKey_(sheetName) {
  return `${KAVACH_ROW_COUNT_PROPERTY_PREFIX}${sheetName}`;
}

function rememberKavachSheetRowCount_(sheet) {
  if (!sheet || !isKavachMonthSheet_(sheet.getName())) {
    return;
  }
  PropertiesService.getDocumentProperties().setProperty(
    kavachRowCountPropertyKey_(sheet.getName()),
    String(sheet.getLastRow())
  );
}

function kavachLastEditPropertyKey_(sheetName) {
  return `${KAVACH_LAST_EDIT_PROPERTY_PREFIX}${sheetName}`;
}

function rememberKavachRecentEdit_(sheet) {
  if (!sheet || !isKavachMonthSheet_(sheet.getName())) {
    return;
  }
  PropertiesService.getDocumentProperties().setProperty(
    kavachLastEditPropertyKey_(sheet.getName()),
    String(Date.now())
  );
}

function kavachRecentEditWasLogged_(sheet) {
  if (!sheet || !isKavachMonthSheet_(sheet.getName())) {
    return false;
  }
  const value = Number(PropertiesService.getDocumentProperties().getProperty(kavachLastEditPropertyKey_(sheet.getName())) || "0");
  return value && (Date.now() - value) < KAVACH_ONCHANGE_EDIT_FALLBACK_WINDOW_MS;
}

function snapshotKavachSheetRowCounts_(ss) {
  ss.getSheets()
    .filter((sheet) => isKavachMonthSheet_(sheet.getName()))
    .forEach((sheet) => rememberKavachSheetRowCount_(sheet));
}

function changedKavachSheetsByRowCount_(ss) {
  const props = PropertiesService.getDocumentProperties();
  const changed = [];
  ss.getSheets()
    .filter((sheet) => isKavachMonthSheet_(sheet.getName()))
    .forEach((sheet) => {
      const key = kavachRowCountPropertyKey_(sheet.getName());
      const previous = Number(props.getProperty(key) || "");
      const current = sheet.getLastRow();
      if (!previous || previous !== current) {
        changed.push(sheet);
      }
      props.setProperty(key, String(current));
    });
  return changed;
}

function logKavachFullRefresh_(sheet, action, row, column, changeType) {
  appendKavachChangeRows_([[
    new Date(),
    sheet.getName(),
    "",
    row,
    column,
    action || "full-refresh",
    "",
    "",
    changeType || "",
    activeUserEmail_(),
  ]]);
}

function editActionForRange_(sheet, range, row) {
  const dateColumn = findKavachDateColumn_(sheet);
  const startColumn = range.getColumn();
  const endColumn = range.getLastColumn();
  if (dateColumn && startColumn <= dateColumn && dateColumn <= endColumn) {
    return "date-change";
  }
  return "edit";
}

function findKavachDateColumn_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  /* Must follow the configured layout, not literal rows 2/3: on a book whose
     header block sits higher, row 3 is already data and the header is missed. */
  const row2 = sheet.getRange(KAVACH_HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  const row3 = sheet.getRange(KAVACH_SUB_HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  for (let index = 0; index < lastColumn; index += 1) {
    const text = normalizeHeaderText_(`${row2[index] || ""} ${row3[index] || ""}`);
    if (text === "DATE") {
      return index + 1;
    }
  }
  return 1;
}

function kavachDateValueForRow_(sheet, row) {
  const dateColumn = findKavachDateColumn_(sheet);
  if (!dateColumn) {
    return "";
  }
  const value = sheet.getRange(row, dateColumn).getDisplayValue();
  return String(value || "").trim();
}

function oldDateFromEdit_(sheet, e, row, newDate) {
  const dateColumn = findKavachDateColumn_(sheet);
  if (!dateColumn || e.range.getColumn() !== dateColumn || e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) {
    return "";
  }
  return String(e.oldValue || "").trim() || newDate;
}

function installKavachTrackingTriggers_() {
  const ss = kavachSpreadsheet_();
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    const handler = trigger.getHandlerFunction();
    if (
      handler === "kavachOnEdit"
      || handler === "kavachOnChange"
      || handler === "syncKavachReasonMaster"
      || handler === "kavachSafetySweep"
    ) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger("kavachOnEdit").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("kavachOnChange").forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger("syncKavachReasonMaster").timeBased().everyHours(1).create();
  ScriptApp.newTrigger("kavachSafetySweep").timeBased().everyMinutes(5).create();
}

function kavachSafetySweep() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) {
    return;
  }
  try {
    const ss = kavachSpreadsheet_();
    const sheets = ss.getSheets().filter((sheet) => isKavachMonthSheet_(sheet.getName()));
    if (!sheets.length) {
      return;
    }
    const props = PropertiesService.getDocumentProperties();
    const targets = [];
    const now = new Date();
    const currentMonthKeys = [
      Utilities.formatDate(now, Session.getScriptTimeZone(), "MMM-yy").toUpperCase(),
      Utilities.formatDate(now, Session.getScriptTimeZone(), "MMMM-yy").toUpperCase(),
    ];
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthKeys = [
      Utilities.formatDate(previousMonth, Session.getScriptTimeZone(), "MMM-yy").toUpperCase(),
      Utilities.formatDate(previousMonth, Session.getScriptTimeZone(), "MMMM-yy").toUpperCase(),
    ];

    sheets.forEach((sheet) => {
      const name = sheet.getName().toUpperCase();
      if (
        currentMonthKeys.some((key) => name.indexOf(key) >= 0)
        || previousMonthKeys.some((key) => name.indexOf(key) >= 0)
      ) {
        targets.push(sheet);
      }
    });

    let nextIndex = Number(props.getProperty(KAVACH_SAFETY_SWEEP_NEXT_INDEX_KEY) || "0");
    for (let count = 0; count < Math.min(KAVACH_SAFETY_SWEEP_SHEETS_PER_RUN, sheets.length); count += 1) {
      targets.push(sheets[nextIndex % sheets.length]);
      nextIndex += 1;
    }
    props.setProperty(KAVACH_SAFETY_SWEEP_NEXT_INDEX_KEY, String(nextIndex % sheets.length));

    const unique = [];
    const seen = {};
    targets.forEach((sheet) => {
      if (!sheet || seen[sheet.getSheetId()]) {
        return;
      }
      seen[sheet.getSheetId()] = true;
      unique.push(sheet);
    });
    unique.forEach((sheet) => {
      logKavachFullRefresh_(sheet, "safety-sweep", "", "", `SAFETY_SWEEP_${new Date().toISOString()}`);
      rememberKavachSheetRowCount_(sheet);
    });
  } finally {
    lock.releaseLock();
  }
}

function reasonDropdownTargets_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  /* Must follow the configured layout, not literal rows 2/3: on a book whose
     header block sits higher, row 3 is already data and the header is missed. */
  const row2 = sheet.getRange(KAVACH_HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  const row3 = sheet.getRange(KAVACH_SUB_HEADER_ROW, 1, 1, lastColumn).getValues()[0];
  let modeReasonColumn = null;
  let undesirableReasonColumn = null;
  let desirableReasonColumn = null;
  for (let index = 0; index < lastColumn; index += 1) {
    const text = normalizeHeaderText_(`${row2[index] || ""} ${row3[index] || ""}`);
    if (text === "REASON") {
      modeReasonColumn = modeReasonColumn || index + 1;
    }
    if (text === "REASON OF UNDESIRABLE BRAKING") {
      undesirableReasonColumn = index + 1;
    }
    if (text === "REASON OF DESIRABLE BRAKING") {
      desirableReasonColumn = index + 1;
    }
  }
  const targets = [];
  if (modeReasonColumn) {
    targets.push({
      section: "Mode change analysis",
      metric: "modeDegradation",
      column: modeReasonColumn,
      header: "Reason",
    });
  }
  if (undesirableReasonColumn) {
    targets.push({
      section: "Undue Braking Analysis",
      metric: "undesirableBrake",
      column: undesirableReasonColumn,
      header: "Reason of Undesirable Braking",
    });
  }
  if (desirableReasonColumn) {
    targets.push({
      section: "Desirable Braking",
      metric: "desirableBrake",
      column: desirableReasonColumn,
      header: "Reason of Desirable Braking",
    });
  }
  return targets;
}

function dropdownValuesForColumn_(sheet, column) {
  const lastRow = Math.max(sheet.getLastRow(), KAVACH_DATA_START_ROW);
  const scanRows = Math.min(Math.max(lastRow - KAVACH_DATA_START_ROW + 1, 1), 300);
  const validations = sheet.getRange(KAVACH_DATA_START_ROW, column, scanRows, 1).getDataValidations();
  const values = [];
  validations.some((row) => {
    const validation = row[0];
    if (!validation) {
      return false;
    }
    const criteriaType = validation.getCriteriaType();
    const criteriaValues = validation.getCriteriaValues();
    if (criteriaType === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
      appendUniqueReasons_(values, criteriaValues[0] || []);
      return values.length > 0;
    }
    if (criteriaType === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) {
      const range = criteriaValues[0];
      const rangeValues = range.getValues().flat();
      appendUniqueReasons_(values, rangeValues);
      return values.length > 0;
    }
    return false;
  });
  return values;
}

function appendUniqueReasons_(target, values) {
  values.forEach((value) => {
    const text = String(value || "").trim();
    if (text && !target.some((existing) => existing.toLowerCase() === text.toLowerCase())) {
      target.push(text);
    }
  });
}

function normalizeHeaderText_(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function installKavachSetupContinuationTrigger_(shouldContinue) {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === "continueKavachRowTrackingSetup") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  if (shouldContinue) {
    ScriptApp.newTrigger("continueKavachRowTrackingSetup").timeBased().after(60 * 1000).create();
  }
}

function isKavachMonthSheet_(name) {
  const text = String(name || "").trim().toUpperCase();
  if (text === KAVACH_CHANGE_LOG_SHEET.toUpperCase() || text === KAVACH_REASON_MASTER_SHEET.toUpperCase()) {
    return false;
  }
  /* Explicit allowlist, not a pattern: this book carries plenty of other
     tabs (GPRS, TAG_MISS, STATION HEALTH, Loco details, NR2, WR1...) that
     must never be scanned. Add the next month here as the sheet grows. */
  return KAVACH_MONTH_SHEETS.indexOf(text) >= 0;
}

function activeUserEmail_() {
  try {
    return Session.getActiveUser().getEmail() || "";
  } catch (error) {
    return "";
  }
}
