/**
 * העלאה ישירה מהשרת לדרייב.
 *
 * Apps Script פותח סשן העלאה מתחדשת (resumable) עם הטוקן של המשתמש ושולח
 * לכאן רק את כתובת הסשן. הכתובת עצמה היא ההרשאה לסשן הזה בלבד - לא
 * צריך ולא עובר לכאן שום טוקן של החשבון. מכאן הקובץ עולה ישר לגוגל,
 * במהירות של שרת ולא דרך נתחי 8MB של Apps Script שצורכים את מכסת
 * זמן הריצה היומית שלו.
 *
 * אם משהו נכשל כאן, Apps Script חוזר לדרך הישנה (משיכה בנתחים) - ולכן
 * כשל בהעלאה הישירה אף פעם לא מפיל הורדה.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { jobDir } from './storage.js';
import { log } from './log.js';

// כפולה של 256KB, כפי ש-Drive דורש מכל נתח שאינו האחרון.
const CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_RETRIES = 4;

/**
 * רק כתובות העלאה של Drive. בלי הבדיקה הזאת נקודת הקצה הייתה הופכת
 * את השרת לכלי ששולח קבצים לכל כתובת שמישהו עם הטוקן יבקש.
 */
export function isDriveSessionUri(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' &&
           u.hostname === 'www.googleapis.com' &&
           u.pathname.startsWith('/upload/drive/') &&
           u.searchParams.has('upload_id');
  } catch {
    return false;
  }
}

function ackedBytes(res) {
  const m = /bytes=0-(\d+)/.exec(res.headers.get('range') || '');
  return m ? Number(m[1]) + 1 : 0;
}

/** שואל את Drive כמה בייטים באמת נקלטו, אחרי כשל רשת באמצע נתח. */
async function probeOffset(sessionUri, size) {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes */${size}` },
  });
  if (res.status === 200 || res.status === 201) return { done: true, body: await res.json() };
  if (res.status === 308) return { done: false, offset: ackedBytes(res) };
  throw new Error(`בדיקת סשן ההעלאה החזירה ${res.status}`);
}

/**
 * מעלה את קובץ העבודה לסשן. רץ ברקע; המצב נחשף ב-job.push ונקרא
 * דרך GET /api/jobs/:id.
 */
export async function pushToDrive(job, sessionUri) {
  const size = job.file.size;
  job.push = { status: 'uploading', sentBytes: 0, totalBytes: size, fileId: '', error: '' };
  log.info('העלאה לדרייב התחילה', { id: job.id, MB: Math.round(size / 1048576) });

  const started = Date.now();
  let fh = null;

  try {
    fh = await fs.open(path.join(jobDir(job.id), job.file.name), 'r');
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size));
    let offset = 0;
    let failures = 0;

    while (true) {
      const len = Math.min(CHUNK_BYTES, size - offset);
      await fh.read(buffer, 0, len, offset);

      let res;
      try {
        res = await fetch(sessionUri, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` },
          body: buffer.subarray(0, len),
        });
      } catch (err) {
        if (++failures > MAX_RETRIES) throw err;
        const probe = await probeOffset(sessionUri, size);
        if (probe.done) { finish(job, probe.body); break; }
        offset = probe.offset;
        continue;
      }

      if (res.status === 308) {
        const next = ackedBytes(res);
        // 308 בלי התקדמות = Drive לא קלט את הנתח. לא ממשיכים בלולאה אינסופית.
        if (next <= offset && ++failures > MAX_RETRIES) throw new Error('Drive לא מתקדם בקליטת הנתחים');
        offset = next;
        job.push.sentBytes = offset;
        continue;
      }
      if (res.status === 200 || res.status === 201) {
        finish(job, await res.json());
        break;
      }
      if (res.status >= 500 && ++failures <= MAX_RETRIES) {
        const probe = await probeOffset(sessionUri, size);
        if (probe.done) { finish(job, probe.body); break; }
        offset = probe.offset;
        continue;
      }
      throw new Error(`Drive החזיר ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    log.info('העלאה לדרייב הושלמה', {
      id: job.id,
      seconds: Math.round((Date.now() - started) / 1000),
    });
  } catch (err) {
    job.push.status = 'error';
    job.push.error = err.message.slice(0, 300);
    log.error('העלאה לדרייב נכשלה', { id: job.id, error: job.push.error });
  } finally {
    await fh?.close();
  }
}

function finish(job, body) {
  job.push.status = 'done';
  job.push.sentBytes = job.push.totalBytes;
  job.push.fileId = (body && body.id) || '';
}
