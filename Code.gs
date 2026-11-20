/**
 * Temple Parking Pass — backend
 * Google Apps Script bound to a Google Sheet. Free, no server needed.
 *
 * Sheets (created by setup()):
 *   Events : Event ID | Event Name | Date (YYYY-MM-DD) | Open (YES/NO) | Parking Spots
 *   Passes : Code | Event ID | Event Name | Event Date | Name | Phone | People | Registered At | Checked In At | Email
 *
 * Files in the Apps Script project: Code.gs (this file) and QR.gs (QR image generator for emails).
 */

const CONFIG = {
  MAX_PEOPLE: 20,
  TZ: 'America/New_York',
  SITE_URL: 'https://murugantemplenj.github.io/temple-parking-pass/',
  TEMPLE_NAME: 'Arulmigu Dhandayuthapani Swamy Temple',
  EMAIL_FROM_NAME: 'Murugan Temple Parking',
  DATETIME_FORMAT: 'M/d/yyyy h:mm am/pm'
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
const PASS_HEADERS = ['Code', 'Event ID', 'Event Name', 'Event Date', 'Name', 'Phone', 'People', 'Registered At', 'Checked In At', 'Email'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L confusion
const CODE_LEN = 6;

/* ---------- setup: run this from the Apps Script editor ----------
 * Safe to run again: it only adds what is missing (new Email column, date+time formats)
 * and asks for any new permissions (sending email). */
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
  // Upgrade older sheets: add any missing headers (e.g. Email) and show time in the date columns
  const head = ps.getRange(1, 1, 1, PASS_HEADERS.length).getValues()[0];
  PASS_HEADERS.forEach((h, i) => { if (!head[i]) ps.getRange(1, i + 1).setValue(h).setFontWeight('bold'); });
  ps.getRange('H:I').setNumberFormat(CONFIG.DATETIME_FORMAT);
  ps.getRange('J:J').setNumberFormat('@');

  // Touch MailApp so Run > setup asks for the "send email" permission
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
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
  const emailRaw = String(req.email || '').trim();
  const email = normEmail_(emailRaw);

  if (name.length < 2) return fail_('Please enter your name.');
  if (!phone) return fail_('Please enter a valid 10-digit phone number.');
  if (!(people >= 1 && people <= CONFIG.MAX_PEOPLE)) return fail_('Number of people must be 1 to ' + CONFIG.MAX_PEOPLE + '.');
  if (emailRaw && !email) return fail_('Please check your email address (or leave it blank).');

  const evId = String(req.eventId || '').trim();
  const matches = readEvents_().filter(x => x.id === evId);
  if (matches.length > 1) return fail_('Setup problem: two events share the Event ID "' + evId + '". Please tell the temple office.');
  const ev = matches[0];
  if (!ev || !ev.open || ev.date < today_()) return fail_('Registration for this event is closed.');

  let result;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(PASSES_SHEET);
    const data = sh.getDataRange().getValues();

    // Same phone + same event = same car. Return the existing pass (and update name/people/email).
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][1]) === ev.id && String(data[i][5]) === phone) {
        sh.getRange(i + 1, 5, 1, 3).setValues([[name, phone, people]]);
        if (email) sh.getRange(i + 1, 10).setValue(email);
        result = passResult_(String(data[i][0]), ev, name, phone, people, email || String(data[i][9] || ''), true);
        break;
      }
    }

    if (!result) {
      const used = {};
      for (let i = 1; i < data.length; i++) used[String(data[i][0])] = true;
      let code;
      do { code = newCode_(); } while (used[code]);

      sh.appendRow([code, ev.id, ev.name, ev.date, name, phone, people, new Date(), '', email]);
      sh.getRange(sh.getLastRow(), 8).setNumberFormat(CONFIG.DATETIME_FORMAT);
      result = passResult_(code, ev, name, phone, people, email, false);
    }
  } finally {
    lock.releaseLock();
  }

  // Email the pass (outside the lock so other registrations aren't kept waiting)
  result.emailSent = false;
  if (result.email) {
    try {
      if (MailApp.getRemainingDailyQuota() > 0) {
        sendPassEmail_(result);
        result.emailSent = true;
      } else {
        result.emailNote = 'Daily email limit reached — please screenshot your pass.';
      }
    } catch (err) {
      result.emailNote = 'Could not send the email — please screenshot your pass.';
    }
  }
  return result;
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
    sh.getRange(rowIdx + 1, 9).setValue(new Date()).setNumberFormat(CONFIG.DATETIME_FORMAT);
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
    code: String(r[0]), name: String(r[4]), phone: String(r[5]), people: Number(r[6]) || 0, email: String(r[9] || ''),
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

function passResult_(code, ev, name, phone, people, email, existing) {
  return {
    ok: true, code: code, eventId: ev.id, eventName: ev.name, date: ev.date,
    dateLabel: prettyDate_(ev.date), name: name, phone: phone, people: people, email: email, existing: existing
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

function normEmail_(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 100 ? s : '';
}

function fmtPhone_(p) {
  const d = String(p || '');
  return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : d;
}

function htmlEsc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- pass email ---------- */
function sendPassEmail_(p) {
  // Same QR content as the on-screen pass, drawn by QR.gs (no outside service)
  const qr = qrcode(0, 'M');
  qr.addData(CONFIG.SITE_URL + 'scan.html?c=' + p.code);
  qr.make();
  const b64 = qr.createDataURL(6, 4).split(',')[1];
  const qrBlob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/gif', 'parking-pass-' + p.code + '.gif');

  const code = p.code.slice(0, 3) + ' ' + p.code.slice(3);
  const row = (k, v, style) => '<tr><td style="padding:6px 14px 6px 0;color:#7a6a5f;font-size:14px">' + k +
    '</td><td style="padding:6px 0;font-size:16px;font-weight:700;' + (style || '') + '">' + v + '</td></tr>';

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;background:#fff8ee;padding:20px 10px">' +
    '<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #ead9c4;border-radius:14px;overflow:hidden">' +
    '<div style="background:#fff;text-align:center;padding:12px 12px 8px">' +
    '<img src="' + CONFIG.SITE_URL + 'img/logo-wide.png" alt="' + htmlEsc_(CONFIG.TEMPLE_NAME) + '" width="240" style="width:240px;max-width:100%;height:auto"></div>' +
    '<div style="background:#7a1f1f;color:#fff;text-align:center;padding:10px;border-bottom:4px solid #e8891c;font-size:20px;font-weight:700">Parking Pass</div>' +
    '<div style="padding:18px;text-align:center">' +
    '<div style="font-size:20px;font-weight:800;color:#7a1f1f">' + htmlEsc_(p.eventName) + '</div>' +
    '<div style="display:inline-block;background:#e8891c;color:#fff;font-weight:800;padding:4px 12px;border-radius:99px;margin:8px 0 10px">' + htmlEsc_(p.dateLabel) + '</div><br>' +
    '<img src="cid:qr" width="240" height="240" alt="Parking QR code" style="display:block;margin:0 auto">' +
    '<table style="margin:10px auto 0;border-collapse:collapse;text-align:left">' +
    row('Code', code, 'font-family:Menlo,Consolas,monospace;font-size:22px;letter-spacing:3px;color:#7a1f1f') +
    row('Name', htmlEsc_(p.name)) +
    row('Phone', htmlEsc_(fmtPhone_(p.phone))) +
    row('People', String(p.people)) +
    row('Email', htmlEsc_(p.email)) +
    '</table>' +
    '<div style="background:#fdf0dc;border-radius:10px;padding:12px;font-size:14px;margin-top:14px;text-align:left">' +
    'Show this QR code to the parking volunteer when you arrive.<br>' +
    'Valid only on <b>' + htmlEsc_(p.dateLabel) + '</b> for <b>' + htmlEsc_(p.eventName) + '</b>.<br><br>' +
    'Plans changed? Register again at <a href="' + CONFIG.SITE_URL + '">' + CONFIG.SITE_URL.replace(/^https:\/\//, '') + '</a> ' +
    'with the same phone number to update the number of people. You keep the same pass.</div>' +
    '</div></div></div>';

  const text = 'Parking Pass — ' + p.eventName + ', ' + p.dateLabel + '\n\n' +
    'Code: ' + code + '\nName: ' + p.name + '\nPhone: ' + fmtPhone_(p.phone) + '\nPeople: ' + p.people + '\n\n' +
    'Show the QR code (attached) to the parking volunteer. Valid only on ' + p.dateLabel + '.';

  MailApp.sendEmail({
    to: p.email,
    subject: (p.existing ? 'Updated parking pass: ' : 'Your parking pass: ') + p.eventName + ' (' + p.dateLabel + ')',
    body: text,
    htmlBody: html,
    name: CONFIG.EMAIL_FROM_NAME,
    inlineImages: { qr: qrBlob }
  });
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
