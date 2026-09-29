/**
 * התראות במייל.
 *
 * המשתמש לא נשאר עם החלון פתוח בזמן הורדה ארוכה, ולכן ההודעה במייל היא
 * הדרך העיקרית לדעת שהקובץ מוכן. MailApp נותן 100 מיילים ביום בחשבון רגיל.
 */

function notifyRecipient_(job) {
  return CONFIG.NOTIFY_EMAIL || job.requester || ownerEmail_();
}

function ownerEmail_() {
  try { return Session.getEffectiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function notifySuccess_(job) {
  const to = notifyRecipient_(job);
  if (!to) return;

  const prog = jobProgress_(job);
  const lines = [];

  if (job.strategy === 'dual') {
    const merge = mergeCommand_(job);
    lines.push('שתי הרצועות נשמרו בדרייב, בתיקייה משלהן.');
    lines.push('');
    job.parts.forEach(function (p) {
      lines.push('  ' + p.fileName + '  (' + Math.round(p.totalBytes / 1048576) + 'MB)');
    });
    lines.push('');
    lines.push('למיזוג לקובץ אחד, מאותה תיקייה במחשב שלכם:');
    lines.push('');
    lines.push('  ' + (merge ? merge.command : ''));
    lines.push('');
    lines.push('זו העתקת זרמים בלבד, ולכן נמשכת שניות ולא פוגעת באיכות.');
  } else {
    lines.push('הקובץ מוכן ונשמר בדרייב.');
    lines.push('');
    lines.push('שם: ' + job.parts[0].fileName);
    lines.push('גודל: ' + Math.round(prog.totalBytes / 1048576) + 'MB');
  }

  lines.push('');
  lines.push('מקור: ' + job.url);
  lines.push(job.driveUrl);

  sendMail_(to, 'הורדה הושלמה: ' + job.title, lines.join('\n'));
}

function notifyFailure_(job) {
  const to = notifyRecipient_(job);
  if (!to) return;

  const prog = jobProgress_(job);
  const body = [
    'ההורדה נכשלה אחרי ' + job.attempts + ' ניסיונות.',
    '',
    'מקור: ' + job.url,
    'שגיאה: ' + job.error,
    prog.sentBytes ? 'הועבר עד הכישלון: ' + Math.round(prog.sentBytes / 1048576) + 'MB' : '',
    '',
    'הלוג המלא נמצא בעורך Apps Script תחת Executions.',
  ].filter(Boolean).join('\n');

  sendMail_(to, 'הורדה נכשלה', body);
}

/**
 * מייל אחד בסיום עבודת ערוץ שלם, במקום מייל לכל סרטון. עבור ערוץ עם
 * מאות סרטונים ההבדל הוא בין הודעה אחת קריאה לתיבת דואר מוצפת.
 */
function notifyChannelDone_(manifest) {
  const to = manifest.requester || ownerEmail_();
  if (!to) return;

  const body = [
    'הורדת הערוץ "' + manifest.channel + '" הסתיימה.',
    '',
    '✅ ירדו: ' + manifest.doneCount,
    '❌ נכשלו: ' + manifest.failedCount,
    '⛔ נחסמו על ידי יוטיוב: ' + (manifest.blockedCount || 0),
    '',
    'https://drive.google.com/drive/folders/' + manifest.folderId,
  ].join('\n');

  sendMail_(to, 'הורדת ערוץ הושלמה: ' + manifest.channel, body);
}

function notifyUnrecognized_(values) {
  const to = ownerEmail_();
  if (!to) return;

  const body = [
    'ההורדה לא התחילה: לא נמצא קישור ליוטיוב במה שנשלח בטופס.',
    '',
    'מה שנשלח:',
    values.join('\n'),
    '',
    'יש להעתיק את הקישור מתוך יוטיוב עצמו (כפתור "שיתוף" או שורת הכתובת) ולשלוח שוב.',
  ].join('\n');

  sendMail_(to, 'הורדה לא התחילה: הקישור לא זוהה', body);
}

/** כשל בשליחת מייל לא אמור להפיל עבודה שכבר הצליחה. */
function sendMail_(to, subject, body) {
  try {
    MailApp.sendEmail(to, subject, body);
  } catch (e) {
    console.warn('שליחת מייל נכשלה: ' + e.message);
  }
}
