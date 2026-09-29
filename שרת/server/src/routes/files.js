/**
 * הגשת הקבצים עם תמיכה ב-Range.
 *
 * זו נקודת המפגש עם Apps Script, והתמיכה ב-Range כאן היא לא אופציונלית:
 * UrlFetchApp לא מקבל יותר מ-50MB בתשובה אחת, ולכן הצד השני מושך בנתחי
 * 8MB. שרת שיתעלם מהכותרת וישלח את הקובץ כולו יפיל כל הורדה מעל 50MB.
 *
 * express.static היה מטפל ב-Range לבד, אבל כאן צריך גם אימות לכל בקשת
 * נתח וגם בדיקה שהשם לא בורח מהתיקייה, ולכן ההגשה מפורשת.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import express from 'express';
import { requireAuth } from '../auth.js';
import { getJob } from '../queue.js';
import { resolveInsideJob } from '../storage.js';
import { log } from '../log.js';

export const filesRouter = express.Router();

const MIME = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
};

function mimeFor(name) {
  const ext = name.split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/**
 * מפרש "bytes=START-END". תומך גם בקצה פתוח ("bytes=100-") וגם בסיומת
 * ("bytes=-500"), כי שתי הצורות חוקיות ולקוחות שונים שולחים שונה.
 *
 * @returns {{start: number, end: number}|null|'invalid'}
 */
function parseRange(header, size) {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  let start;
  let end;
  if (rawStart === '') {
    const suffix = parseInt(rawEnd, 10);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
  }

  if (start >= size || start > end) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

filesRouter.get('/:id/:name', requireAuth, async (req, res) => {
  const { id, name } = req.params;

  const job = getJob(id);
  if (!job || job.status !== 'ready') {
    return res.status(404).json({ error: 'not_found' });
  }

  const full = resolveInsideJob(id, name);
  if (!full) {
    log.warn('נחסם ניסיון יציאה מהתיקייה', { id, name });
    return res.status(400).json({ error: 'bad_name' });
  }

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return res.status(404).json({ error: 'not_found' });
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeFor(name));
  res.setHeader('Cache-Control', 'no-store');

  const range = parseRange(req.get('range'), stat.size);

  if (range === 'invalid') {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }

  if (!range) {
    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(full).pipe(res);
  }

  const { start, end } = range;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);

  const stream = fs.createReadStream(full, { start, end });

  // ניתוק באמצע נתח הוא שגרתי: הצד השני עוצר כשנגמר לו תקציב הזמן.
  // בלי הסגירה המפורשת נשארים מתארי קבצים פתוחים עד שהתהליך נחנק.
  stream.on('error', (err) => {
    log.warn('שגיאה בהגשת נתח', { id, error: err.message });
    res.destroy();
  });
  res.on('close', () => stream.destroy());

  stream.pipe(res);
});
