// ===== EDIT THESE TWO LINES =====
// Paste the Apps Script Web App URL (ends with /exec). Until you do, pages run in DEMO mode.
const API_URL = 'https://script.google.com/macros/s/AKfycbylGwEue1ApHTB_-CNE76kKshy_mNnTrOr9vdIKsVirqyZuhNWoywNNe4dt53apa9V_/exec';
const TEMPLE_NAME = 'Arulmigu Dhandayuthapani Swamy Temple';
// =================================

const DEMO = !/^https:\/\/script\.google\.com\//.test(API_URL);

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtCode(c) { return String(c).slice(0, 3) + ' ' + String(c).slice(3); }
function fmtPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || ''); }
function localYmd(d) { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

async function api(action, data) {
  if (DEMO) return mockApi(action, data || {});
  const r = await fetch(API_URL, { method: 'POST', body: JSON.stringify(Object.assign({ action: action }, data || {})) });
  return r.json();
}

/* ---------- DEMO mode: lets you try the pages before the backend is set up ---------- */
function mockApi(action, d) {
  const db = JSON.parse(lsGet('pp_demo_db') || '{"passes":[]}');
  const save = () => lsSet('pp_demo_db', JSON.stringify(db));
  const today = localYmd();
  const sat = new Date(); sat.setDate(sat.getDate() + (((6 - sat.getDay()) + 7) % 7 || 7));
  const label = ymd => { const p = ymd.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
  const events = [
    { id: 'DEMO-TODAY', name: 'Demo Event (today)', date: today, spots: 150 },
    { id: 'DEMO-SAT', name: 'Demo Saturday Pooja', date: localYmd(sat), spots: 150 }
  ];
  const phoneOk = p => { let x = String(p || '').replace(/\D/g, ''); if (x.length === 11 && x[0] === '1') x = x.slice(1); return x.length === 10 ? x : ''; };
  const out = v => new Promise(res => setTimeout(() => res(v), 300));

  if (action === 'events') return out({ ok: true, events: events.map(e => Object.assign({ label: label(e.date), isToday: e.date === today }, e)) });

  if (action === 'register') {
    const ev = events.find(e => e.id === d.eventId); const phone = phoneOk(d.phone); const ppl = parseInt(d.people, 10);
    if (!d.name || d.name.trim().length < 2) return out({ ok: false, error: 'Please enter your name.' });
    if (!phone) return out({ ok: false, error: 'Please enter a valid 10-digit phone number.' });
    if (!(ppl >= 1 && ppl <= 20)) return out({ ok: false, error: 'Number of people must be 1 to 20.' });
    let p = db.passes.find(x => x.eventId === ev.id && x.phone === phone);
    const existing = !!p;
    if (!p) { p = { code: Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join(''), eventId: ev.id, eventName: ev.name, date: ev.date, phone: phone, checkedIn: '' }; db.passes.push(p); }
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email.trim())) return out({ ok: false, error: 'Please check your email address (or leave it blank).' });
    p.name = d.name.trim(); p.people = ppl; if (d.email) p.email = d.email.trim().toLowerCase(); if (!existing) p.registered = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); save();
    return out({ ok: true, code: p.code, eventId: ev.id, eventName: ev.name, date: ev.date, dateLabel: label(ev.date), name: p.name, phone: phone, people: ppl, email: p.email || '', existing: existing, emailSent: false, emailNote: p.email ? 'Demo mode: no email sent.' : '' });
  }

  if (action === 'checkin') {
    if (String(d.pin) !== '246810') return out({ ok: false, status: 'PIN', error: 'Wrong volunteer PIN. (Demo PIN: 246810)' });
    let p;
    if (d.phone) { const ph = phoneOk(d.phone); p = db.passes.find(x => x.phone === ph && x.date === today && !x.checkedIn) || db.passes.find(x => x.phone === ph && x.date === today); if (!p) return out({ ok: true, status: 'INVALID', message: 'No pass for TODAY with this phone number.' }); }
    else { let c = String(d.code || ''); const m = c.match(/[?&]c=([A-Za-z0-9-]+)/); if (m) c = m[1]; c = c.toUpperCase().replace(/[^A-Z0-9]/g, ''); p = db.passes.find(x => x.code === c); if (!p) return out({ ok: true, status: 'INVALID', message: 'Pass not found.' }); }
    const info = { code: p.code, name: p.name, phone: p.phone, people: p.people, eventName: p.eventName, date: p.date, dateLabel: label(p.date) };
    if (p.date !== today) return out(Object.assign({ ok: true, status: 'WRONG_DAY', message: 'This pass is for ' + info.dateLabel + ' (' + p.eventName + '), not today.' }, info));
    if (p.checkedIn) return out(Object.assign({ ok: true, status: 'USED', message: 'Already used at ' + p.checkedIn + '.' }, info));
    p.checkedIn = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); save();
    return out(Object.assign({ ok: true, status: 'OK', message: 'Allow parking' }, info));
  }

  if (action === 'dashboard') {
    if (String(d.pin) !== '975310') return out({ ok: false, status: 'PIN', error: 'Wrong admin PIN. (Demo PIN: 975310)' });
    const list = events.map(e => {
      const ps = db.passes.filter(p => p.eventId === e.id); const inn = ps.filter(p => p.checkedIn);
      return { id: e.id, name: e.name, date: e.date, dateLabel: label(e.date), open: true, spots: e.spots, cars: ps.length, people: ps.reduce((a, p) => a + p.people, 0), carsIn: inn.length, peopleIn: inn.reduce((a, p) => a + p.people, 0) };
    });
    const sel = list.some(e => e.id === d.eventId) ? d.eventId : list[0].id;
    const passes = db.passes.filter(p => p.eventId === sel).map(p => ({ code: p.code, name: p.name, phone: p.phone, email: p.email || '', people: p.people, registered: p.registered || '', arrived: p.checkedIn || '' }));
    return out({ ok: true, today: today, updated: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), events: list, selected: sel, passes: passes });
  }
  return out({ ok: false, error: 'Unknown action' });
}
