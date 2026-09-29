/**
 * קריאת הגדרות מהסביבה.
 *
 * הכול נקרא ומאומת פעם אחת בעלייה. שרת שחסר לו טוקן או שיש לו נתיב
 * אחסון לא כתיב עדיף שיקרוס מיד ובברור, ולא שייכשל על הבקשה הראשונה
 * אחרי שכבר נראה שהוא רץ.
 */

import os from 'node:os';
import path from 'node:path';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`חסר משתנה סביבה: ${name}`);
  return v;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} חייב להיות מספר, התקבל: ${raw}`);
  return v;
}

const dataDir = process.env.DATA_DIR || (process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'jobs')
  : path.join(os.tmpdir(), 'yt-to-drive'));

export const config = {
  port: num('PORT', 3000),

  // הטוקן המשותף עם Apps Script. חייב להיות ארוך ואקראי.
  token: required('SHARED_TOKEN'),

  // Railway מוחקת את מערכת הקבצים בכל פריסה. חברו Volume ומפו אותו ל-/data,
  // אחרת הורדה שנמצאת באוויר בזמן פריסה מחדש נעלמת.
  dataDir,

  // קובץ עוגיות בפורמט Netscape. בלעדיו יוטיוב חוסמת כתובות של ספקי ענן
  // עם "Sign in to confirm you're not a bot". ראו README.
  //
  // ל-Railway אין כפתור "העלה קובץ" ללוח הבקרה, ולכן COOKIES_FILE לבדו
  // לא מספיק - אין דרך לשים שם קובץ מהמחשב שלכם. COOKIES_B64 הוא הפתרון:
  // מדביקים את תוכן קובץ העוגיות מקודד ב-base64 כמשתנה סביבה רגיל,
  // ו-prepareCookies() ב-cookies.js כותב אותו לדיסק בעלייה.
  //
  // הקובץ יושב מחוץ ל-dataDir בכוונה: הניקוי ב-storage.js מוחק כל דבר
  // ב-dataDir שאינו עבודה מוכרת ושגילו מעל JOB_TTL_MINUTES, ושלוש שעות
  // אחרי העלייה הוא מחק גם את קובץ העוגיות - מאותו רגע yt-dlp רץ כאורח.
  cookiesFile: process.env.COOKIES_FILE ||
    (process.env.COOKIES_B64 ? path.join(os.tmpdir(), 'yt-dlp-cookies', 'cookies.txt') : ''),
  cookiesB64: process.env.COOKIES_B64 || '',

  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',

  // ספק PO Token (bgutil) שרץ כתהליך בן בתוך אותה מכולה. יוטיוב דורשת
  // אסימון כזה להורדת רוב הפורמטים; בלעדיו מקבלים 403 או רק פורמטים
  // ירודים. ריק = לא מפעילים (למשל בהרצה מקומית בלי ה-Dockerfile).
  potServerScript: process.env.POT_SERVER_SCRIPT || '',
  potPort: num('POT_PORT', 4416),

  // סרטון קצר ויציב לבדיקה העצמית בעלייה ול-/api/diag.
  selfTestUrl: process.env.SELF_TEST_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw',

  // כמה הורדות במקביל. כל הורדה צורכת CPU למיזוג, והמכולות של Railway
  // צנועות. שתיים זה כבר הרבה.
  concurrency: num('CONCURRENCY', 1),

  // תקרת דיסק כוללת. כשחורגים, עבודות ישנות שכבר נמסרו נמחקות ראשונות.
  maxDiskMB: num('MAX_DISK_MB', 5120),
  maxFileMB: num('MAX_FILE_MB', 4096),

  // גיל שאחריו עבודה נמחקת גם אם אף אחד לא ביקש. רשת ביטחון מול
  // Apps Script שנפל באמצע ולא שלח DELETE.
  jobTtlMinutes: num('JOB_TTL_MINUTES', 180),
  sweepIntervalMinutes: num('SWEEP_INTERVAL_MINUTES', 10),

  // תקרת זמן להרצת yt-dlp בודדת, כדי ששרת לא ייתקע לנצח על סרטון בעייתי.
  jobTimeoutMinutes: num('JOB_TIMEOUT_MINUTES', 60),

  maxDurationMinutes: num('MAX_DURATION_MINUTES', 240),

  logLevel: process.env.LOG_LEVEL || 'info',
};

export const MAX_DISK_BYTES = config.maxDiskMB * 1024 * 1024;
export const MAX_FILE_BYTES = config.maxFileMB * 1024 * 1024;
