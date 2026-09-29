/**
 * הרכבת הוראות המיזוג למצב dual.
 *
 * המיזוג עצמו לא קורה כאן — Apps Script לא מריץ ffmpeg, ומימוש mux ב־
 * JavaScript היה מחייב להחזיק את שני הזרמים המלאים בזיכרון כדי לבנות את
 * אינדקס ה־MP4. זה נופל על מגבלת הזיכרון הרבה לפני מגבלת ששת הדקות.
 *
 * מה שכן אפשר: לבחור רצועות שמתמזגות בהעתקה בלבד, ולהגיש פקודה מוכנה.
 * -c copy לא מקודד מחדש, ולכן מיזוג של סרטון שעה לוקח שניות בודדות.
 */

/**
 * בוחר מכולת יעד לפי הרצועות שנבחרו.
 * mp4 + m4a נשאר mp4, webm + weba נשאר webm, וערבוב הולך ל־mkv
 * שהיא המכולה היחידה שבולעת כל צירוף בלי קידוד מחדש.
 */
function mergeContainer_(videoPart, audioPart) {
  const v = containerFamily_(videoPart.mimeType);
  const a = containerFamily_(audioPart.mimeType);
  if (v === 'mp4' && a === 'mp4') return 'mp4';
  if (v === 'webm' && a === 'webm') return 'webm';
  return 'mkv';
}

/** @returns {{command: string, output: string}} */
function mergeCommand_(job) {
  const v = partOfKind_(job, 'video');
  const a = partOfKind_(job, 'audio');
  if (!v || !a) return null;

  const container = mergeContainer_(v, a);
  const output = safeFileName_(job.title) + '.' + container;

  // -movflags +faststart מזיז את אינדקס ה־MP4 לתחילת הקובץ, כך שהוא
  // מתחיל להתנגן לפני שהורידו אותו במלואו. רלוונטי רק ל־mp4.
  const flags = container === 'mp4' ? ' -movflags +faststart' : '';

  const command = 'ffmpeg -i "' + v.fileName + '" -i "' + a.fileName + '"' +
                  ' -c copy' + flags + ' "' + output + '"';
  return { command: command, output: output };
}

function partOfKind_(job, kind) {
  return job.parts.filter(function (p) { return p.kind === kind; })[0] || null;
}

/**
 * כותב לתיקיית העבודה קובץ הוראות קצר. עדיף על הודעת מייל בלבד:
 * ההוראות יושבות ליד הקבצים, וגם מי שפותח את התיקייה חודש אחר כך
 * מבין מיד מה לעשות עם שני הקבצים האלה.
 */
function writeMergeInstructions_(job) {
  const merge = mergeCommand_(job);
  if (!merge) return;

  const v = partOfKind_(job, 'video');
  const lines = [
    job.title,
    '',
    'התיקייה מכילה שתי רצועות נפרדות. כך יוטיוב מגישה כל איכות מעל 720p,',
    'ולכן צריך למזג אותן לקובץ אחד.',
    '',
    'הורידו את שני הקבצים לאותה תיקייה, ומשם:',
    '',
    '    ' + merge.command,
    '',
    'המיזוג הוא העתקת זרמים בלבד (-c copy) ולכן נמשך שניות ולא פוגע באיכות.',
    'צריך ffmpeg מותקן: https://ffmpeg.org/download.html',
    '',
    'רצועת וידאו: ' + v.fileName + (v.height ? '  (' + v.height + 'p)' : ''),
    'רצועת אודיו: ' + partOfKind_(job, 'audio').fileName,
    'תוצאה:       ' + merge.output,
    '',
    'מקור: ' + job.url,
  ];

  const folder = DriveApp['getFolderById'](job.folderId);
  folder.createFile('איך למזג.txt', lines.join('\n'), MimeType.PLAIN_TEXT);
}
