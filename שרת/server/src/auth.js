/**
 * אימות מול Apps Script.
 *
 * טוקן משותף אחד. אין כאן משתמשים, ולכן אין טעם במשהו מורכב יותר -
 * הצרכן היחיד הוא הסקריפט שלכם.
 */

import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

/**
 * השוואה בזמן קבוע. השוואת מחרוזות רגילה (===) יוצאת מוקדם בתו הראשון
 * שנבדל, וההפרש הזמני הזה מאפשר לנחש טוקן תו אחר תו מול נקודת קצה ציבורית.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match || !safeEqual(match[1], config.token)) {
    log.warn('בקשה נדחתה', { path: req.path, ip: req.ip });
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
