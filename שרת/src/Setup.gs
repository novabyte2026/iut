/**
 * פונקציות התקנה — מריצים אותן ידנית פעם אחת מעורך Apps Script.
 */

/**
 * הרצה ראשונה. פותחת דיאלוג הרשאות, יוצרת את תיקיית היעד ומתקינה
 * את טריגר רשת הביטחון.
 *
 * נוגעים כאן גם בשירות בקשות הרשת ובדואר, ולא רק בדרייב: טריגר רקע
 * (כמו onFormSubmit) לא יכול לבקש הרשאה חדשה בעצמו כי אין שם משתמש
 * שילחץ "אשר", ולכן דיאלוג ההרשאה היחיד שנפתח כאן צריך לבקש הכול מראש.
 */
function setup() {
  const folderId = targetFolderId_();
  const folder = DriveApp['getFolderById'](folderId);
  HTTP_.fetch('https://www.google.com', { muteHttpExceptions: true });
  MailApp.getRemainingDailyQuota();

  // טריגר גיבוי כל 15 דקות. הוא כמעט תמיד מסיים מיד ולכן כמעט לא צורך
  // מהמכסה היומית, אבל הוא מה שמציל עבודה שטריגר ההמשך שלה אבד.
  const already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'watchdog';
  });
  if (!already) {
    ScriptApp.newTrigger('watchdog').timeBased().everyMinutes(15).create();
  }

  console.log('תיקיית היעד: ' + folder.getName() + ' (' + folderId + ')');
  console.log('כתובת התיקייה: ' + folder.getUrl());
  console.log('ההתקנה הושלמה. כעת פרסמו את הפרויקט כאפליקציית אינטרנט.');
}

/**
 * יוצר טופס Google Forms חדש עם שאלת הקישור (חובה), שאלת פורמט ושאלת
 * איכות, ומחבר אותו לפרויקט הזה מיד - בלי צורך להעתיק מזהה טופס ידנית.
 * מריצים פעם אחת. הכתובות (עריכה ומילוי) נדפסות ביומן הביצוע.
 */
function createDownloadForm() {
  const form = FormApp.create('הורדה מיוטיוב לדרייב');
  form.setDescription('הדביקו קישור לסרטון יוטיוב, ובחרו פורמט ואיכות אם תרצו.');

  form.addTextItem()
      .setTitle('קישור ליוטיוב')
      .setRequired(true);

  form.addMultipleChoiceItem()
      .setTitle('פורמט')
      .setChoiceValues(['וידאו', 'אודיו'])
      .setRequired(false);

  form.addListItem()
      .setTitle('איכות')
      .setChoiceValues(QUALITIES)
      .setRequired(false);

  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();

  console.log('הטופס נוצר וטריגר ההגשה חובר.');
  console.log('כתובת לעריכה: ' + form.getEditUrl());
  console.log('כתובת למילוי (זו שמשתפים): ' + form.getPublishedUrl());
}

/**
 * חיבור טריגר הטופס לפרויקט הזה, לטופס שכבר קיים.
 *
 * למה בקוד ולא מהממשק: הפרויקט הזה עצמאי (standalone), ולכן באשף
 * Add Trigger בעורך לא תמיד מופיעה האפשרות "From form" - היא שמורה
 * לסקריפט שמוצמד לטופס. במקום להצמיד, מתקינים כאן טריגר "on form submit"
 * שמצביע על הטופס לפי המזהה שלו.
 *
 * את מזהה הטופס לוקחים מכתובת העריכה של הטופס:
 *   https://docs.google.com/forms/d/ >>> FORM_ID <<< /edit
 * שימו לב: זה מזהה העריכה (d/.../edit), לא הכתובת של viewform שממלאים בה.
 *
 * הדביקו את המזהה למטה והריצו את הפונקציה פעם אחת.
 */
function installFormTrigger() {
  const FORM_ID = '1Vp_vkxVVfDPGTQHeJBqdff9w7OPtWgUuqOCd1owCV1U';

  if (!FORM_ID) {
    console.log('לא הוגדר FORM_ID. פתחו את הטופס בעריכה, העתיקו את המזהה ' +
                'מהכתובת (החלק שבין d/ ל-/edit), הדביקו למעלה והריצו שוב.');
    return;
  }

  const form = FormApp.openById(FORM_ID);   // מאמת שהמזהה תקין ושיש הרשאה

  // מונעים כפילות: טריגר טופס נוסף היה פותח שתי עבודות לכל שליחה.
  const existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'onFormSubmit';
  });
  if (existing.length) {
    console.log('טריגר טופס כבר קיים. לא נוצר טריגר נוסף.');
    return;
  }

  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();
  console.log('טריגר הטופס הותקן עבור: "' + form.getTitle() + '".');
  console.log('שלחו עכשיו תשובת בדיקה בטופס, ואז בדקו ב-showQueue() שנפתחה עבודה.');
}

/**
 * שמירת סודות ב־Script Properties.
 * מלאו את הערכים, הריצו פעם אחת, ואז מחקו אותם מהקוד.
 */
function setupCredentials() {
  const values = {
    // RAILWAY_TOKEN: '',   // חייב להיות זהה ל-SHARED_TOKEN שבשרת
    // API_TOKEN: '',       // הטוקן שה-userscript שולח בכל בקשה (ראו Api.gs)
    // COBALT_API_KEY: '',
    // RAPIDAPI_KEY: '',
    // WEB_PASSWORD: '',
  };

  const clean = {};
  Object.keys(values).forEach(function (k) {
    if (values[k]) clean[k] = values[k];
  });

  if (!Object.keys(clean).length) {
    console.log('לא הוגדרו ערכים. בטלו את ההערה בשורות הרלוונטיות ומלאו אותן.');
    return;
  }
  PropertiesService.getScriptProperties().setProperties(clean, false);
  console.log('נשמרו: ' + Object.keys(clean).join(', ') + '. מחקו כעת את הערכים מהקוד.');
}

/** מדפיס טוקן אקראי חדש. מתאים גם ל-RAILWAY_TOKEN וגם ל-API_TOKEN. */
function generateToken() {
  const bytes = [];
  for (let i = 0; i < 32; i++) bytes.push(Math.floor(Math.random() * 256));
  const hex = bytes.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  console.log(hex);
}

/**
 * בדיקת doPost בלי לפרסם כלום ובלי לצאת החוצה: מדמה קריאה כמו שה-
 * userscript שולח, ומדפיסה בדיוק את מה שהוא היה מקבל בחזרה.
 * מחייב שכבר הוגדר API_TOKEN (setupCredentials) ושהתור נקי מספיק
 * שאפשר לזהות את התוצאה.
 */
function testApiSubmit() {
  const fakeRequest = {
    postData: {
      contents: JSON.stringify({
        token: secret_('API_TOKEN', true),
        action: 'submit',
        url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        mode: 'video',
        quality: '720',
      }),
    },
  };
  console.log(doPost(fakeRequest).getContent());
}

/**
 * בדיקת שפיות מקצה לקצה בלי לגעת בתור: מוודאת שהספק מגיב,
 * שהוא מחזיר כתובת, ושהכתובת תומכת בבקשות Range.
 */
function testExtractor() {
  const job = {
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',   // Big Buck Bunny, רישיון חופשי
    mode: 'video',
    quality: CONFIG.DEFAULT_QUALITY,
  };

  const plan = resolvePlan_(job);
  console.log('כותרת: ' + plan.title);
  console.log('אסטרטגיה: ' + plan.strategy +
              (plan.strategy === 'dual' ? ' (שתי רצועות, מיזוג מקומי)'
                                        : ' (קובץ אחד מוכן)'));
  console.log('חלקים: ' + plan.parts.length);

  // כל חלק נבדק בנפרד: מספיק שרצועה אחת לא תומכת ב־Range כדי שהעבודה
  // תיתקע באמצע, ועדיף לגלות את זה כאן ולא אחרי 300MB.
  plan.parts.forEach(function (p, i) {
    console.log('--- חלק ' + (i + 1) + ': ' + p.kind + ' (.' + p.ext + ')' +
                (p.height ? ' ' + p.height + 'p' : ''));

    const probe = HTTP_.fetch(p.url, {
      headers: { Range: 'bytes=0-1023' },
      muteHttpExceptions: true,
    });
    const code = probe.getResponseCode();
    console.log('    בדיקת Range: ' + code + (code === 206 ? ' תקין' : ' בעייתי'));

    if (code === 206) {
      console.log('    גודל: ' + Math.round(totalFromContentRange_(probe) / 1048576) + 'MB');
    } else {
      console.log('    בלי תמיכה ב־Range אי אפשר להעביר בנתחים, וקבצים מעל 50MB ייכשלו.');
    }
  });

  if (plan.strategy === 'dual') {
    const fake = { title: plan.title, url: job.url, parts: plan.parts.map(function (p) {
      return { kind: p.kind, mimeType: p.mimeType, height: p.height,
               fileName: safeFileName_(plan.title) +
                         (p.kind === 'video' ? ' - וידאו' : ' - אודיו') + '.' + p.ext };
    }) };
    console.log('פקודת המיזוג שתימסר: ' + mergeCommand_(fake).command);
  }
}

/**
 * אבחון השרת ב-Railway מול יוטיוב, בלי להוריד כלום ובלי לגעת בתור.
 * השרת מריץ yt-dlp על סרטון בדיקה ומחזיר: האם עבר, השגיאה אם לא,
 * מצב העוגיות (שמות בלבד, בלי ערכים) והאם ספק ה-PO Token פעיל.
 * זו הדרך לבדוק את השרת מהרשת הביתית, שממנה אין גישה ישירה אליו.
 */
function testServer() {
  const res = HTTP_.fetch(railwayBase_() + '/api/diag', {
    headers: railwayAuth_(),
    muteHttpExceptions: true,
  });
  const body = safeJson_(res.getContentText());
  if (res.getResponseCode() !== 200 || !body) {
    console.log('השרת החזיר ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 500));
    return;
  }

  console.log(body.ok ? '✅ השרת הצליח לקרוא את סרטון הבדיקה: ' + body.chosen
                      : '❌ השרת נכשל: ' + body.error);
  const c = body.cookies || {};
  console.log('עוגיות: ' + (c.configured ? (c.loggedIn ? 'חשבון מחובר' : 'לא של חשבון מחובר') +
              ' (' + (c.youtubeCookies || 0) + ' של יוטיוב)' : 'לא הוגדרו'));
  console.log('ספק PO Token: ' + (body.potProvider ? 'פעיל' : 'לא פעיל'));
  (body.warnings || []).forEach(function (w) { console.log('אזהרה: ' + w); });
  (body.debug || []).forEach(function (l) { console.log('  ' + l); });
}

/** הצגת מצב התור, שימושי לאבחון. */
function showQueue() {
  const jobs = readIndex_().map(getJob_).filter(Boolean);
  if (!jobs.length) { console.log('התור ריק.'); return; }

  jobs.forEach(function (j) {
    const prog = jobProgress_(j);
    const parts = j.parts.length > 1 ? ' [' + (j.partIndex + 1) + '/' + j.parts.length + ']' : '';
    console.log([j.id, j.status + parts, prog.percent + '%',
                 j.title || j.url, j.error].filter(Boolean).join(' | '));
  });
}

/**
 * איפוס התור בלבד: מוחק את כל העבודות ואת טריגרי ההמשך הזמניים של
 * processQueue. לא נוגע בקבצים בדרייב, ולא בטריגרים הקבועים (watchdog,
 * onFormSubmit) - אלה הותקנו פעם אחת דרך setup()/installFormTrigger()
 * ואיפוס התור לא אמור לדרוש התקנה מחדש שלהם.
 */
function resetAll() {
  readIndex_().forEach(function (id) { props_().deleteProperty(JOB_PREFIX + id); });
  props_().deleteProperty(JOB_INDEX_KEY);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processQueue') ScriptApp.deleteTrigger(t);
  });
  console.log('התור אופס. הטריגרים הקבועים (watchdog, onFormSubmit) נשארו כמו שהם.');
}



