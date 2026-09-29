/**
 * רשימת סרטוני ערוץ/פלייליסט, בלי הורדה.
 *
 * Apps Script קורא לזה כדי לדעת אילו סרטונים קיימים בערוץ לפני שהוא
 * מחליט אילו מהם עוד לא ירדו ופותח עבורם עבודות.
 */

import express from 'express';
import { requireAuth } from '../auth.js';
import { listChannel } from '../ytdlp.js';
import { log, shortUrl } from '../log.js';

export const channelRouter = express.Router();

const CHANNEL_URL = /^https?:\/\/(www\.)?youtube\.com\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+|playlist\?list=[\w-]+)/i;

channelRouter.get('/', requireAuth, async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!CHANNEL_URL.test(url)) {
    return res.status(400).json({ error: 'bad_url', message: 'נדרשת כתובת ערוץ, פלייליסט או handle תקינים' });
  }

  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    return res.status(400).json({ error: 'bad_limit' });
  }

  try {
    const result = await listChannel(url, limit);
    log.info('רשימת ערוץ נשלפה', { url: shortUrl(url), videos: result.videos.length });
    res.json(result);
  } catch (err) {
    log.error('שליפת רשימת ערוץ נכשלה', { url: shortUrl(url), error: err.message });
    res.status(502).json({ error: 'list_failed', message: err.message });
  }
});
