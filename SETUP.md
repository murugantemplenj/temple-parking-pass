# Temple Parking Pass — Setup (about 20 minutes, one time)

**How it works:** Devotees enter name, phone and number of people, and get a QR pass. The pass works only on that event's date. Volunteers scan it at the parking entrance. The dashboard shows cars and people expected and arrived.
**Cost:** $0. Data lives in a Google Sheet that the temple owns.

## Files
| File | Who uses it |
|---|---|
| `register.html` | Devotees: get the parking pass (share this link and its QR everywhere) |
| `scan.html` | Parking volunteers: camera scanner |
| `dashboard.html` | Organizers: live counts for food and parking planning |
| `config.js`, `style.css`, `lib/` | Supporting files. Keep them next to the pages. |
| `Code.gs`, `QR.gs` | Backend. Paste both into Google Apps Script as two files. `QR.gs` draws the QR image for emailed passes. |
| `index.html` | Redirects the site root to `register.html` |

## 1. Backend (Google Sheet + Apps Script)
1. Sign in to Google as **lkathir.project@gmail.com**. Create a new Google Sheet named "Temple Parking Passes".
2. **Extensions → Apps Script.** Delete the sample code, paste all of `Code.gs`, and save. Then click **+ → Script**, name it `QR`, paste all of `QR.gs`, and save.
3. **Project Settings (gear icon) → Script Properties → Add property** twice:
   - `VOLUNTEER_PIN` = a PIN for parking volunteers
   - `ADMIN_PIN` = a PIN for the dashboard (organizers and kitchen)
   (PINs live here, not in the code, so the code can be on public GitHub.)
4. **Project Settings (gear icon)** → Time zone = **(GMT-05:00) Eastern Time - New York**.
5. Select the `setup` function → **Run** → approve the permissions. This creates the **Events** and **Passes** tabs.
6. **Deploy → New deployment →** type **Web app**. Set Execute as: **Me**. Set Who has access: **Anyone**. Click Deploy, then **copy the URL** (it ends in `/exec`).

## 2. Website (GitHub Pages, free, https)
1. In `config.js`, paste the Web App URL into `API_URL` and check `TEMPLE_NAME`. Commit and push.
2. On GitHub: repo → **Settings → Pages → Source: Deploy from a branch → `main` / root → Save**.
3. After about a minute the site is live at `https://murugantemplenj.github.io/temple-parking-pass/`:
   - Devotees: `.../temple-parking-pass/` (opens the registration page)
   - Volunteers: `.../temple-parking-pass/scan.html`
   - Dashboard: `.../temple-parking-pass/dashboard.html`
4. On the temple website, add a "Get Parking Pass" button linking to the devotee URL.
5. Test it: register for the "Test Event" on one phone, then scan it with `scan.html` on another phone.
6. Delete the Test Event row and its test passes from the sheet.

> Until `API_URL` is set, the pages run in **DEMO mode** (yellow banner). Demo data stays inside each phone's own browser. Demo PINs: volunteer 246810, admin 975310.

## 3. For every event
Add one row in the **Events** tab:

| Event ID | Event Name | Date (YYYY-MM-DD) | Open (YES/NO) | Parking Spots |
|---|---|---|---|---|
| 2026-11-21-SKANDA | Skanda Sashti | 2026-11-21 | YES | 150 |

- **Event ID** must be unique. Using date + name works well.
- Registration stays open from the moment you add the row until the end of the event day. Set Open = NO to close it early.
- **Multi-day festival:** add one row per day. Each day then gets its own pass.

## 4. Event day
- **Volunteers:** open `/parking/scan.html` → enter the PIN once (the phone remembers it) → Share → **Add to Home Screen**.
  - **Green** = allow parking. **Amber** = pass already used. **Red** = wrong day or not a valid pass.
  - **Lost or dead phone:** type the 6-character code or the phone number in the box below the camera.
- **Arrivals without a pass:** put a poster at the entrance with a QR code linking to `register.html`. They register in 30 seconds, and the volunteer scans the new pass.
- **Organizers and kitchen:** open `dashboard.html`. The big number at the top is people registered, so cook for that many. Below it is every registration (name, phone, people, code, arrived time), with search and **Download CSV**. It refreshes every minute.

## Rules built in
- **One pass = one car.** Registering again with the same phone for the same event returns the **same pass** and updates the number of people. People can use this to "find my pass" again.
- **Passes work only on their event date.** A pass from a previous event shows red.
- **Each pass can be checked in once.** A second scan shows "already used".
- **Passes are saved on the devotee's phone.** Reopening `register.html` shows "Your parking passes".

## Admin pages and PINs
- **Dashboard (admin):** https://murugantemplenj.github.io/temple-parking-pass/dashboard.html — uses the **ADMIN_PIN**.
- **Scanner (volunteers):** https://murugantemplenj.github.io/temple-parking-pass/scan.html — uses the **VOLUNTEER_PIN**.
- **To change a PIN:** Apps Script → **Project Settings (gear)** → **Script Properties** → **Edit script properties** → change the value → **Save**. It takes effect immediately; no redeploy. Phones signed in with the old PIN are asked for the new one on their next scan or refresh.

## Emailed passes
- Email is optional on the registration form. When given, the pass (QR, code, name, phone, people) is emailed from the Google account that owns the script.
- **Daily limit:** a free Gmail account can send about **100 emails per day**. After that, devotees still get their pass on screen and are told to take a screenshot. For bigger events, Google Workspace for Nonprofits (free for registered nonprofits) raises this to 1,500 per day.
- Run `setup` once after updating the code, so Google asks for the "send email" permission.

## Changing the code later
1. Paste the new `Code.gs` (and `QR.gs` if it changed) into Apps Script and save.
2. If the update notes say so, run `setup` again (safe to repeat).
3. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.
