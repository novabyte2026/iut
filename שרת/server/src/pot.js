/**
 * ספק ה-PO Token (bgutil-ytdlp-pot-provider) כתהליך בן.
 *
 * יוטיוב דורשת "Proof of Origin token" כדי להגיש את רוב הפורמטים. התוסף של
 * yt-dlp שמותקן ב-Dockerfile פונה לשרת HTTP מקומי שמייצר אותם, והשרת הזה
 * רץ כאן באותה מכולה - Railway מריצה תהליך אחד לשירות, ולכן אנחנו אלה
 * שמרימים אותו ומרימים שוב אם נפל.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

export const potBaseUrl = `http://127.0.0.1:${config.potPort}`;

let running = false;

export function potRunning() {
  return running;
}

export function startPotProvider() {
  if (!config.potServerScript) {
    log.warn('POT_SERVER_SCRIPT לא הוגדר - yt-dlp ירוץ בלי ספק PO Token');
    return;
  }

  const launch = () => {
    // מאזין רק על 127.0.0.1: אין סיבה שמשהו מחוץ למכולה יגיע אליו.
    const child = spawn(process.execPath,
      [config.potServerScript, '--host', '127.0.0.1', '--port', String(config.potPort)],
      { cwd: path.dirname(path.dirname(config.potServerScript)), stdio: ['ignore', 'pipe', 'pipe'] });

    running = true;
    // bgutil מדפיס את האסימונים עצמם. הם קצרי מועד, אבל אין סיבה שיישבו
    // בלוגים של Railway, ולכן שורות כאלה לא מועברות.
    const relay = (level) => (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim() || /poToken|IntegrityToken/i.test(line)) continue;
        log[level]('bgutil: ' + line.trim().slice(0, 300));
      }
    };
    child.stdout.on('data', relay('info'));
    child.stderr.on('data', relay('warn'));

    child.on('error', (err) => log.error('הפעלת ספק ה-PO Token נכשלה', { error: err.message }));
    child.on('exit', (code, signal) => {
      running = false;
      log.warn('ספק ה-PO Token נעצר, מפעיל מחדש בעוד 5 שניות', { code, signal });
      setTimeout(launch, 5000);
    });
  };

  launch();
  log.info('ספק PO Token הופעל', { url: potBaseUrl });
}
