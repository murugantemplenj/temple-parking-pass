/**
 * Temple Parking Pass — backend
 * Google Apps Script bound to a Google Sheet. Free, no server needed.
 *
 * Sheets (created by setup()):
 *   Events : Event ID | Event Name | Date (YYYY-MM-DD) | Open (YES/NO) | Parking Spots
 *   Passes : Code | Event ID | Event Name | Event Date | Name | Phone | People | Registered At | Checked In At
 */

const CONFIG = {
  MAX_PEOPLE: 20,
  TZ: 'America/New_York'
};

// PINs live in Apps Script > Project Settings > Script Properties (not in this file,
// so the code can sit in a public GitHub repo). Property names: VOLUNTEER_PIN, ADMIN_PIN.
function pin_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Script property ' + name + ' is not set — see SETUP.md.');
  return String(v).trim();
}

const EVENTS_SHEET = 'Events';
const PASSES_SHEET = 'Passes';
const EVENT_HEADERS = ['Event ID', 'Event Name', 'Date (YYYY-MM-DD)', 'Open (YES/NO)', 'Parking Spots'];
const PASS_HEADERS = ['Code', 'Event ID', 'Event Name', 'Event Date', 'Name', 'Phone', 'People', 'Registered At', 'Checked In At'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L confusion
const CODE_LEN = 6;

/* ---------- one-time setup: run this from the Apps Script editor ---------- */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let ev = ss.getSheetByName(EVENTS_SHEET);
  if (!ev) {
    ev = ss.insertSheet(EVENTS_SHEET);
    ev.getRange('A:C').setNumberFormat('@');
    ev.appendRow(EVENT_HEADERS);
    ev.appendRow(['TEST-' + today_(), 'Test Event', today_(), 'YES', 150]);
    ev.setFrozenRows(1);
    ev.getRange(1, 1, 1, EVENT_HEADERS.length).setFontWeight('bold');
  }

  let ps = ss.getSheetByName(PASSES_SHEET);
  if (!ps) {
    ps = ss.insertSheet(PASSES_SHEET);
    ps.getRange('A:F').setNumberFormat('@'); // keep codes, dates, phones as text
    ps.appendRow(PASS_HEADERS);
    ps.setFrozenRows(1);
    ps.getRange(1, 1, 1, PASS_HEADERS.length).setFontWeight('bold');
  }
}

/* ---------- web API ---------- */
function doGet() {
  return ContentService.createTextOutput('Temple Parking Pass API is running.');
}

function doPost(e) {
  let res;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (req.action) {
      case 'events':    res = listOpenEvents_(); break;
      case 'register':  res = register_(req); break;
      case 'checkin':   res = checkIn_(req); break;
      case 'dashboard': res = dashboard_(req); break;
      default:          res = { ok: false, error: 'Unknown action' };
    }
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(res))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- actions ---------- */
function listOpenEvents_() {
  const t = today_();
  const events = readEvents_()
    .filter(ev => ev.open && ev.date >= t)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(ev => ({ id: ev.id, name: ev.name, date: ev.date, label: prettyDate_(ev.date), isToday: ev.date === t }));
  return { ok: true, events: events };
}

function register_(req) {
  const name = String(req.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const phone = normPhone_(req.phone);
  const people = parseInt(req.people, 10);

  if (name.length < 2) return fail_('Please enter your name.');
  if (!phone) return fail_('Please enter a valid 10-digit phone number.');
  if (!(people >= 1 && people <= CONFIG.MAX_PEOPLE)) return fail_('Number of people must be 1 to ' + CONFIG.MAX_PEOPLE + '.');

  const ev = readEvents_().find(x => x.id === String(req.eventId || '').trim());
  if (!ev || !ev.open || ev.date < today_()) return fail_('Registration for this event is closed.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(PASSES_SHEET);
    const data = sh.getDataRange().getValues();

    // Same phone + same event = same car. Return the existing pass (and update name/people).
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][1]) === ev.id && String(data[i][5]) === phone) {
        sh.getRange(i + 1, 5, 1, 3).setValues([[name, phone, people]]);
        return passResult_(String(data[i][0]), ev, name, phone, people, true);
      }
    }

    const used = {};
    for (let i = 1; i < data.length; i++) used[String(data[i][0])] = true;
    let code;
    do { code = newCode_(); } while (used[code]);

    sh.appendRow([code, ev.id, ev.name, ev.date, name, phone, people, new Date(), '']);
    return passResult_(code, ev, name, phone, people, false);
  } finally {
    lock.releaseLock();
  }
}

function checkIn_(req) {
  if (String(req.pin || '') !== pin_('VOLUNTEER_PIN')) {
    return { ok: false, status: 'PIN', error: 'Wrong volunteer PIN.' };
  }
  const t = today_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(PASSES_SHEET);
    const data = sh.getDataRange().getValues();
    let rowIdx = -1;

    if (req.phone) {
      // Lost/forgot pass: find today's pass by phone, prefer one not yet used
      const phone = normPhone_(req.phone);
      if (!phone) return result_('INVALID', 'Enter a 10-digit phone number.');
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][5]) === phone && dateStr_(data[i][3]) === t) {
          rowIdx = i;
          if (!data[i][8]) break;
        }
      }
      if (rowIdx < 0) return result_('INVALID', 'No pass for TODAY with this phone number.');
    } else {
      const code = cleanCode_(req.code);
      if (!code) return result_('INVALID', 'This is not a temple parking pass.');
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]) === code) { rowIdx = i; break; }
      }
      if (rowIdx < 0) return result_('INVALID', 'Pass not found.');
    }

    const r = data[rowIdx];
    const info = {
      code: String(r[0]), name: String(r[4]), phone: String(r[5]), people: Number(r[6]) || 0,
      eventName: String(r[2]), date: dateStr_(r[3]), dateLabel: prettyDate_(dateStr_(r[3]))
    };

    if (info.date !== t) {
      return Object.assign(result_('WRONG_DAY', 'This pass is for ' + info.dateLabel + ' (' + info.eventName + '), not today.'), info);
    }
    if (r[8]) {
      return Object.assign(result_('USED', 'Already used at ' + fmtTime_(r[8]) + '.'), info);
    }
    sh.getRange(rowIdx + 1, 9).setValue(new Date());
    return Object.assign(result_('OK', 'Allow parking'), info);
  } finally {
    lock.releaseLock();
  }
}

function dashboard_(req) {
  if (String(req.pin || '') !== pin_('ADMIN_PIN')) {
    return { ok: false, status: 'PIN', error: 'Wrong admin PIN.' };
  }
  const t = today_();
  const from = ymdOffset_(-30);
  const stats = {};
  readEvents_().filter(e => e.date >= from).forEach(e => {
    stats[e.id] = {
      id: e.id, name: e.name, date: e.date, dateLabel: prettyDate_(e.date), open: e.open,
      spots: e.spots, cars: 0, people: 0, carsIn: 0, peopleIn: 0
    };
  });
  const rows = sheet_(PASSES_SHEET).getDataRange().getValues().slice(1);
  rows.forEach(r => {
    const s = stats[String(r[1])];
    if (!s) return;
    const p = Number(r[6]) || 0;
    s.cars++; s.people += p;
    if (r[8]) { s.carsIn++; s.peopleIn += p; }
  });
  const list = Object.keys(stats).map(k => stats[k]).sort((a, b) => a.date.localeCompare(b.date));

  // Which event's registrations to list: the one asked for, else today's, else the next upcoming, else the latest past.
  let sel = req.eventId && stats[req.eventId] ? req.eventId : '';
  if (!sel) {
    const next = list.find(e => e.date >= t);
    sel = next ? next.id : (list.length ? list[list.length - 1].id : '');
  }
  const passes = rows.filter(r => String(r[1]) === sel).map(r => ({
    code: String(r[0]), name: String(r[4]), phone: String(r[5]), people: Number(r[6]) || 0,
    registered: r[7] instanceof Date ? Utilities.formatDate(r[7], CONFIG.TZ, 'MMM d, h:mm a') : String(r[7] || ''),
    arrived: r[8] ? fmtTime_(r[8]) : ''
  }));
  return { ok: true, today: t, updated: fmtTime_(new Date()), events: list, selected: sel, passes: passes };
}

/* ---------- helpers ---------- */
function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" missing — run setup() first.');
  return sh;
}

function readEvents_() {
  return sheet_(EVENTS_SHEET).getDataRange().getValues().slice(1)
    .filter(r => String(r[0]).trim() !== '')
    .map(r => ({
      id: String(r[0]).trim(),
      name: String(r[1]).trim(),
      date: dateStr_(r[2]),
      open: String(r[3]).trim().toUpperCase() === 'YES',
      spots: Number(r[4]) || 0
    }));
}

function passResult_(code, ev, name, phone, people, existing) {
  return {
    ok: true, code: code, eventId: ev.id, eventName: ev.name, date: ev.date,
    dateLabel: prettyDate_(ev.date), name: name, phone: phone, people: people, existing: existing
  };
}

function result_(status, message) { return { ok: true, status: status, message: message }; }
function fail_(msg) { return { ok: false, error: msg }; }

function newCode_() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  return s;
}

// Accepts "XK7P4Q", "xk7 p4q", or a full scan URL ".../scan.html?c=XK7P4Q"
function cleanCode_(v) {
  let s = String(v || '').trim();
  const m = s.match(/[?&]c=([A-Za-z0-9-]+)/);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== CODE_LEN) return '';
  for (let i = 0; i < s.length; i++) if (CODE_CHARS.indexOf(s.charAt(i)) < 0) return '';
  return s;
}

function normPhone_(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  return d.length === 10 ? d : '';
}

function today_() { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'); }
function ymdOffset_(days) { return Utilities.formatDate(new Date(Date.now() + days * 86400000), CONFIG.TZ, 'yyyy-MM-dd'); }
function dateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TZ, 'yyyy-MM-dd');
  return String(v || '').trim();
}
function prettyDate_(ymd) {
  const p = String(ymd).split('-').map(Number);
  if (p.length !== 3 || !p[0]) return String(ymd);
  // noon UTC keeps the calendar day stable in any US time zone
  return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)), CONFIG.TZ, 'EEE, MMM d');
}
function fmtTime_(v) {
  return v instanceof Date ? Utilities.formatDate(v, CONFIG.TZ, 'h:mm a') : String(v);
}
