/**
 * קובץ העוגיות של יוטיוב: פענוח מ-COOKIES_B64, אבחון, ועותק נפרד לכל הרצה.
 *
 * כל הלוגים כאן מדפיסים שמות ומונים בלבד, אף פעם לא ערכים - הלוגים של
 * Railway גלויים לכל מי שיש לו גישה לפרויקט, ועוגיית סשן שדלפה שווה לסיסמה.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

// בלי אחת מאלה יוטיוב רואה אורח אנונימי, וכתובת של ספק ענן נחסמת מיד.
const SESSION_COOKIES = ['__Secure-3PSID', '__Secure-1PSID', 'SID'];

let summary = { configured: false };

export function cookieSummary() {
  return summary;
}

/**
 * מקבל את מה שהודבק ב-Railway ומחזיר טקסט Netscape.
 * סלחני בכוונה לכל צורות ההדבקה שנתקלנו בהן: base64 רגיל, פלט certutil
 * עם שורות BEGIN/END, קובץ שנשמר ב-UTF-16 (ברירת המחדל של PowerShell 5),
 * ואפילו תוכן הקובץ עצמו בלי קידוד בכלל.
 */
function decodeEnvValue(raw) {
  const value = raw.trim();
  if (value.includes('\t') || /^#\s*(Netscape\s+)?HTTP Cookie File/i.test(value)) {
    return value;
  }
  const b64 = value.replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf.length > 1 && buf[1] === 0);
  return buf.toString(utf16 ? 'utf16le' : 'utf8');
}

function normalize(text) {
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  // yt-dlp דוחה קובץ בלי שורת הכותרת הזאת, וחלק מהתוספים משמיטים אותה.
  const header = /^#\s*(Netscape\s+)?HTTP Cookie File/i.test(body) ? '' : '# Netscape HTTP Cookie File\n';
  return header + body + '\n';
}

function inspect(text) {
  const now = Date.now() / 1000;
  const names = new Set();
  let total = 0;
  let youtube = 0;
  let expiredSession = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^#HttpOnly_/, '');
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    total++;

    const [domain, , , , expires, name] = fields;
    if (!/youtube\.com$/i.test(domain)) continue;
    youtube++;
    names.add(name);
    if (SESSION_COOKIES.includes(name) && Number(expires) > 0 && Number(expires) < now) {
      expiredSession++;
    }
  }

  return {
    configured: true,
    cookies: total,
    youtubeCookies: youtube,
    loggedIn: SESSION_COOKIES.some((n) => names.has(n)) && expiredSession === 0,
    hasLoginInfo: names.has('LOGIN_INFO'),
    expiredSession,
    names: [...names].sort(),
  };
}

/** נקרא פעם אחת בעלייה: כותב את הקובץ מהמשתנה ומדפיס אבחון. */
export async function prepareCookies() {
  if (!config.cookiesFile) {
    log.warn('לא הוגדר קובץ עוגיות. יוטיוב חוסמת כתובות ענן ללא הזדהות.');
    return;
  }

  if (config.cookiesB64) {
    await fs.mkdir(path.dirname(config.cookiesFile), { recursive: true });
    await fs.writeFile(config.cookiesFile, normalize(decodeEnvValue(config.cookiesB64)), { mode: 0o600 });
  }

  let text;
  try {
    text = await fs.readFile(config.cookiesFile, 'utf8');
  } catch {
    summary = { configured: true, error: 'file_missing' };
    log.error('קובץ העוגיות לא נמצא', { path: config.cookiesFile });
    return;
  }

  summary = inspect(text);
  log.info('קובץ עוגיות נטען', {
    cookies: summary.cookies,
    youtube: summary.youtubeCookies,
    loggedIn: summary.loggedIn,
    LOGIN_INFO: summary.hasLoginInfo,
    names: summary.names.join(','),
  });

  if (!summary.youtubeCookies) {
    log.error('בקובץ העוגיות אין אף עוגייה של youtube.com - ההדבקה ב-COOKIES_B64 שבורה או שיוצא אתר אחר');
  } else if (summary.expiredSession) {
    log.error('עוגיות הסשן בקובץ פג תוקפן - יש לייצא קובץ חדש');
  } else if (!summary.loggedIn) {
    log.error('העוגיות הן של אורח ולא של חשבון מחובר (אין SID/__Secure-3PSID) - התחברו ליוטיוב לפני הייצוא');
  }
}

/**
 * עותק פרטי לכל הרצה של yt-dlp. yt-dlp כותב את קובץ העוגיות מחדש ביציאה,
 * ושתי הרצות במקביל (הורדה ורשימת ערוץ, למשל) על אותו קובץ היו משאירות
 * אותו קרוע. עותק מוצלח מוחזר למקור כדי לשמר עוגיות שיוטיוב רעננה.
 *
 * @returns {Promise<{args: string[], release: (ok: boolean) => Promise<void>}>}
 */
export async function checkoutCookies() {
  if (!config.cookiesFile) return { args: [], release: async () => {} };

  const copy = path.join(path.dirname(config.cookiesFile),
    `run-${crypto.randomBytes(6).toString('hex')}.txt`);
  try {
    await fs.copyFile(config.cookiesFile, copy);
  } catch (err) {
    log.warn('העתקת קובץ העוגיות נכשלה, ממשיך בלי עוגיות', { error: err.message });
    return { args: [], release: async () => {} };
  }

  return {
    args: ['--cookies', copy],
    release: async (ok) => {
      if (ok) {
        try {
          await fs.rename(copy, config.cookiesFile);
          return;
        } catch { /* נופלים למחיקה */ }
      }
      await fs.rm(copy, { force: true });
    },
  };
}
