/**
 * עטיפה ל-yt-dlp.
 *
 * זה החלק שכל הפיצול הזה קיים בשבילו: Apps Script לא מריץ בינאריים,
 * וכאן רצים גם yt-dlp וגם ffmpeg. המיזוג של וידאו ואודיו נפרדים -
 * מה שמאפשר 1080p ומעלה - קורה בתוך yt-dlp דרך ffmpeg.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { config, MAX_FILE_BYTES } from './config.js';
import { log, shortUrl } from './log.js';
import { checkoutCookies, cookieSummary } from './cookies.js';
import { potBaseUrl } from './pot.js';

/**
 * ארגומנטים משותפים לכל הרצה.
 *
 * --js-runtimes node: מאז סוף 2025 yt-dlp חייב מנוע JavaScript כדי לפתור
 * את האתגרים של יוטיוב, וברירת המחדל שלו היא Deno שאינו מותקן כאן. Node
 * כבר נמצא במכולה. בלעדיו מקבלים "Requested format is not available".
 *
 * mweb נוסף לרשימת הלקוחות כי זה הלקוח שהמדריך של yt-dlp ממליץ לספק לו
 * PO Token; ה-default נשאר כדי שיהיה ממה ליפול אחורה.
 */
function commonArgs() {
  return [
    '--ignore-config',
    '--js-runtimes', 'node',
    '--extractor-args', `youtubepot-bgutilhttp:base_url=${potBaseUrl}`,
    '--extractor-args', 'youtube:player_client=default,mweb',
    '--retries', '3',
    '--extractor-retries', '3',
  ];
}

/**
 * הרצת yt-dlp עם תקרת זמן ועותק עוגיות פרטי.
 *
 * @param {string[]} args
 * @param {object} [opts]
 * @param {(line: string, abort: (err: Error) => void) => void} [opts.onLine]
 *   נקראת על כל שורה, מ-stdout ומ-stderr (yt-dlp כותב התקדמות ל-stderr
 *   במצב שקט). abort עוצר את התהליך ודוחה עם השגיאה שנמסרה.
 * @param {boolean} [opts.keepStdout=true] false = לא לצבור את הפלט; להורדות
 *   ארוכות שמדפיסות אלפי שורות התקדמות.
 * @returns {Promise<{stdout: string, stderr: string, warnings: string[]}>}
 */
async function run(args, opts = {}) {
  const { onLine, keepStdout = true } = opts;
  const cookies = await checkoutCookies();

  let ok = false;
  try {
    const result = await spawnYtdlp([...commonArgs(), ...cookies.args, ...args], onLine, keepStdout);
    ok = true;
    return result;
  } finally {
    await cookies.release(ok);
  }
}

function spawnYtdlp(args, onLine, keepStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(value);
    };
    const abort = (err) => {
      child.kill('SIGKILL');
      finish(err);
    };

    const timeout = setTimeout(() => {
      abort(new Error(`yt-dlp חרג מ-${config.jobTimeoutMinutes} דקות ונעצר`));
    }, config.jobTimeoutMinutes * 60 * 1000);

    const watch = (stream, append) => {
      let buffer = '';
      stream.on('data', (chunk) => {
        const text = chunk.toString();
        append(text);
        if (!onLine) return;
        buffer += text;
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop() || '';
        for (const line of lines) onLine(line, abort);
      });
    };

    watch(child.stdout, (t) => { if (keepStdout) stdout += t; });
    // רק הזנב נשמר: ממנו בונים את הודעת השגיאה, והוא לא צריך לגדול בלי סוף.
    watch(child.stderr, (t) => { stderr = (stderr + t).slice(-200000); });

    child.on('error', (e) => finish(new Error(`הרצת yt-dlp נכשלה: ${e.message}`)));

    child.on('close', (code) => {
      const warnings = extractWarnings(stderr);
      for (const w of warnings) log.warn('yt-dlp: ' + w);
      if (code === 0) {
        finish(null, { stdout, stderr, warnings });
        return;
      }
      // השגיאה המתורגמת מקצרת; השורה המקורית של yt-dlp נשמרת בלוג כדי
      // שיהיה אפשר להבין מקרים כמו "אינו זמין" (נמחק? פרטי? חסום במדינה?).
      const raw = String(stderr).split('\n').find((l) => /^ERROR:/.test(l));
      if (raw) log.warn('yt-dlp: ' + raw.slice(0, 300));
      const err = new Error(cleanError(stderr) || `yt-dlp יצא עם קוד ${code}`);
      Object.assign(err, { stderr, warnings, permanent: isPermanentFailure(stderr) });
      finish(err);
    });
  });
}

function extractWarnings(stderr) {
  const seen = new Set();
  for (const line of String(stderr).split('\n')) {
    const m = line.match(/^WARNING:\s*(.+)/);
    if (m) seen.add(m[1].trim().slice(0, 300));
  }
  return [...seen];
}

/**
 * כשלים שניסיון חוזר לא ישנה: הסרטון עצמו לא זמין לשרת. Apps Script
 * מדלג בהם על ההשהיות וההמתנה של 40 דקות ומודיע מיד.
 */
function isPermanentFailure(stderr) {
  return /Video unavailable|Private video|members-only|join this channel|not (made this video )?available in your country|geo.?restrict|blocked it in your country/i
    .test(String(stderr));
}

/**
 * הופך את הפלט המילולי של yt-dlp להודעה אחת קריאה.
 * שגיאת חסימת הבוטים היא הנפוצה ביותר בהרצה על ספק ענן, ולכן היא מקבלת
 * הסבר לפי מצב העוגיות בפועל - זה ההבדל בין "תייצא שוב" ל"תחכה".
 */
function cleanError(stderr) {
  const text = String(stderr).trim();
  if (!text) return '';

  if (/confirm\s+you'?re?\s+not\s+a\s+bot|Sign in to confirm/i.test(text)) {
    const c = cookieSummary();
    if (/cookies are no longer valid|rotated in the browser/i.test(text)) {
      return 'יוטיוב חסמה את השרת: העוגיות ב-COOKIES_B64 כבר לא תקפות (יוטיוב סובבה אותן). ' +
             'יש לייצא עוגיות חדשות מחלון גלישה פרטי ולעדכן ב-Railway.';
    }
    if (!c.configured) {
      return 'יוטיוב חסמה את השרת ודורשת הזדהות, ולא הוגדר COOKIES_B64 ב-Railway.';
    }
    if (!c.loggedIn) {
      return 'יוטיוב חסמה את השרת. העוגיות שהוגדרו אינן של חשבון מחובר - ' +
             'יש להתחבר ליוטיוב בחלון פרטי, לייצא שוב ולעדכן את COOKIES_B64.';
    }
    return 'יוטיוב חסמה את השרת למרות עוגיות של חשבון מחובר. ' +
           'ייתכן שהחשבון או כתובת השרת סומנו - נסו עוגיות מחשבון אחר או המתינו כמה שעות.';
  }
  // לפני "Video unavailable": חסימה לפי מדינה מגיעה לעיתים עם אותה כותרת,
  // והשרת יושב בארה"ב - סרטון שזמין בישראל עלול להיות חסום שם.
  if (/not (made this video )?available in your country|geo.?restrict|blocked it in your country/i.test(text)) {
    return 'הסרטון חסום במדינה שבה יושב השרת (ארה"ב), ולכן אי אפשר להוריד אותו משם';
  }
  // יוטיוב מחזירה לעיתים "Video unavailable" סתמי גם על חסימה לפי מדינה
  // (כך קרה עם פרקים מלאים של כאן 11), ולכן ההודעה מציינת את האפשרות.
  if (/Video unavailable/i.test(text)) {
    return 'הסרטון אינו זמין לשרת. אם הוא נפתח אצלך ביוטיוב, כנראה שהוא חסום לצפייה ' +
           'מחוץ לישראל (השרת יושב בארה"ב) - נפוץ בפרקים מלאים של ערוצי טלוויזיה.';
  }
  if (/Private video/i.test(text)) return 'הסרטון פרטי';
  if (/members-only|join this channel/i.test(text)) return 'הסרטון פתוח לחברי הערוץ בלבד';
  if (/age.?restricted|age.?gate|confirm your age/i.test(text)) return 'הסרטון מוגבל בגיל ודורש עוגיות של חשבון מחובר';
  if (/Requested format is not available|Only images are available/i.test(text)) {
    return 'יוטיוב לא הגישה אף פורמט להורדה (בדרך כלל: חסר PO Token או מנוע JS). ' +
           'הריצו testServer() ב-Apps Script לאבחון.';
  }
  if (/HTTP Error 403/i.test(text)) return 'יוטיוב החזירה 403 בהורדת הקובץ (בדרך כלל: PO Token חסר או לא תקף)';

  const line = text.split('\n').filter((l) => /^ERROR:/i.test(l))[0] || text.split('\n').pop();
  return line.replace(/^ERROR:\s*/i, '').slice(0, 300);
}

/**
 * בורר פורמט.
 *
 * -S res:N מעדיף את הרזולוציה הגבוהה ביותר עד N (ואם אין - הקרובה מעליה),
 * ובתוך אותה רזולוציה H.264/AAC על פני VP9/AV1: אלה מתנגנים בכל טלפון
 * ובנגן של דרייב. מעל 1080p ביוטיוב יש רק VP9/AV1, ואז הם נבחרים.
 */
function formatArgs(mode, quality) {
  if (mode === 'audio') return ['-f', 'ba/b'];
  const h = parseInt(quality, 10) || 1080;
  return ['-f', 'bv*+ba/b', '-S', `res:${h},vcodec:h264,acodec:aac`];
}

const PROGRESS = /^PROGRESS\s+([\d.]+)%/;
const META = /^META\s+(\{.*\})\s*$/;

/**
 * מוריד וממזג לתוך תיקיית העבודה, בהרצה אחת.
 *
 * פעם זה היה שתי הרצות (מטא-דאטה ואז הורדה). כל הרצה היא עוד פנייה
 * לנגן של יוטיוב מכתובת ענן, וכל פנייה כזו מקרבת חסימה - לכן הכותרת
 * והאורך מודפסים עכשיו מתוך אותה הרצה, רגע לפני שההורדה מתחילה.
 *
 * הקובץ נשמר בשם קבוע media.<ext> כדי להימנע מהתחמקות תווים בשמות
 * עבריים או ארוכים; השם האמיתי מורכב בצד של Apps Script מהכותרת.
 *
 * @param {(meta: {title: string, duration: number}) => void} onMeta
 * @param {(percent: number, stage: string) => void} onProgress
 */
export async function download({ url, mode, quality, dir, onMeta, onProgress }) {
  const args = [
    '--no-playlist',
    '--no-simulate',
    '--print', 'pre_process:META %(.{id,title,duration,uploader})j',
    '--progress', '--newline',
    '--progress-template', 'download:PROGRESS %(progress._percent_str)s',
    ...formatArgs(mode, quality),
    '-o', `${dir}/media.%(ext)s`,
    '--max-filesize', `${Math.floor(MAX_FILE_BYTES / 1024)}k`,
  ];

  if (mode === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0',
              '--embed-thumbnail', '--embed-metadata');
  } else {
    // mp4 היא המכולה שמתנגנת בכל מקום, כולל בנגן של דרייב עצמו.
    args.push('--merge-output-format', 'mp4');
  }

  args.push(url);
  const videoId = (/[?&]v=([\w-]{11})/.exec(url) || /(?:youtu\.be|shorts|live|embed)\/([\w-]{11})/.exec(url) || [])[1];
  log.info('מתחיל הורדה', { url: shortUrl(url), video: videoId, mode, quality });

  // yt-dlp מוריד וידאו ואודיו בזה אחר זה, ולכן האחוזים חוזרים לאפס
  // באמצע. ממפים כל מסלול לחצי מהסרגל כדי שההתקדמות תהיה מונוטונית.
  let pass = 0;
  let lastPercent = 0;
  let meta = null;

  await run(args, {
    keepStdout: false,
    onLine: (raw, abort) => {
      const line = raw.trim();

      const m = line.match(META);
      if (m) {
        try { meta = JSON.parse(m[1]); } catch { return; }
        const maxSec = config.maxDurationMinutes * 60;
        if (maxSec && meta.duration > maxSec) {
          abort(Object.assign(
            new Error(`אורך הסרטון ${Math.round(meta.duration / 60)} דקות, מעל התקרה ` +
                      `של ${config.maxDurationMinutes} דקות`),
            { permanent: true }));
          return;
        }
        onMeta?.({ title: meta.title || '', duration: meta.duration || 0 });
        return;
      }

      const p = line.match(PROGRESS);
      if (p) {
        const percent = parseFloat(p[1]);
        if (percent < lastPercent - 20) pass++;      // התחיל מסלול חדש
        lastPercent = percent;
        const overall = mode === 'audio' ? Math.min(99, percent)
                                         : Math.min(99, pass * 50 + percent / 2);
        onProgress?.(Math.floor(overall), 'download');
      }
    },
  });

  const entries = await fs.readdir(dir);
  const file = entries.find((n) => n.startsWith('media.') && !n.endsWith('.part'));
  if (!file) throw new Error('yt-dlp הסתיים בהצלחה אך לא נוצר קובץ (ייתכן שהקובץ חרג מ-MAX_FILE_MB)');

  const stat = await fs.stat(`${dir}/${file}`);
  if (stat.size === 0) throw new Error('הקובץ שנוצר ריק');

  log.info('הורדה הושלמה', { file, MB: Math.round(stat.size / 1048576) });
  return { name: file, size: stat.size };
}

/**
 * רשימת הסרטונים בערוץ/פלייליסט, בלי להוריד כלום.
 * --flat-playlist מדלג על שליפת מטא-דאטה מלאה לכל סרטון בנפרד, ולכן
 * מהיר גם על ערוצים בני אלפי סרטונים - יוטיוב מחזירה רק id וכותרת.
 */
export async function listChannel(url, limit) {
  const args = ['--flat-playlist', '--dump-single-json'];
  if (limit) args.push('--playlist-end', String(limit));
  args.push(url);

  const { stdout } = await run(args);

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp החזיר רשימת ערוץ שאינה JSON תקין');
  }

  const entries = (data.entries || []).filter((e) => e && e.id);
  return {
    title: data.title || '',
    videos: entries.map((e) => ({
      id: e.id,
      title: e.title || '',
      url: `https://www.youtube.com/watch?v=${e.id}`,
    })),
  };
}

// שורות ה-debug שמספרות אם השרשרת שלמה: גרסה, מנוע JS, תוסף ה-PO Token,
// כמה עוגיות נטענו, ומה קרה בפועל מול יוטיוב.
const DIAG_LINE = /yt-dlp version|Python|JS runtimes?|PO Token Provider|Plugin|pot|cookies|client|Downloading .*player|n challenge|sig|Signature|ERROR|WARNING/i;

let lastSelfTest = null;

export function lastSelfTestResult() {
  return lastSelfTest;
}

/**
 * בדיקה עצמית מול יוטיוב, בלי להוריד כלום: מריצה yt-dlp -v על סרטון
 * בדיקה ומחזירה את מה שצריך כדי להבין מה שבור. נקראת בעלייה (התוצאה
 * בלוגים של Railway) ומ-/api/diag (התוצאה ב-testServer() ב-Apps Script).
 */
export async function selfTest(url = config.selfTestUrl) {
  const started = Date.now();
  const result = { at: new Date().toISOString(), url, cookies: cookieSummary() };

  try {
    const { stdout, stderr, warnings } = await run([
      '-v', '--no-playlist', '--simulate',
      ...formatArgs('video', '1080'),
      '--print', '%(title)s | %(format_id)s | %(height)sp | %(vcodec)s',
      url,
    ]);
    Object.assign(result, {
      ok: true,
      chosen: stdout.trim().split('\n').pop(),
      warnings,
      debug: debugLines(stderr),
    });
  } catch (err) {
    Object.assign(result, {
      ok: false,
      error: err.message,
      warnings: err.warnings || [],
      debug: debugLines(err.stderr || ''),
    });
  }

  result.ms = Date.now() - started;
  lastSelfTest = { ok: result.ok, at: result.at, error: result.error || '' };
  return result;
}

function debugLines(stderr) {
  return String(stderr).split('\n')
    .filter((l) => DIAG_LINE.test(l))
    .map((l) => l.replace(/\b(Cookie|Authorization):.*$/i, '$1: [hidden]').slice(0, 300))
    .slice(0, 60);
}

/** בדיקת זמינות הבינאריים בעלייה. עדיף לגלות עכשיו מאשר בבקשה הראשונה. */
export async function checkBinaries() {
  const versions = {};
  // כל בינארי והדגל שלו: yt-dlp מבין --version, אבל ffmpeg דורש -version
  // (מקף יחיד) ויוצא בקוד שגיאה על --version.
  const checks = [
    ['yt-dlp', config.ytdlpPath, '--version'],
    ['ffmpeg', config.ffmpegPath, '-version'],
  ];
  for (const [name, bin, versionFlag] of checks) {
    versions[name] = await new Promise((resolve) => {
      const child = spawn(bin, [versionFlag], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c.toString(); });
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code === 0 ? out.trim().split('\n')[0] : null));
    });
    if (!versions[name]) throw new Error(`${name} לא נמצא בנתיב. בדקו את ה-Dockerfile.`);
  }
  return versions;
}
