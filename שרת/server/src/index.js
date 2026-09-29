/**
 * נקודת הכניסה של השרת.
 *
 * חצי אחד מהמערכת. השני הוא פרויקט Apps Script שמושך מכאן בנתחים
 * ודוחף לדרייב עם הטוקן של המשתמש. החלוקה אינה שרירותית:
 *
 *   כאן   - yt-dlp ו-ffmpeg. בינאריים, ולכן חייבים מכולה אמיתית.
 *   שם    - העלאה לדרייב. ScriptApp.getOAuthToken() נותן טוקן לחשבון
 *           המשתמש בחינם, בלי מסך הסכמה ובלי לאחסן refresh token.
 *
 * חשבון שירות לא היה פותר את הצד השני: אין לו מכסת אחסון משלו בדרייב,
 * ולכן הוא לא יכול להיות הבעלים של קבצים בדרייב אישי.
 */

import express from 'express';
import { config } from './config.js';
import { log } from './log.js';
import { jobs } from './queue.js';
import { ensureDataDir, startSweeper, sweep } from './storage.js';
import { checkBinaries, selfTest } from './ytdlp.js';
import { prepareCookies } from './cookies.js';
import { startPotProvider } from './pot.js';
import { jobsRouter } from './routes/jobs.js';
import { filesRouter } from './routes/files.js';
import { channelRouter } from './routes/channel.js';
import { diagRouter } from './routes/diag.js';
import { healthRouter } from './routes/health.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);              // Railway מסיימת TLS לפני האפליקציה
app.use(express.json({ limit: '16kb' }));

app.use('/', healthRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/files', filesRouter);
app.use('/api/channel', channelRouter);
app.use('/api/diag', diagRouter);

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// גוף JSON פגום מגיע לכאן כשגיאה מ-express.json ואחרת היה חוזר כדף HTML,
// שהצד השני לא יודע לפרסר.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (status >= 500) log.error('שגיאת שרת', { path: req.path, error: err.message });
  res.status(status).json({ error: status === 400 ? 'bad_request' : 'server_error' });
});

async function main() {
  await ensureDataDir();
  await prepareCookies();
  const versions = await checkBinaries();
  log.info('בינאריים נמצאו', versions);
  startPotProvider();

  // הפעלה מחדש ב-Railway משאירה תיקיות של עבודות שהתור כבר לא מכיר.
  await sweep(jobs);
  startSweeper(jobs);

  const server = app.listen(config.port, () => {
    log.info('השרת מאזין', { port: config.port, concurrency: config.concurrency });
  });

  // בדיקה עצמית מול יוטיוב אחרי שהשרת כבר מאזין, כדי לא לעכב את בדיקת
  // החיות של Railway. ההשהיה נותנת לספק ה-PO Token לעלות קודם.
  setTimeout(() => {
    selfTest().then((r) => {
      const fields = { ok: r.ok, ms: r.ms, chosen: r.chosen, error: r.error };
      if (r.ok) log.info('בדיקה עצמית עברה', fields);
      else log.error('בדיקה עצמית נכשלה', fields);
      for (const line of r.debug || []) log.info('diag: ' + line);
    }).catch((err) => log.error('בדיקה עצמית קרסה', { error: err.message }));
  }, 15000);

  // Railway שולחת SIGTERM ונותנת חלון קצר לפני SIGKILL. סגירה מסודרת
  // מאפשרת לנתחים שכבר באוויר להסתיים במקום להישבר באמצע.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log.info('נסגר', { signal });
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 10000).unref();
    });
  }
}

main().catch((err) => {
  log.error('העלייה נכשלה', { error: err.message });
  process.exit(1);
});
