/**
 * שכבת החילוץ — הופכת קישור יוטיוב לתוכנית הורדה.
 *
 * זה החלק היחיד שחייב לצאת החוצה. Apps Script לא מריץ בינאריים ולכן
 * yt-dlp אינו אופציה; אנחנו רק צרכנים של התוצאה.
 *
 * התוצר הוא "תוכנית": אסטרטגיה ורשימת חלקים.
 *   merged - חלק אחד, קובץ מוכן. הספק כבר מיזג אצלו.
 *   dual   - שני חלקים, רצועת וידאו ורצועת אודיו, למיזוג מקומי.
 *
 * @typedef {{strategy: string, title: string, parts: Array}} Plan
 */

const RESOLVERS = {
  railway: planWithRailway_,
  cobalt: planWithCobalt_,
  rapidapi: planWithRapidApi_,
};

/** האם הספק יודע למזג אצלו. משפיע על החלטת 'auto'. */
const CAN_MERGE_SERVER_SIDE = { railway: true, cobalt: true, rapidapi: false };

/**
 * חילוץ אסינכרוני: ספק שצריך זמן (השרת ב-Railway מוריד וממזג) מחזיר
 * ready:false ואת ההתקדמות, והעבודה נשארת ממתינה עד הפעימה הבאה.
 * ספקים סינכרוניים פשוט לא מציינים ready והוא נחשב true.
 *
 * @returns {Plan & {ready: boolean}}
 */
function resolvePlan_(job) {
  const resolver = RESOLVERS[CONFIG.EXTRACTOR];
  if (!resolver) throw new Error('ספק חילוץ לא מוכר: ' + CONFIG.EXTRACTOR);

  const plan = resolver(job);
  if (plan && plan.ready === false) return plan;

  if (!plan || !plan.parts || !plan.parts.length) {
    throw new Error('הספק לא החזיר אף כתובת מדיה');
  }
  plan.parts.forEach(function (p) {
    if (!p.url) throw new Error('חלק מסוג ' + p.kind + ' חזר בלי כתובת');
  });
  plan.ready = true;
  return plan;
}

// === השרת ב-Railway ===

/**
 * הצד השני של המערכת. שם רצים yt-dlp ו-ffmpeg, ולכן משם מגיעה כל
 * רזולוציה כקובץ אחד ממוזג.
 *
 * העבודה לא מוכנה מיד: מזמינים אותה, מקבלים מזהה, ובודקים בכל פעימה.
 * המשיכה בפועל נעשית בנתחים מול אותה כתובת, ולכן היא נושאת את הטוקן
 * בכל בקשה - ראו part.headers.
 */
function railwayBase_() {
  return String(CONFIG.RAILWAY_ENDPOINT).replace(/\/+$/, '');
}

function railwayAuth_() {
  return { Authorization: 'Bearer ' + secret_('RAILWAY_TOKEN', true) };
}

function planWithRailway_(job) {
  const base = railwayBase_();
  const auth = railwayAuth_();

  if (!job.remoteId) {
    const res = HTTP_.fetch(base + '/api/jobs', {
      method: 'post',
      contentType: 'application/json',
      headers: auth,
      payload: JSON.stringify({ url: job.url, mode: job.mode, quality: job.quality }),
      muteHttpExceptions: true,
    });
    const body = safeJson_(res.getContentText());
    if (res.getResponseCode() >= 300 || !body || !body.id) {
      throw new Error('השרת דחה את הבקשה (' + res.getResponseCode() + '): ' +
                      res.getContentText().slice(0, 200));
    }
    job.remoteId = body.id;
    return { ready: false, progress: 0, stage: 'queued' };
  }

  const res = HTTP_.fetch(base + '/api/jobs/' + job.remoteId, {
    method: 'get',
    headers: auth,
    muteHttpExceptions: true,
  });

  // 404 = השרת הופעל מחדש והתור שלו נמצא בזיכרון בלבד. מוותרים על
  // המזהה ומזמינים מחדש בפעימה הבאה, במקום להיתקע לנצח.
  if (res.getResponseCode() === 404) {
    job.remoteId = '';
    return { ready: false, progress: 0, stage: 'queued' };
  }

  const body = safeJson_(res.getContentText());
  if (res.getResponseCode() >= 300 || !body) {
    throw new Error('בדיקת מצב בשרת החזירה ' + res.getResponseCode());
  }
  if (body.status === 'error') {
    // בלי האיפוס הניסיון הבא היה בודק שוב את אותה עבודה שכבר נכשלה בשרת,
    // וכל ארבעת הניסיונות היו "נכשלים" בלי שהשרת ניסה שוב אפילו פעם אחת.
    job.remoteId = '';
    const err = new Error('השרת: ' + (body.error || 'שגיאה לא ידועה'));
    err.permanent = Boolean(body.permanent);   // הסרטון עצמו לא זמין - אין טעם לנסות שוב
    throw err;
  }
  if (body.status !== 'ready') {
    return { ready: false, progress: body.progress || 0, stage: body.stage || '' };
  }

  const file = (body.files || [])[0];
  if (!file) throw new Error('השרת דיווח מוכן אך לא החזיר קובץ');

  const ext = extOf_(file.name) || (job.mode === 'audio' ? 'mp3' : 'mp4');
  return {
    strategy: 'merged',
    title: body.title || '',
    parts: [{
      kind: 'media',
      url: base + file.url,
      ext: ext,
      mimeType: mimeFor_(ext),
      headers: auth,
      serverPush: true,
    }],
  };
}

/**
 * העברה בדרך המהירה: השרת מעלה את הקובץ ישירות לסשן ההעלאה שפתחנו.
 * כאן רק מבקשים ממנו להתחיל ובודקים התקדמות. אם השרת מדווח כישלון,
 * החלק עובר לדרך הרגילה (pumpPart_ - משיכה בנתחים) בניסיון הבא.
 *
 * @returns {'done'|'incomplete'}
 */
function pushViaRailway_(job, part, deadline) {
  const url = railwayBase_() + '/api/jobs/' + job.remoteId;

  if (!part.pushStarted) {
    const start = HTTP_.fetch(url + '/push', {
      method: 'post',
      contentType: 'application/json',
      headers: railwayAuth_(),
      payload: JSON.stringify({ sessionUri: part.sessionUri }),
      muteHttpExceptions: true,
    });
    if (start.getResponseCode() !== 202) {
      fallBackToPull_(job, part, 'השרת סירב להעלות (' + start.getResponseCode() + ')');
    }
    part.pushStarted = true;
    saveJob_(job);
  }

  while (Date.now() < deadline) {
    const res = HTTP_.fetch(url, { headers: railwayAuth_(), muteHttpExceptions: true });

    // השרת הופעל מחדש והקובץ איננו. מתחילים את העבודה מחדש מהשרת.
    if (res.getResponseCode() === 404) {
      job.remoteId = '';
      job.parts = [];
      job.partIndex = 0;
      saveJob_(job);
      throw new Error('השרת הופעל מחדש באמצע ההעלאה; הסרטון יורד שוב');
    }

    const push = (safeJson_(res.getContentText()) || {}).push || {};
    part.totalBytes = push.totalBytes || part.totalBytes;
    part.sentBytes = push.sentBytes || 0;

    if (push.status === 'done') {
      part.driveFileId = push.fileId || '';
      part.done = true;
      saveJob_(job);
      return 'done';
    }
    if (push.status === 'error') fallBackToPull_(job, part, push.error);

    saveJob_(job);
    Utilities.sleep(5000);
  }
  return 'incomplete';
}

/** מעביר חלק לדרך הרגילה, עם סשן העלאה חדש - הישן אולי קלט חלק מהבייטים. */
function fallBackToPull_(job, part, reason) {
  part.serverPush = false;
  part.pushStarted = false;
  part.sessionUri = '';
  part.sentBytes = 0;
  saveJob_(job);
  throw new Error('העלאה ישירה מהשרת נכשלה, עובר להעברה דרך Apps Script: ' + reason);
}

/** מודיע לשרת שאפשר לפנות את הדיסק. כישלון כאן אינו קריטי. */
function releaseRemoteJob_(job) {
  if (CONFIG.EXTRACTOR !== 'railway' || !job.remoteId) return;
  try {
    HTTP_.fetch(railwayBase_() + '/api/jobs/' + job.remoteId, {
      method: 'delete',
      headers: railwayAuth_(),
      muteHttpExceptions: true,
    });
  } catch (e) {
    console.warn('שחרור העבודה בשרת נכשל: ' + e.message);
  }
}

/**
 * רשימת הסרטונים בערוץ, בלי להוריד כלום. משמש את זרימת "הורדת ערוץ" -
 * ראו Channel.gs. עובד רק מול Railway; לספקים האחרים אין נקודת קצה כזו.
 */
function listChannelVideos_(channelUrl, limit) {
  if (CONFIG.EXTRACTOR !== 'railway') {
    throw new Error('הורדת ערוץ שלם נתמכת רק עם EXTRACTOR=railway');
  }

  const url = railwayBase_() + '/api/channel?url=' + encodeURIComponent(channelUrl) +
              (limit ? '&limit=' + limit : '');
  const res = HTTP_.fetch(url, { headers: railwayAuth_(), muteHttpExceptions: true });

  const body = safeJson_(res.getContentText());
  if (res.getResponseCode() >= 300 || !body) {
    throw new Error('רשימת הערוץ נכשלה (' + res.getResponseCode() + '): ' +
                    res.getContentText().slice(0, 200));
  }
  return body; // {title, videos: [{id, title, url}]}
}

/**
 * מכריע איזו אסטרטגיה להפעיל עבור וידאו.
 * מעל 720p אין ליוטיוב פורמט ממוזג, ולכן חייבים אחת מהשתיים.
 */
function chooseStrategy_(job) {
  const pref = CONFIG.VIDEO_STRATEGY;
  if (pref === 'merged' || pref === 'dual') return pref;
  return CAN_MERGE_SERVER_SIDE[CONFIG.EXTRACTOR] ? 'merged' : 'dual';
}

// === Cobalt ===

/**
 * Cobalt מריץ ffmpeg אצלו. במצב tunnel הוא מגיש קובץ אחד ממוזג בכל
 * רזולוציה, ולכן זו הדרך הנוחה ביותר ל־1080p ומעלה.
 * הוא לא חושף רצועות נפרדות, ולכן dual אינו נתמך דרכו.
 */
function planWithCobalt_(job) {
  if (job.mode !== 'audio' && chooseStrategy_(job) === 'dual') {
    throw new Error('Cobalt לא חושף רצועות נפרדות. הגדירו VIDEO_STRATEGY לערך ' +
                    "'merged', או עברו לספק שמחזיר adaptiveFormats.");
  }

  const payload = {
    url: job.url,
    downloadMode: job.mode === 'audio' ? 'audio' : 'auto',
    videoQuality: String(job.quality || CONFIG.DEFAULT_QUALITY),
    audioFormat: 'mp3',
    filenameStyle: 'basic',
  };

  const headers = { Accept: 'application/json' };
  const key = secret_('COBALT_API_KEY', false);
  if (key) headers.Authorization = 'Api-Key ' + key;

  const res = HTTP_.fetch(CONFIG.COBALT_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: true,
  });

  const body = safeJson_(res.getContentText());
  if (res.getResponseCode() >= 300 || !body) {
    throw new Error('Cobalt החזיר ' + res.getResponseCode() + ': ' +
                    res.getContentText().slice(0, 300));
  }
  if (body.status === 'error') {
    throw new Error('Cobalt: ' + ((body.error && body.error.code) || 'שגיאה לא ידועה'));
  }
  if (body.status === 'picker') {
    throw new Error('הקישור מכיל כמה פריטים ו־Cobalt מבקש בחירה ידנית');
  }
  if (body.status !== 'tunnel' && body.status !== 'redirect') {
    throw new Error('Cobalt החזיר status לא צפוי: ' + body.status);
  }

  const ext = extOf_(body.filename || '') || (job.mode === 'audio' ? 'mp3' : 'mp4');
  return {
    strategy: 'merged',
    title: stripExt_(body.filename || ''),
    parts: [{ kind: 'media', url: body.url, ext: ext, mimeType: mimeFor_(ext) }],
  };
}

// === RapidAPI ===

/**
 * ספקי RapidAPI מחזירים את רשימת הפורמטים הגולמית של יוטיוב, ולכן דרכם
 * אפשר לקחת רצועות נפרדות ולמזג מקומית. מבנה התשובה משתנה בין ספקים —
 * זו הפונקציה שתצטרכו להתאים אם החלפתם ספק.
 */
function planWithRapidApi_(job) {
  const videoId = extractVideoId_(job.url);
  if (!videoId) throw new Error('לא הצלחתי לזהות מזהה סרטון בקישור');

  const res = HTTP_.fetch(
    'https://' + CONFIG.RAPIDAPI_HOST + '/dl?id=' + encodeURIComponent(videoId), {
      method: 'get',
      headers: {
        'X-RapidAPI-Key': secret_('RAPIDAPI_KEY', true),
        'X-RapidAPI-Host': CONFIG.RAPIDAPI_HOST,
      },
      muteHttpExceptions: true,
    });

  const body = safeJson_(res.getContentText());
  if (res.getResponseCode() >= 300 || !body) {
    throw new Error('RapidAPI החזיר ' + res.getResponseCode() + ': ' +
                    res.getContentText().slice(0, 300));
  }

  const title = body.title || '';
  const formats = [].concat(body.formats || [], body.adaptiveFormats || []);

  if (job.mode === 'audio') {
    const a = pickAudioOnly_(formats, 'any');
    if (!a) throw new Error('לא נמצאה רצועת אודיו');
    return {
      strategy: 'merged',
      title: title,
      parts: [{ kind: 'media', url: a.url, ext: 'm4a', mimeType: 'audio/mp4' }],
    };
  }

  // עד 720p אפשר לקחת פורמט ממוזג מוכן ולחסוך מהמשתמש את המיזוג.
  if (!needsMerge_(job.quality) && chooseStrategy_(job) !== 'dual') {
    const muxed = pickMuxed_(formats, parseInt(job.quality, 10));
    if (muxed) {
      return {
        strategy: 'merged',
        title: title,
        parts: [{ kind: 'media', url: muxed.url, ext: 'mp4', mimeType: 'video/mp4' }],
      };
    }
  }

  // מעל 720p, או כשביקשו dual במפורש: שתי רצועות נפרדות.
  const v = pickVideoOnly_(formats, parseInt(job.quality, 10));
  if (!v) throw new Error('לא נמצאה רצועת וידאו באיכות ' + job.quality + 'p');

  // מעדיפים אודיו מאותה משפחת מכולות כדי ש־ffmpeg יוכל למזג בהעתקה בלבד.
  const family = containerFamily_(v.mimeType);
  const a = pickAudioOnly_(formats, family) || pickAudioOnly_(formats, 'any');
  if (!a) throw new Error('לא נמצאה רצועת אודיו');

  return {
    strategy: 'dual',
    title: title,
    parts: [
      { kind: 'video', url: v.url, ext: extForMime_(v.mimeType, 'video'),
        mimeType: baseMime_(v.mimeType), height: v.height || 0 },
      { kind: 'audio', url: a.url, ext: extForMime_(a.mimeType, 'audio'),
        mimeType: baseMime_(a.mimeType) },
    ],
  };
}

// === בחירת פורמטים ===

/**
 * פורמט ממוזג = מכיל וידאו ואודיו יחד. ביוטיוב קיימים רק 360p ו־720p.
 * בוחרים את הגבוה ביותר שאינו עולה על מה שהתבקש.
 */
function pickMuxed_(formats, maxHeight) {
  const muxed = formats.filter(function (f) {
    if (!f.url) return false;
    if (f.hasAudio !== undefined && f.hasVideo !== undefined) return f.hasAudio && f.hasVideo;
    return String(f.mimeType || '').indexOf('video/') === 0 && !!f.audioQuality;
  }).filter(function (f) { return !maxHeight || (f.height || 0) <= maxHeight; });

  muxed.sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
  return muxed[0] || null;
}

/**
 * רצועת וידאו בלבד. מעדיפים mp4/avc1 על webm/vp9: זה מתמזג ישירות עם
 * אודיו m4a לתוך mp4, בלי לעבור ל־mkv ובלי קידוד מחדש.
 */
function pickVideoOnly_(formats, wantHeight) {
  const only = formats.filter(function (f) {
    if (!f.url) return false;
    if (f.hasAudio !== undefined && f.hasVideo !== undefined) return f.hasVideo && !f.hasAudio;
    return String(f.mimeType || '').indexOf('video/') === 0 && !f.audioQuality;
  });
  if (!only.length) return null;

  // 1. בדיוק הגובה שהתבקש. 2. הגבוה ביותר שמתחתיו. 3. הנמוך ביותר שמעליו.
  const atOrBelow = only.filter(function (f) { return (f.height || 0) <= wantHeight; });
  const pool = atOrBelow.length ? atOrBelow : only;

  pool.sort(function (a, b) {
    const dh = (b.height || 0) - (a.height || 0);
    if (dh !== 0) return atOrBelow.length ? dh : -dh;
    return containerRank_(b.mimeType) - containerRank_(a.mimeType);
  });
  return pool[0];
}

/** רצועת אודיו בלבד, בביטרייט הגבוה ביותר במשפחת המכולות המבוקשת. */
function pickAudioOnly_(formats, family) {
  let audio = formats.filter(function (f) {
    if (!f.url) return false;
    if (f.hasAudio !== undefined && f.hasVideo !== undefined) return f.hasAudio && !f.hasVideo;
    return String(f.mimeType || '').indexOf('audio/') === 0;
  });
  if (family && family !== 'any') {
    const same = audio.filter(function (f) { return containerFamily_(f.mimeType) === family; });
    if (same.length) audio = same;
  }
  audio.sort(function (a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
  return audio[0] || null;
}

function containerFamily_(mimeType) {
  const m = String(mimeType || '');
  if (m.indexOf('mp4') > -1) return 'mp4';
  if (m.indexOf('webm') > -1) return 'webm';
  return 'other';
}

/** mp4 מדורג גבוה יותר: הוא הנתיב הפשוט ביותר למיזוג בהעתקה בלבד. */
function containerRank_(mimeType) {
  return containerFamily_(mimeType) === 'mp4' ? 2 : 1;
}

function extForMime_(mimeType, kind) {
  const family = containerFamily_(mimeType);
  if (kind === 'audio') return family === 'mp4' ? 'm4a' : 'weba';
  return family === 'webm' ? 'webm' : 'mp4';
}

function baseMime_(mimeType) {
  return String(mimeType || '').split(';')[0].trim() || 'application/octet-stream';
}

function mimeFor_(ext) {
  const map = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    m4a: 'audio/mp4', weba: 'audio/webm', mp3: 'audio/mpeg', opus: 'audio/opus',
  };
  return map[ext] || 'application/octet-stream';
}

// === עזר ===

/** תומך ב־watch?v=, youtu.be/, shorts/, embed/ ו־live/. */
function extractVideoId_(url) {
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = url.match(patterns[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * מקבל גם קישורים בלי פרוטוקול (למשל "youtube.com/watch?v=..." שהודבק
 * מבלי "https://") - זה נפוץ כשמעתיקים מתוך שדות שאינם שורת הכתובת.
 */
function isYouTubeUrl_(url) {
  return /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(String(url).trim());
}

/** מוסיף https:// אם חסר, כדי שהקישור יהיה תקין לשליחה לשרת. */
function normalizeYouTubeUrl_(url) {
  const trimmed = String(url).trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
}

/**
 * מוצא קישור יוטיוב בתוך תשובה חופשית ומחזיר אותו תקין, או '' אם אין.
 *
 * מקבל גם את הצורות שמשתמשים מדביקים בפועל: קישור שהועתק מתוצאות החיפוש
 * של גוגל, שהוא בעצם הפניה (google.com/goto?url=... או google.com/url?q=...)
 * ולא הקישור ליוטיוב עצמו, וטקסט שיתוף שהקישור נמצא בתוכו.
 */
function resolveYouTubeUrl_(value) {
  let text = String(value || '').trim();
  if (/^(https?:\/\/)?(www\.)?google\.[a-z.]+\/(goto|url)\?/i.test(text)) {
    text = unwrapGoogleRedirect_(text);
  }
  const m = text.match(/(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\/\S+/i);
  return m ? normalizeYouTubeUrl_(m[0].replace(/[)\].,!?]+$/, '')) : '';
}

/**
 * google.com/url?q= מכיל את הכתובת בגלוי. google.com/goto?url= מקודד, ואת
 * היעד אפשר לגלות רק מההפניה (302) שגוגל מחזירה עליו.
 */
function unwrapGoogleRedirect_(link) {
  const plain = link.match(/[?&](?:q|url)=(https?(?::|%3A)[^&]+)/i);
  if (plain) return decodeURIComponent(plain[1]);
  try {
    const res = HTTP_.fetch(normalizeYouTubeUrl_(link), {
      followRedirects: false,
      muteHttpExceptions: true,
    });
    return header_(res, 'location') || link;
  } catch (e) {
    console.warn('פתיחת הפניה של גוגל נכשלה: ' + e.message);
    return link;
  }
}

function safeJson_(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function stripExt_(name) {
  return String(name).replace(/\.[A-Za-z0-9]{2,4}$/, '');
}

function extOf_(name) {
  const m = String(name).match(/\.([A-Za-z0-9]{2,4})$/);
  return m ? m[1].toLowerCase() : '';
}
