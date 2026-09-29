/**
 * תור העבודות.
 *
 * כל עבודה נשמרת כרשומת JSON נפרדת ב־Script Properties, ואינדקס אחד מחזיק
 * את רשימת המזהים. הפרדה כזאת חשובה: תקרת הגודל היא 9KB לערך בודד, ורשומה
 * אחת גדולה עם כל העבודות הייתה נשברת אחרי כמה עשרות הורדות.
 *
 * עבודה מורכבת מ־parts. במצב merged יש חלק אחד; במצב dual יש שניים —
 * רצועת וידאו ורצועת אודיו — וכל חלק מנוהל בנפרד עם סשן העלאה משלו.
 *
 * מצבי עבודה: queued -> resolving -> transferring -> done | error
 */

const JOB_INDEX_KEY = 'JOB_INDEX';
const JOB_PREFIX = 'JOB_';

// תקרת Script Properties היא 9KB לערך בודד. כתובות googlevideo ארוכות מאוד
// (לעיתים 2000 תווים), ושתי רצועות פלוס שני סשנים מתקרבים לתקרה.
const MAX_PROPERTY_BYTES = 8800;

function props_() {
  return PropertiesService.getScriptProperties();
}

function newJobId_() {
  return Utilities.getUuid().slice(0, 8);
}

function readIndex_() {
  const raw = props_().getProperty(JOB_INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}

function writeIndex_(ids) {
  props_().setProperty(JOB_INDEX_KEY, JSON.stringify(ids));
}

function getJob_(id) {
  const raw = props_().getProperty(JOB_PREFIX + id);
  return raw ? JSON.parse(raw) : null;
}

/**
 * שמירת עבודה, עם בדיקת גודל מפורשת. בלי הבדיקה חריגה מהתקרה נכשלת
 * באמצע הורדה ארוכה, אחרי שכבר הועברו מאות מגה-בייטים.
 */
function saveJob_(job) {
  job.updatedAt = Date.now();
  const raw = JSON.stringify(job);
  if (raw.length > MAX_PROPERTY_BYTES) {
    throw new Error('רשומת העבודה חרגה מ־' + MAX_PROPERTY_BYTES + ' בתים (' +
                    raw.length + '). כנראה כתובות המדיה ארוכות במיוחד.');
  }
  props_().setProperty(JOB_PREFIX + job.id, raw);
  return job;
}

/**
 * האינדקס נכתב גם מהוספה לתור וגם מכאן (ניקוי ישנות). שתיהן קריאה-ואז-
 * כתיבה, ולכן תחת אותה נעילה קצרה - אחרת מחיקה בזמן הוספה מקבילה הייתה
 * מוחקת מהאינדקס עבודה שנוספה זה עתה.
 */
function deleteJob_(id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    props_().deleteProperty(JOB_PREFIX + id);
    writeIndex_(readIndex_().filter(function (x) { return x !== id; }));
  } finally {
    lock.releaseLock();
  }
}

/**
 * יצירת עבודה חדשה. נעילה נדרשת כי הוספה לאינדקס היא קריאה־ואז־כתיבה,
 * ושתי בקשות מקבילות מהדף עלולות לדרוס זו את זו.
 */
function enqueueJob_(url, mode, quality, requester, opts) {
  opts = opts || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const job = {
      id: newJobId_(),
      url: url,
      mode: mode || CONFIG.DEFAULT_MODE,
      quality: quality || CONFIG.DEFAULT_QUALITY,
      requester: requester || '',
      status: 'queued',
      strategy: '',
      title: '',
      folderId: '',
      parts: [],
      partIndex: 0,
      driveUrl: '',
      error: '',
      attempts: 0,

      // מצב ההמתנה לספק אסינכרוני (השרת ב-Railway).
      remoteId: '',
      remoteProgress: 0,
      remoteStage: '',
      polls: 0,

      // מקושרת לעבודת ערוץ (ראו Channel.gs): יעד קבוע מראש במקום תיקיית
      // ברירת המחדל, ומזהה שדרכו מתעדכן הסיכום המצטבר של הערוץ.
      targetFolderId: opts.targetFolderId || '',
      manifestId: opts.manifestId || '',
      videoId: opts.videoId || '',

      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveJob_(job);
    const ids = readIndex_();
    ids.push(job.id);
    writeIndex_(ids);
    return job;
  } finally {
    lock.releaseLock();
  }
}

/** יוצר רשומת חלק חדשה. kind: 'media' | 'video' | 'audio' */
function makePart_(kind, url, fileName, mimeType, headers) {
  return {
    kind: kind,
    url: url,
    fileName: fileName,
    mimeType: mimeType,

    // כותרות שיישלחו בכל בקשת נתח. השרת ב-Railway דורש טוקן על כל
    // בקשה, כולל על הנתח החמישים - לא רק על הבקשה הראשונה.
    headers: headers || null,

    totalBytes: 0,
    sentBytes: 0,
    sessionUri: '',
    driveFileId: '',
    done: false,
  };
}

function currentPart_(job) {
  return job.parts[job.partIndex] || null;
}

/** סכום ההתקדמות על פני כל החלקים, לתצוגת סרגל אחיד. */
function jobProgress_(job) {
  let total = 0, sent = 0, known = job.parts.length > 0;
  job.parts.forEach(function (p) {
    if (!p.totalBytes) known = false;
    total += p.totalBytes;
    sent += p.sentBytes;
  });
  return {
    totalBytes: total,
    sentBytes: sent,
    percent: total ? Math.floor((sent / total) * 100) : 0,
    exact: known,
  };
}

/** עבודות שעדיין דורשות טיפול, לפי סדר הגעה. */
function pendingJobs_() {
  return readIndex_()
    .map(getJob_)
    .filter(function (j) {
      return j && j.status !== 'done' && j.status !== 'error';
    })
    .sort(function (a, b) { return a.createdAt - b.createdAt; });
}

/** ניקוי עבודות ישנות שהסתיימו, כדי לא למלא את מכסת ה־Properties. */
function purgeOldJobs_() {
  const cutoff = Date.now() - CONFIG.JOB_TTL_HOURS * 3600 * 1000;
  readIndex_().forEach(function (id) {
    const job = getJob_(id);
    if (!job) { deleteJob_(id); return; }
    if ((job.status === 'done' || job.status === 'error') && job.updatedAt < cutoff) {
      deleteJob_(id);
    }
  });
}

function failJob_(job, message) {
  job.status = 'error';
  job.error = String(message).slice(0, 500);
  saveJob_(job);

  // עבודה ששייכת לעבודת ערוץ מדווחת לסיכום המצטבר במקום לשלוח מייל
  // משלה - אחרת ערוץ עם עשרות כשלים היה שולח עשרות מיילים נפרדים.
  if (job.manifestId) onChildJobDone_(job, false);
  else notifyFailure_(job);
  return job;
}
