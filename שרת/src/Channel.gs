/**
 * הורדת ערוץ שלם.
 *
 * עבודת ערוץ אינה עבודה בעצמה - היא "מניפסט" שמחזיק רשימת מזהי עבודות
 * רגילות, אחת לכל סרטון. כל עבודת ילד עוברת בדיוק באותו צינור שכבר קיים
 * (חילוץ, מיזוג/dual, העברה בנתחים), וכשהיא מסתיימת - onChildJobDone_
 * מעדכן את הסיכום המצטבר. זה מה שמאפשר לתת ריצה מקבילה על פני הרבה
 * סרטונים בלי לכתוב מנוע תור נפרד: processQueue הקיים כבר יודע לעבד
 * הרבה עבודות ממתינות תוך כדי מעבר בין ביצועים.
 */

const MANIFEST_INDEX_KEY = 'MANIFEST_INDEX';
const MANIFEST_PREFIX = 'MANIFEST_';

function newManifestId_() {
  return Utilities.getUuid().slice(0, 8);
}

function readManifestIndex_() {
  const raw = props_().getProperty(MANIFEST_INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}

function writeManifestIndex_(ids) {
  props_().setProperty(MANIFEST_INDEX_KEY, JSON.stringify(ids));
}

function getManifest_(id) {
  const raw = props_().getProperty(MANIFEST_PREFIX + id);
  return raw ? JSON.parse(raw) : null;
}

function saveManifest_(m) {
  m.updatedAt = Date.now();
  props_().setProperty(MANIFEST_PREFIX + m.id, JSON.stringify(m));

  const ids = readManifestIndex_();
  if (ids.indexOf(m.id) === -1) {
    ids.push(m.id);
    writeManifestIndex_(ids);
  }
  return m;
}

/** ניקוי מניפסטים ישנים שהסתיימו, באותו קצב כמו ניקוי העבודות. */
function purgeOldManifests_() {
  const cutoff = Date.now() - CONFIG.JOB_TTL_HOURS * 3600 * 1000;
  readManifestIndex_().forEach(function (id) {
    const m = getManifest_(id);
    if (!m) {
      writeManifestIndex_(readManifestIndex_().filter(function (x) { return x !== id; }));
      return;
    }
    if (m.status === 'done' && m.updatedAt < cutoff) {
      props_().deleteProperty(MANIFEST_PREFIX + id);
      writeManifestIndex_(readManifestIndex_().filter(function (x) { return x !== id; }));
    }
  });
}

// === זיהוי כתובת ערוץ ===

/** תומך ב-@handle, channel/UC.., c/name, user/name ופלייליסטים. */
function normalizeChannelUrl_(url) {
  url = String(url || '').trim();
  const ok = /^https?:\/\/(www\.)?youtube\.com\/(@[\w.\-]+|channel\/[\w\-]+|c\/[\w.\-]+|user\/[\w.\-]+|playlist\?list=[\w\-]+)/i;
  return ok.test(url) ? url : null;
}

// === לוג דה-דופ לכל ערוץ ===
//
// נשמר בצד השרת ולא רק בדפדפן: כך הדה-דופ עובד גם אם המשתמש עובר
// מכשיר, מנקה עוגיות, או מתקין את ה-userscript מחדש.

/** מפתח קצר וקבוע לכתובת ערוץ, כדי שלא נהיה תלויים באורך הכתובת. */
function channelKey_(channelUrl, format) {
  const clean = channelUrl.toLowerCase().replace(/\/+$/, '');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, clean);
  const hex = bytes.map(function (b) {
    return ((b + 256) % 256).toString(16).padStart(2, '0');
  }).join('');
  return 'CHLOG_' + hex + '_' + format;
}

function getChannelLog_(channelUrl, format) {
  const raw = props_().getProperty(channelKey_(channelUrl, format));
  return raw ? JSON.parse(raw) : [];
}

/**
 * מוסיף מזהה סרטון ללוג. אם הרשומה מתקרבת לתקרת 9KB של Script Properties -
 * מקרה שקורה רק בערוצים בני אלפי סרטונים - משאירים את המחצית האחרונה.
 * המשמעות: סרטון ישן מאוד עלול לרדת שוב פעם אחת. זה מחיר סביר מול
 * הצורך במסד נתונים נפרד.
 */
function addChannelLogEntry_(channelUrl, format, videoId) {
  if (!videoId) return;
  let ids = getChannelLog_(channelUrl, format);
  if (ids.indexOf(videoId) > -1) return;

  ids.push(videoId);
  let raw = JSON.stringify(ids);
  if (raw.length > MAX_PROPERTY_BYTES) {
    ids = ids.slice(Math.floor(ids.length / 2));
    raw = JSON.stringify(ids);
  }
  props_().setProperty(channelKey_(channelUrl, format), raw);
}

function clearChannelLog_(channelUrl, format) {
  props_().deleteProperty(channelKey_(channelUrl, format));
}

// === עדכון מצטבר כשעבודת ילד מסתיימת ===

/** מזוהה כדי לספור בנפרד חסימות יוטיוב מכשלים אחרים בסיכום שמוצג. */
const BOT_BLOCK_PATTERN = /חסמה את כתובת השרת/;

function onChildJobDone_(job, success) {
  const manifest = getManifest_(job.manifestId);
  if (!manifest) return;

  if (success) {
    manifest.doneCount++;
    if (job.videoId) {
      addChannelLogEntry_(manifest.channelUrl, manifest.format, job.videoId);
      manifest.doneIds = (manifest.doneIds || []).concat(job.videoId).slice(-300);
    }
  } else if (BOT_BLOCK_PATTERN.test(job.error || '')) {
    manifest.blockedCount = (manifest.blockedCount || 0) + 1;
  } else {
    manifest.failedCount++;
  }

  saveManifest_(manifest);

  const processed = manifest.doneCount + manifest.failedCount + (manifest.blockedCount || 0);
  if (processed >= manifest.total) {
    manifest.status = 'done';
    saveManifest_(manifest);
    notifyChannelDone_(manifest);
  }
}
