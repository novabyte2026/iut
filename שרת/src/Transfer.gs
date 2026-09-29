/**
 * מנוע ההעברה — הלב של הפרויקט.
 *
 * הבעיה: הכלי לבקשות רשת מוגבל ל-50MB לכל קריאה, ו-DriveApp לא יודע
 * לבנות קובץ גדול מזרם. הפתרון: מושכים מהמקור בנתחים עם כותרת Range,
 * ודוחפים כל נתח לסשן העלאה מתחדשת של Drive API. הקובץ נבנה בצד של גוגל,
 * ואף פעם לא מחזיקים אותו שלם בזיכרון.
 *
 * הבעיה השנייה: ביצוע בודד מוגבל ל־6 דקות. לכן כל נתח שנשלח נשמר במצב
 * העבודה, וכשנגמר הזמן מפסיקים באמצע ומתחילים מאותה נקודה בהרצה הבאה.
 *
 * הכול פועל ברמת החלק (part), כי במצב dual יש שתי רצועות נפרדות שכל אחת
 * מהן היא העברה עצמאית עם סשן משלה.
 */

const DRIVE_UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true';

/**
 * פותח סשן העלאה ומחזיר את כתובת הסשן.
 * הכתובת תקפה כשבוע, ולכן שורדת בקלות המשך בהרצה מאוחרת יותר.
 */
function openUploadSession_(fileName, mimeType, folderId) {
  const res = HTTP_.fetch(DRIVE_UPLOAD_URL, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': mimeType,
    },
    payload: JSON.stringify({ name: fileName, parents: [folderId] }),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() >= 300) {
    throw new Error('פתיחת סשן העלאה נכשלה (' + res.getResponseCode() + '): ' +
                    res.getContentText().slice(0, 300));
  }

  const location = header_(res, 'location');
  if (!location) throw new Error('Drive לא החזיר כתובת סשן בכותרת Location');
  return location;
}

/**
 * מעביר נתחים של חלק אחד עד שהוא נגמר או עד שנגמר תקציב הזמן.
 * שומר את העבודה אחרי כל נתח, כי המצב הזה הוא מה שמאפשר המשך.
 *
 * @returns {'done'|'incomplete'}
 */
function pumpPart_(job, part, deadline) {
  while (true) {
    if (Date.now() > deadline) return 'incomplete';

    const start = part.sentBytes;
    const wantEnd = start + CONFIG.CHUNK_BYTES - 1;
    const end = part.totalBytes ? Math.min(wantEnd, part.totalBytes - 1) : wantEnd;

    const src = HTTP_.fetch(part.url, {
      headers: sourceHeaders_(part, start, end),
      muteHttpExceptions: true,
      followRedirects: true,
    });

    const code = src.getResponseCode();
    if (code !== 206 && code !== 200) {
      throw new Error('המקור החזיר ' + code + ' בבקשת נתח מ־' + start);
    }

    // 200 במקום 206 = השרת התעלם מ־Range ומנסה לשלוח את הקובץ כולו.
    // עבור קובץ גדול מ־50MB זה נכשל ממילא, ולכן נעצור עם הסבר ברור.
    if (code === 200 && start > 0) {
      throw new Error('המקור לא תומך בבקשות Range ולכן אי אפשר להעביר בנתחים');
    }

    // גודל הקובץ הכולל מגיע מכותרת Content-Range של הנתח הראשון.
    // עדיף על בקשת HEAD נפרדת, שחלק מרשתות ההפצה דוחות.
    if (!part.totalBytes) {
      part.totalBytes = totalFromContentRange_(src) || src.getBlob().getBytes().length;
      guardSize_(part.totalBytes);
      saveJob_(job);
    }

    const bytes = src.getBlob().getBytes();
    if (!bytes.length) throw new Error('התקבל נתח ריק במיקום ' + start);

    const last = start + bytes.length - 1;
    const put = HTTP_.fetch(part.sessionUri, {
      method: 'put',
      contentLength: bytes.length,
      headers: { 'Content-Range': 'bytes ' + start + '-' + last + '/' + part.totalBytes },
      payload: bytes,
      muteHttpExceptions: true,
    });

    const putCode = put.getResponseCode();

    if (putCode === 308) {
      // Drive מאשר קליטה חלקית ומדווח בכותרת Range עד היכן הגיע.
      // מסתמכים על הדיווח שלו ולא על החישוב שלנו — הוא מקור האמת.
      part.sentBytes = ackedBytes_(put, last + 1);
      saveJob_(job);
      continue;
    }

    if (putCode === 200 || putCode === 201) {
      const file = safeJson_(put.getContentText()) || {};
      part.sentBytes = part.totalBytes;
      part.driveFileId = file.id || '';
      part.done = true;
      saveJob_(job);
      return 'done';
    }

    if (putCode === 404) {
      // סשן פג או נמחק. אין טעם להמשיך ממנו, נפתח אותו מחדש בניסיון הבא.
      part.sessionUri = '';
      part.sentBytes = 0;
      saveJob_(job);
      throw new Error('סשן ההעלאה פג. הניסיון הבא יתחיל את החלק מחדש.');
    }

    throw new Error('Drive החזיר ' + putCode + ' בהעלאת נתח: ' +
                    put.getContentText().slice(0, 200));
  }
}

/**
 * מרכיב את כותרות בקשת הנתח: Range תמיד, ומעליו כל כותרת שהספק דורש.
 * הסדר חשוב - Range נכתב אחרון כדי ששום כותרת מהספק לא תדרוס אותו.
 */
function sourceHeaders_(part, start, end) {
  const headers = {};
  if (part.headers) {
    for (const key in part.headers) headers[key] = part.headers[key];
  }
  headers.Range = 'bytes=' + start + '-' + end;
  return headers;
}

/**
 * בדיקה מול Drive כמה בייטים באמת נקלטו, למקרה של המשך אחרי הפסקה.
 * @returns {number} ההיסט להמשך, או -1 אם ההעלאה כבר הושלמה
 */
function probeUploadOffset_(part) {
  const res = HTTP_.fetch(part.sessionUri, {
    method: 'put',
    headers: { 'Content-Range': 'bytes */' + (part.totalBytes || '*') },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 200 || code === 201) return -1;
  if (code === 308) return ackedBytes_(res, part.sentBytes);
  throw new Error('בדיקת מצב סשן החזירה ' + code);
}

/**
 * כותרת Range בתשובת 308 נראית כך: "bytes=0-8388607".
 * המשמעות היא שהבייט הבא לשליחה הוא 8388608.
 */
function ackedBytes_(res, fallback) {
  const range = header_(res, 'range');
  if (!range) return fallback;
  const m = String(range).match(/bytes=0-(\d+)/);
  return m ? parseInt(m[1], 10) + 1 : fallback;
}

function totalFromContentRange_(res) {
  const cr = header_(res, 'content-range');
  if (!cr) return 0;
  const m = String(cr).match(/\/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * getAllHeaders מחזיר מפתחות באותיות רישיות משתנות, ולעיתים מערך
 * כשהכותרת הופיעה יותר מפעם אחת. שתי המלכודות מטופלות כאן.
 */
function header_(res, name) {
  const all = res.getAllHeaders();
  const want = name.toLowerCase();
  for (const key in all) {
    if (key.toLowerCase() === want) {
      const v = all[key];
      return Array.isArray(v) ? v[v.length - 1] : v;
    }
  }
  return '';
}

function guardSize_(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb > CONFIG.MAX_FILE_MB) {
    throw new Error('הקובץ שוקל ' + Math.round(mb) + 'MB, מעל התקרה שהוגדרה (' +
                    CONFIG.MAX_FILE_MB + 'MB)');
  }
}
