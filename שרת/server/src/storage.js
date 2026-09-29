/**
 * מחזור החיים של הקבצים על הדיסק.
 *
 * לכל עבודה יש תיקייה משלה תחת dataDir. השרת הזה הוא תחנת מעבר בלבד:
 * הקבצים חיים עד ש-Apps Script סיים למשוך אותם, ואז נמחקים.
 *
 * שתי רשתות ביטחון, כי Apps Script לא תמיד מספיק לשלוח DELETE:
 * מחיקה לפי גיל, ומחיקה לפי תקרת דיסק.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, MAX_DISK_BYTES } from './config.js';
import { log } from './log.js';

export function newJobId() {
  return crypto.randomBytes(8).toString('hex');
}

export function jobDir(id) {
  return path.join(config.dataDir, id);
}

export async function ensureDataDir() {
  await fs.mkdir(config.dataDir, { recursive: true });

  // כתיבה בפועל ולא בדיקת הרשאות: ב-Railway נתיב Volume שלא חובר
  // נראה קיים אבל אינו כתיב, וזה מתגלה רק בהורדה הראשונה.
  const probe = path.join(config.dataDir, '.write-probe');
  await fs.writeFile(probe, 'ok');
  await fs.unlink(probe);

  log.info('תיקיית העבודה מוכנה', { dir: config.dataDir });
}

export async function createJobDir(id) {
  const dir = jobDir(id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function removeJobDir(id) {
  try {
    await fs.rm(jobDir(id), { recursive: true, force: true });
  } catch (err) {
    log.warn('מחיקת תיקיית עבודה נכשלה', { id, error: err.message });
  }
}

/** מוצא את קובץ המדיה שנוצר. yt-dlp קובע את הסיומת לפי המיזוג בפועל. */
export async function findMediaFile(id) {
  const dir = jobDir(id);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const media = entries.filter((n) => n.startsWith('media.') && !n.endsWith('.part'));
  if (!media.length) return null;

  const name = media[0];
  const stat = await fs.stat(path.join(dir, name));
  return { name, size: stat.size, path: path.join(dir, name) };
}

/**
 * מונע יציאה מהתיקייה דרך שם קובץ מפוברק. שם הקובץ מגיע מכתובת
 * שהלקוח שולט בה, ובלי הבדיקה הזאת "../../etc/passwd" היה נקרא.
 */
export function resolveInsideJob(id, name) {
  const dir = path.resolve(jobDir(id));
  const full = path.resolve(dir, name);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  return full;
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else {
      try {
        total += (await fs.stat(full)).size;
      } catch { /* נמחק בינתיים */ }
    }
  }
  return total;
}

export async function usedBytes() {
  return dirSize(config.dataDir);
}

/**
 * מחיקת עבודות שפג תוקפן, ואם עדיין חורגים מהתקרה - גם הישנות ביותר
 * מבין אלה שכבר נמסרו. עבודות שרצות כרגע לא נמחקות לעולם.
 *
 * @param {Map} jobs מפת העבודות מ-queue.js
 */
export async function sweep(jobs) {
  const now = Date.now();
  const ttl = config.jobTtlMinutes * 60 * 1000;
  let removed = 0;

  for (const [id, job] of jobs) {
    if (job.status === 'queued' || job.status === 'working') continue;
    if (now - job.updatedAt > ttl) {
      await removeJobDir(id);
      jobs.delete(id);
      removed++;
    }
  }

  let used = await usedBytes();
  if (used > MAX_DISK_BYTES) {
    const evictable = [...jobs.entries()]
      .filter(([, j]) => j.status === 'ready' || j.status === 'error')
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);

    for (const [id] of evictable) {
      if (used <= MAX_DISK_BYTES) break;
      const size = await dirSize(jobDir(id));
      await removeJobDir(id);
      jobs.delete(id);
      used -= size;
      removed++;
      log.warn('עבודה פונתה בגלל תקרת דיסק', { id });
    }
  }

  // תיקיות יתומות: נשארות אחרי הפעלה מחדש, כי התור נמצא בזיכרון בלבד.
  try {
    for (const name of await fs.readdir(config.dataDir)) {
      if (jobs.has(name) || name.startsWith('.')) continue;
      const stat = await fs.stat(path.join(config.dataDir, name));
      if (now - stat.mtimeMs > ttl) {
        await fs.rm(path.join(config.dataDir, name), { recursive: true, force: true });
        removed++;
      }
    }
  } catch (err) {
    log.warn('סריקת תיקיות יתומות נכשלה', { error: err.message });
  }

  if (removed) log.info('ניקוי הושלם', { removed, usedMB: Math.round(used / 1048576) });
}

export function startSweeper(jobs) {
  const every = config.sweepIntervalMinutes * 60 * 1000;
  const timer = setInterval(() => {
    sweep(jobs).catch((err) => log.error('ניקוי נכשל', { error: err.message }));
  }, every);
  timer.unref();
  return timer;
}
