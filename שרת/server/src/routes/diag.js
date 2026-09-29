/**
 * אבחון מרחוק: GET /api/diag מריץ בדיקה עצמית מול יוטיוב ומחזיר את
 * הפרטים - גרסאות, מצב העוגיות (שמות בלבד), ספק ה-PO Token והשגיאה.
 *
 * קיים כי מהרשת של המשתמש אי אפשר לפנות לשרת ישירות; Apps Script כן
 * יכול, ו-testServer() שם קורא לנקודה הזאת ומדפיס את התשובה.
 */

import express from 'express';
import { requireAuth } from '../auth.js';
import { selfTest } from '../ytdlp.js';
import { potRunning } from '../pot.js';

export const diagRouter = express.Router();

// בדיקה אחת בכל רגע נתון: לחיצות חוזרות לא יהפכו לשטף פניות ליוטיוב.
let inflight = null;

diagRouter.get('/', requireAuth, async (req, res) => {
  const url = typeof req.query.url === 'string' && /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(req.query.url)
    ? req.query.url : undefined;

  inflight = inflight || selfTest(url).finally(() => { inflight = null; });
  const result = await inflight;
  res.json({ potProvider: potRunning(), ...result });
});
