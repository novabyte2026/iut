/**
 * נקודות הכניסה למערכת והמנוע שמריץ את התור.
 *
 * זרימה: בקשה נכנסת (דף אינטרנט או טופס) -> נוצרת עבודה בתור -> מופעל
 * טריגר חד-פעמי -> processQueue רץ עד שנגמר הזמן -> אם נשארה עבודה,
 * הוא פותח לעצמו טריגר המשך. כך הורדה של קובץ גדול נמשכת על פני כמה
 * ביצועים בלי שהמשתמש מחזיק חלון פתוח.
 */

// === נקודות כניסה ===

function doGet(e) {
  const page = HtmlService.createTemplateFromFile('Index');
  page.requirePassword = CONFIG.REQUIRE_PASSWORD;
  page.qualities = QUALITIES;
  page.defaultQuality = CONFIG.DEFAULT_QUALITY;
  return page.evaluate()
    .setTitle('הורדה מיוטיוב לדרייב')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** נקראת מהדף דרך google.script.run. */
function submitRequest(payload) {
  payload = payload || {};

  if (CONFIG.REQUIRE_PASSWORD && payload.password !== secret_('WEB_PASSWORD', true)) {
    throw new Error('סיסמה שגויה');
  }
  const url = resolveYouTubeUrl_(payload.url);
  if (!url) {
    throw new Error('נא להזין קישור יוטיוב תקין');
  }
  const quality = QUALITIES.indexOf(String(payload.quality)) > -1
    ? String(payload.quality) : CONFIG.DEFAULT_QUALITY;

  const job = enqueueJob_(url, payload.mode, quality, activeEmail_());
  kickQueue_();
  return { id: job.id, status: job.status };
}

/** נקראת מהדף כדי לצייר את סרגל ההתקדמות. */
function jobStatus(id) {
  const job = getJob_(id);
  if (!job) return { status: 'missing' };

  const prog = jobProgress_(job);
  const merge = job.strategy === 'dual' ? mergeCommand_(job) : null;

  // בשלב ההכנה הסרגל משקף את התקדמות השרת, ובשלב ההעברה את הבייטים
  // שהגיעו לדרייב. שני מדדים שונים, ולכן הסרגל מתאפס ביניהם - הכיתוב
  // שמעליו הוא מה שמסביר למשתמש איפה הוא נמצא.
  const percent = job.status === 'done' ? 100
                : job.status === 'preparing' ? (job.remoteProgress || 0)
                : prog.percent;

  return {
    status: job.status,
    title: job.title,
    strategy: job.strategy,
    percent: percent,
    stage: job.remoteStage || '',
    totalMB: prog.totalBytes ? Math.round(prog.totalBytes / 1048576) : 0,
    partCount: job.parts.length,
    partIndex: job.partIndex,
    partKind: (currentPart_(job) || {}).kind || '',
    driveUrl: job.driveUrl,
    mergeCommand: merge ? merge.command : '',
    error: job.error,
  };
}

/**
 * טריגר להתקנה על טופס Google Forms, אם בחרתם בממשק הזה.
 *
 * הזיהוי הוא לפי תוכן ולא לפי מיקום השאלות בכוונה: הטופס עשוי להכיל שאלה
 * אחת בלבד (רק הקישור), או שאלות נוספות בסדר כלשהו, ואפילו שדה איסוף מייל.
 * במקום להניח שהקישור הוא answers[0] - הנחה ששוברת את הטריגר בשקט ברגע
 * שמישהו מוסיף או מסדר מחדש שאלה - סורקים את כל התשובות ומזהים כל אחת
 * לפי מה שכתוב בה.
 */
function onFormSubmit(e) {
  const values = e.response.getItemResponses().map(function (item) {
    return flattenAnswer_(item.getResponse());
  });

  let url = '';
  let urlIndex = -1;
  for (let i = 0; i < values.length && !url; i++) {
    url = resolveYouTubeUrl_(values[i]);
    if (url) urlIndex = i;
  }
  if (!url) {
    // בלי זה שליחה עם קישור לא מזוהה פשוט נעלמה, והמשתמש חיכה לשווא.
    console.warn('לא נמצא קישור יוטיוב תקין בתשובות הטופס.', { values: values });
    notifyUnrecognized_(values);
    return;
  }

  // הקישור עצמו מכיל את הטקסט 'youtube', ולכן מזהים פורמט/איכות רק
  // בשאר התשובות - אחרת הקישור עצמו היה נספר בטעות כשאלת הפורמט.
  const others = values.filter(function (v, i) { return i !== urlIndex; });

  const mode = others.some(function (v) {
    return v.indexOf('אודיו') > -1 || /\baudio\b/i.test(v);
  }) ? 'audio' : CONFIG.DEFAULT_MODE;

  let quality = '';
  others.forEach(function (v) {
    const m = String(v).match(/\b(360|480|720|1080|1440|2160)\b/);
    if (m) quality = m[1];
  });

  try {
    enqueueJob_(url, mode, QUALITIES.indexOf(quality) > -1 ? quality : null,
                e.response.getRespondentEmail() || '');
  } catch (err) {
    // שליחת טופס שלא נקלטה בתור לא משאירה שום עקבה אחרת - בלי המייל הזה
    // המשתמש פשוט מחכה לקובץ שלא יגיע.
    sendMail_(ownerEmail_(), 'הורדה לא נקלטה - יש לשלוח שוב',
              'הבקשה לא נקלטה בגלל תקלה זמנית. יש לשלוח את הטופס שוב עם הקישור:\n\n' +
              url + '\n\nפרטי התקלה: ' + err.message);
    throw err;
  }

  // טריגר ההמשך נפתח קודם, כרשת ביטחון. אחר כך מתחילים לעבד כבר בתוך
  // הביצוע הזה - זה חוסך את ההמתנה לטריגר הראשון, שבפועל לוקחת כמה דקות.
  kickQueue_();
  processQueue();
}

/** תשובת טופס יכולה להיות מחרוזת (שאלה רגילה) או מערך (תיבות סימון/רשת). */
function flattenAnswer_(response) {
  if (Array.isArray(response)) return response.join(' ').trim();
  return String(response == null ? '' : response).trim();
}

// === מנוע התור ===

/**
 * מעבד עבודות עד שנגמר הזמן. נעילה מונעת ריצה כפולה - בלעדיה שני
 * טריגרים חופפים היו כותבים לאותו סשן העלאה ומשחיתים את הקובץ.
 */
function processQueue() {
  // נעילה נפרדת מזו של הוספה לתור (getScriptLock ב-Jobs.gs). ריצה של התור
  // מחזיקה את הנעילה דקות ארוכות; אילו זו הייתה אותה נעילה, שליחת טופס
  // בזמן הזה הייתה נכשלת ב-Lock timeout והבקשה הייתה הולכת לאיבוד.
  // כל ההפעלות רצות כבעלים של הסקריפט, ולכן נעילת המשתמש משותפת לכולן.
  const lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) return;          // ריצה אחרת כבר עובדת

  const deadline = Date.now() + CONFIG.TIME_BUDGET_MS;
  const inlineWaitUntil = Math.min(deadline, Date.now() + CONFIG.INLINE_WAIT_MS);
  try {
    // ממשיכים כל עוד משהו זז. כשכל מה שנשאר ממתין לשרת, ממתינים כאן עוד
    // קצת במקום לסיים מיד: טריגר המשך של Apps Script מגיע בפועל רק אחרי
    // דקה-שלוש, וסרטון קצר מוכן בשרת תוך שניות.
    while (Date.now() < deadline) {
      let progressed = false;
      const jobs = pendingJobs_();
      for (let i = 0; i < jobs.length && Date.now() < deadline; i++) {
        if (advanceJob_(jobs[i], deadline)) progressed = true;
      }
      if (progressed) continue;
      if (!jobs.length || Date.now() + 15000 > inlineWaitUntil) break;
      Utilities.sleep(15000);
    }
    purgeOldJobs_();
    purgeOldManifests_();
  } finally {
    lock.releaseLock();
  }

  const pending = pendingJobs_();
  if (!pending.length) return;

  // כשכל מה שנשאר הוא המתנה (לשרת, או להשהיה לפני ניסיון חוזר), בודקים
  // בתדירות נמוכה. מכסת הטריגרים היומית היא 90 דקות, ופולינג כל 10 שניות
  // היה שורף אותה על כלום.
  const now = Date.now();
  const delays = pending.map(function (j) {
    if (j.notBefore > now) return (j.notBefore - now) / 1000;
    return j.status === 'preparing' ? 90 : 10;
  });
  kickQueue_(Math.ceil(Math.min.apply(null, delays)));
}

/**
 * מקדם עבודה בודדת מהמצב שבו היא נמצאת.
 * @returns {boolean} האם חל שינוי אמיתי (ולא רק בדיקה שהחזירה "עדיין לא")
 */
function advanceJob_(job, deadline) {
  if (job.notBefore && Date.now() < job.notBefore) return false;
  try {
    if (job.status === 'queued' || job.status === 'preparing') {
      if (!planJob_(job)) return false;     // הספק עדיין מכין
    }
    if (job.status === 'transferring') {
      transferJob_(job, deadline);
    }
    return true;
  } catch (err) {
    if (err.permanent || job.attempts >= CONFIG.MAX_ATTEMPTS) {
      failJob_(job, err.message);
    } else {
      // מחזירים לתור לניסיון נוסף. ההתקדמות שכבר נשמרה בחלקים נשמרת,
      // ולכן ניסיון חוזר לא מתחיל מאפס אלא מהבייט האחרון שאושר.
      job.status = job.parts.length ? 'transferring' : 'queued';
      job.error = String(err.message).slice(0, 500);
      // השהיה לפני הניסיון הבא. חסימת בוטים של יוטיוב על כתובת השרת היא
      // לרוב זמנית; ארבעה ניסיונות ברצף בתוך דקה פשוט נכשלו כולם יחד.
      const delays = CONFIG.RETRY_DELAY_MINUTES;
      job.notBefore = Date.now() +
        (delays[job.attempts - 1] || delays[delays.length - 1]) * 60 * 1000;
      saveJob_(job);
    }
    return true;
  }
}

/**
 * שלב א: חילוץ, בחירת אסטרטגיה, יצירת היעד בדרייב ובניית רשימת החלקים.
 * @returns {boolean} true אם התוכנית מוכנה, false אם הספק עדיין עובד
 */
function planJob_(job) {
  // ריווח בין בדיקות: בלעדיו עבודה אחת שמעבירה גורמת לעבודה ממתינה
  // להיבדק שוב ושוב בתוך אותו ביצוע, בלי שום תועלת.
  if (job.status === 'preparing' && Date.now() - job.updatedAt < 15000) return false;

  if (job.status === 'queued') {
    job.status = 'resolving';
    job.attempts++;
    saveJob_(job);
  }

  const plan = resolvePlan_(job);

  if (!plan.ready) {
    const waitedMs = Date.now() - job.createdAt;
    if (waitedMs > CONFIG.REMOTE_TIMEOUT_MINUTES * 60 * 1000) {
      throw new Error('השרת לא סיים בתוך ' + CONFIG.REMOTE_TIMEOUT_MINUTES + ' דקות');
    }
    job.status = 'preparing';
    job.remoteProgress = plan.progress || 0;
    job.remoteStage = plan.stage || '';
    job.polls++;
    saveJob_(job);
    return false;
  }

  job.strategy = plan.strategy;
  job.title = plan.title || ('youtube-' + (extractVideoId_(job.url) || job.id));

  const base = safeFileName_(job.title);
  job.folderId = resolveJobFolder_(job, plan, base);

  job.parts = plan.parts.map(function (p) {
    const suffix = p.kind === 'video' ? ' - וידאו'
                 : p.kind === 'audio' && plan.strategy === 'dual' ? ' - אודיו'
                 : '';
    const part = makePart_(p.kind, p.url, base + suffix + '.' + p.ext, p.mimeType, p.headers);
    if (p.height) part.height = p.height;
    if (p.serverPush) part.serverPush = true;
    return part;
  });

  job.partIndex = 0;
  job.status = 'transferring';
  saveJob_(job);
  return true;
}

/** שלב ב: העברת החלקים אחד אחרי השני, עם המשך מדויק בין ביצועים. */
function transferJob_(job, deadline) {
  while (job.partIndex < job.parts.length) {
    if (Date.now() > deadline) { saveJob_(job); return; }

    const part = currentPart_(job);
    if (part.done) { job.partIndex++; saveJob_(job); continue; }

    if (!part.sessionUri) {
      part.sessionUri = openUploadSession_(part.fileName, part.mimeType, job.folderId);
      part.sentBytes = 0;
      saveJob_(job);
    } else if (!part.serverPush && part.sentBytes > 0) {
      // המשך אחרי הפסקה: שואלים את Drive עד היכן הוא באמת קלט.
      // (בהעלאה מהשרת השרת עוקב בעצמו, ולכן לא שואלים כאן.)
      const offset = probeUploadOffset_(part);
      if (offset < 0) { part.done = true; }
      else { part.sentBytes = offset; }
      saveJob_(job);
    }

    if (!part.done) {
      const outcome = part.serverPush ? pushViaRailway_(job, part, deadline)
                                      : pumpPart_(job, part, deadline);
      if (outcome === 'incomplete') {
        saveJob_(job);
        return;                              // נמשיך מכאן בביצוע הבא
      }
    }
    job.partIndex++;
    saveJob_(job);
  }

  finishJob_(job);
}

/** שלב ג: סגירה — הוראות מיזוג אם צריך, קישור לתוצאה, והודעה במייל. */
function finishJob_(job) {
  if (job.strategy === 'dual') {
    writeMergeInstructions_(job);
    job.driveUrl = 'https://drive.google.com/drive/folders/' + job.folderId;
  } else {
    const id = job.parts[0].driveFileId;
    job.driveUrl = id ? 'https://drive.google.com/file/d/' + id + '/view' : '';
  }
  job.status = 'done';
  saveJob_(job);

  // משחררים את הדיסק בשרת רק עכשיו. שחרור מוקדם יותר היה מוחק את הקובץ
  // מתחת לרגליים של העברה שעדיין נמשכת על פני כמה ביצועים.
  releaseRemoteJob_(job);

  // עבודת ילד של ערוץ מדווחת לסיכום המצטבר; מייל אחד בסוף כל הערוץ
  // ולא אחד לכל סרטון.
  if (job.manifestId) onChildJobDone_(job, true);
  else notifySuccess_(job);
}

// === ניהול טריגרים ===

/**
 * פותח טריגר חד-פעמי אם אין כבר אחד ממתין.
 *
 * טריגרים חד-פעמיים ולא טריגר קבוע כל דקה: לחשבון Gmail רגיל יש מכסה של
 * 90 דקות ריצת טריגרים ליום, ופולינג מתמיד היה שורף אותה על ריצות ריקות.
 */
function kickQueue_(delaySeconds) {
  cleanupTriggers_();

  // מוחקים כל טריגר processQueue קיים במקום לספור "יש כבר 2, מספיק":
  // ל-Trigger אין API לבדוק אם הוא מושבת, וטריגר שגוגל השביתה אחרי
  // כשלים חוזרים (זה קורה בפועל) היה נספר כ"קיים" לנצח ובולם יצירת
  // טריגר עובד חדש - בדיוק המצב שתקע את התור. processQueue משתמש
  // בנעילה, כך שכפילות זמנית של טריגרים לא מזיקה.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processQueue') {
      try { ScriptApp.deleteTrigger(t); } catch (e) { /* נמחק כבר */ }
    }
  });

  ScriptApp.newTrigger('processQueue')
    .timeBased()
    .after(Math.max(10, delaySeconds || 10) * 1000)
    .create();
}

/**
 * מוחק טריגרים חד-פעמיים שכבר נצרכו. בלי זה מגיעים לתקרת 20 הטריגרים
 * לפרויקט תוך יום-יומיים של שימוש והמערכת נתקעת בשקט.
 */
function cleanupTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length < 10) return;
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'processQueue' &&
        t.getEventType() === ScriptApp.EventType.CLOCK) {
      try { ScriptApp.deleteTrigger(t); } catch (e) { /* נצרך כבר */ }
    }
  });
}

/** רשת ביטחון: מרימה עבודות שנתקעו אם טריגר המשך אבד. */
function watchdog() {
  if (pendingJobs_().length) kickQueue_();
  purgeOldJobs_();
  purgeOldManifests_();
}

// === עזר ===

/**
 * המיכל שאליו העבודה כותבת: תיקיית הערוץ אם זו עבודת ילד של עבודת ערוץ
 * (ראו Channel.gs), אחרת תיקיית ברירת המחדל. במצב dual עדיין נפתחת
 * תת-תיקייה לפי שם הסרטון בתוך המיכל, כדי ששתי הרצועות לא יתערבבו
 * עם קבצים אחרים - כולל סרטונים אחרים מאותו ערוץ.
 */
function resolveJobFolder_(job, plan, base) {
  const container = job.targetFolderId || targetFolderId_();
  if (plan.strategy !== 'dual') return container;
  return DriveApp['getFolderById'](container).createFolder(base).getId();
}

function targetFolderId_() {
  if (CONFIG.DRIVE_FOLDER_ID) return CONFIG.DRIVE_FOLDER_ID;

  const cached = props_().getProperty('AUTO_FOLDER_ID');
  if (cached) {
    try { return DriveApp['getFolderById'](cached).getId(); } catch (e) { /* נמחקה */ }
  }
  const folders = DriveApp['getFoldersByName'](CONFIG.DRIVE_FOLDER_NAME);
  const folder = folders.hasNext() ? folders.next()
                                   : DriveApp['createFolder'](CONFIG.DRIVE_FOLDER_NAME);
  props_().setProperty('AUTO_FOLDER_ID', folder.getId());
  return folder.getId();
}

/** מנקה תווים שדרייב או מערכות קבצים לא אוהבות, ושומר על עברית. */
function safeFileName_(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

function activeEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
