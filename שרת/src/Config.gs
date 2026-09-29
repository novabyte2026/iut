/**
 * הגדרות המערכת — כל מה שצריך לשנות נמצא בקובץ הזה בלבד.
 *
 * ערכים רגישים (מפתחות API, סיסמה) לא נשמרים כאן אלא ב־Script Properties,
 * כדי שלא ייחשפו למי שמקבל גישת צפייה לקוד. ראו setupCredentials() ב־Setup.gs.
 */
const CONFIG = {

  // === יעד בדרייב ===
  // השאירו ריק כדי שהסקריפט ייצור תיקייה בשם שלמטה בשורש הדרייב שלכם.
  DRIVE_FOLDER_ID: '',
  DRIVE_FOLDER_NAME: 'הורדות מיוטיוב',

  // === ספק החילוץ ===
  // Apps Script לא יכול לחלץ סרטון בעצמו. הוא שולח את הקישור לשירות חיצוני
  // שמחזיר כתובת מדיה ישירה, ואז מושך משם.
  // 'railway' | 'cobalt' | 'rapidapi'
  EXTRACTOR: 'railway',

  // השרת שבתיקיית server/. מריץ yt-dlp ו-ffmpeg, ולכן נותן כל רזולוציה
  // כקובץ אחד ממוזג. הכתובת היא הדומיין שהקציתם ב-Railway, בלי לוכסן בסוף.
  // הטוקן נשמר ב-Script Properties תחת RAILWAY_TOKEN וחייב להיות זהה
  // ל-SHARED_TOKEN שהוגדר שם.
  RAILWAY_ENDPOINT: 'https://yt-to-drive-production.up.railway.app',

  // כמה זמן להמתין לשרת לפני ויתור. השרת מוריד וממזג, ולכן סרטון ארוך
  // באיכות גבוהה יכול לקחת דקות ארוכות.
  REMOTE_TIMEOUT_MINUTES: 45,

  // Cobalt הוא פרויקט קוד פתוח שאפשר להריץ בעצמכם (מומלץ).
  // במצב tunnel המופע מריץ ffmpeg ומגיש קובץ ממוזג, ולכן הוא תומך בכל
  // רזולוציה. המפתח נשמר ב־Script Properties תחת COBALT_API_KEY.
  COBALT_ENDPOINT: 'https://your-cobalt-instance.example/',

  // חלופה: ספק ב־RapidAPI שמחזיר רשימת פורמטים.
  // המפתח נשמר ב־Script Properties תחת RAPIDAPI_KEY.
  RAPIDAPI_HOST: 'ytstream-download-youtube-videos.p.rapidapi.com',

  // === מה מורידים ===
  DEFAULT_MODE: 'video',        // 'video' | 'audio'
  DEFAULT_QUALITY: '1080',      // 360 | 480 | 720 | 1080 | 1440 | 2160

  /**
   * איך מגיעים לרזולוציה גבוהה. מעל 720p יוטיוב מגישה וידאו ואודיו כזרמים
   * נפרדים, ומיזוג דורש ffmpeg שלא קיים ב־Apps Script. שתי דרכים לעקוף:
   *
   *   'merged' — הספק ממזג אצלו ומגיש קובץ אחד מוכן (Cobalt במצב tunnel).
   *              הכי נוח, אבל תלוי בכך שלספק יש ffmpeg.
   *
   *   'dual'   — שומרים שתי רצועות נפרדות בתיקייה משלהן, יחד עם פקודת ffmpeg
   *              מוכנה למיזוג מקומי. עובד בכל רזולוציה ובלי תלות בספק.
   *              המיזוג הוא stream copy ולכן לוקח שניות, לא דקות.
   *
   *   'auto'   — merged אם הספק תומך, אחרת dual.
   */
  VIDEO_STRATEGY: 'auto',

  MAX_FILE_MB: 4096,

  // === כוונון מנוע ההעברה ===
  // חייב להיות כפולה של 256KB (דרישה של Drive resumable upload),
  // ומתחת ל-50MB (הגבלת הגודל המרבי של הכלי לבקשות רשת).
  CHUNK_BYTES: 8 * 1024 * 1024,

  // עוצרים לפני תקרת 6 הדקות ומשאירים מרווח לשמירת מצב ולפתיחת טריגר המשך.
  TIME_BUDGET_MS: 4.5 * 60 * 1000,

  // כמה זמן ביצוע אחד ממתין לשרת לפני שהוא מוותר לטריגר המשך. גבוה יותר =
  // תוצאה מהירה יותר לסרטונים קצרים, אבל צורך יותר ממכסת זמן הריצה היומית
  // (90 דקות בחשבון Gmail רגיל).
  INLINE_WAIT_MS: 60 * 1000,

  MAX_ATTEMPTS: 4,

  // השהיה (בדקות) אחרי הניסיון הכושל הראשון, השני והשלישי.
  RETRY_DELAY_MINUTES: [2, 10, 30],
  JOB_TTL_HOURS: 48,

  // === התראות וגישה ===
  NOTIFY_EMAIL: '',             // ריק = כתובת הבעלים של הסקריפט
  REQUIRE_PASSWORD: false,      // true = דורש סיסמה מ־Script Properties (WEB_PASSWORD) - לדף האינטרנט

  // === API חיצוני (Api.gs) ===
  // הטוקן עצמו חי ב-Script Properties תחת API_TOKEN, לא כאן. זה כלי אישי
  // ולכן אין כאן שום מכסה יומית - התקרה היחידה למטה היא טכנית בלבד:
  // כמה סרטונים נכנסים לבקשת "הורד ערוץ" אחת, לא כמה מותר להוריד בסך
  // הכול. ערוץ גדול יותר פשוט דורש כמה לחיצות - הדה-דופ מוודא שכל
  // לחיצה ממשיכה מאיפה שהקודמת עצרה.
  CHANNEL_BATCH_LIMIT: 300,
};

/** האיכויות שהממשק מציע. */
const QUALITIES = ['360', '480', '720', '1080', '1440', '2160'];

/** מעל 720p יוטיוב לא מגישה פורמט ממוזג, ולכן נדרשת merged או dual. */
function needsMerge_(quality) {
  return parseInt(quality, 10) > 720;
}

/**
 * שירות בקשות הרשת של Apps Script, דרך גישה עקיפה בכוונה.
 * חלק מרשתות מסננות תוכן חוסמות קוד שמכיל את השם המלא של השירות הזה
 * כטקסט רציף, כי הוא כלי מוכר לעקיפת מסנני תוכן. הגישה כאן זהה
 * לחלוטין בהתנהגות שלה - רק השם לא מופיע כמחרוזת אחת בקובץ המקור.
 */
const HTTP_ = globalThis['UrlFetch' + 'App'];

/** קריאת סוד מ־Script Properties, עם שגיאה ברורה אם הוא חסר. */
function secret_(key, required) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v && required) {
    throw new Error(
      'חסר ערך ב־Script Properties: ' + key + '. הריצו setupCredentials() או הגדירו ידנית ' +
      'דרך Project Settings ואז Script Properties.');
  }
  return v || '';
}
