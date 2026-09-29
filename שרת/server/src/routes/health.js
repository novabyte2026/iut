/**
 * בדיקת חיות.
 *
 * לא מוגן בטוקן בכוונה: Railway קוראת לנקודה הזאת כדי להחליט אם הפריסה
 * הצליחה, ואין לה איפה לשים כותרת Authorization. לכן היא גם לא חושפת
 * שום דבר מעניין - רק שהשרת חי וכמה עבודות רצות.
 */

import express from 'express';
import { queueStats } from '../queue.js';
import { usedBytes } from '../storage.js';
import { config } from '../config.js';
import { cookieSummary } from '../cookies.js';
import { lastSelfTestResult } from '../ytdlp.js';
import { potRunning } from '../pot.js';

export const healthRouter = express.Router();

const startedAt = Date.now();

healthRouter.get('/health', async (req, res) => {
  let diskMB = null;
  try {
    diskMB = Math.round((await usedBytes()) / 1048576);
  } catch { /* לא קריטי לבדיקת חיות */ }

  res.json({
    ok: true,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    queue: queueStats(),
    diskMB,
    diskLimitMB: config.maxDiskMB,
    cookies: Boolean(config.cookiesFile),
    cookiesLoggedIn: Boolean(cookieSummary().loggedIn),
    potProvider: potRunning(),
    selfTest: lastSelfTestResult(),
  });
});
