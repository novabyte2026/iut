/**
 * ה-API שדרכו Apps Script מזמין עבודה ובודק מה מצבה.
 *
 * החוזה:
 *   POST   /api/jobs       {url, mode, quality}  -> {id, status}
 *   GET    /api/jobs/:id                          -> {status, progress, files[]}
 *   DELETE /api/jobs/:id                          -> 204
 *
 * הכתובות שחוזרות ב-files הן יחסיות. הצד השני מרכיב אותן מול הבסיס
 * שהוגדר אצלו, וכך החלפת דומיין ב-Railway לא מחייבת שינוי בשרת.
 */

import express from 'express';
import { requireAuth } from '../auth.js';
import { createJob, getJob, deleteJob, queueStats } from '../queue.js';
import { log } from '../log.js';
import { pushToDrive, isDriveSessionUri } from '../push.js';

export const jobsRouter = express.Router();

const YOUTUBE = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;
const QUALITIES = ['360', '480', '720', '1080', '1440', '2160'];

jobsRouter.post('/', requireAuth, (req, res) => {
  const { url, mode, quality } = req.body || {};

  if (typeof url !== 'string' || !YOUTUBE.test(url.trim())) {
    return res.status(400).json({ error: 'bad_url', message: 'נדרש קישור יוטיוב תקין' });
  }
  if (mode && mode !== 'video' && mode !== 'audio') {
    return res.status(400).json({ error: 'bad_mode' });
  }
  if (quality && !QUALITIES.includes(String(quality))) {
    return res.status(400).json({ error: 'bad_quality' });
  }

  const job = createJob({ url: url.trim(), mode, quality });
  log.info('עבודה נוצרה', { id: job.id, ...queueStats() });

  res.status(202).json({ id: job.id, status: job.status });
});

jobsRouter.get('/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not_found' });

  res.json({
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    title: job.title,
    duration: job.duration,
    error: job.error,
    permanent: Boolean(job.permanent),
    push: job.push || null,
    files: job.file
      ? [{
          name: job.file.name,
          size: job.file.size,
          url: `/api/files/${job.id}/${encodeURIComponent(job.file.name)}`,
        }]
      : [],
  });
});

/**
 * POST /api/jobs/:id/push {sessionUri} -> 202
 * מעלה את הקובץ המוכן ישירות לסשן העלאה של Drive שנפתח בצד של Apps Script.
 * ההתקדמות נקראת מ-GET /api/jobs/:id תחת push.
 */
jobsRouter.post('/:id/push', requireAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== 'ready' || !job.file) {
    return res.status(404).json({ error: 'not_found' });
  }
  const { sessionUri } = req.body || {};
  if (!isDriveSessionUri(sessionUri)) {
    return res.status(400).json({ error: 'bad_session_uri' });
  }
  // בקשה חוזרת (למשל ניסיון חוזר של Apps Script) לא פותחת העלאה שנייה במקביל.
  if (job.push && job.push.status === 'uploading') {
    return res.status(202).json({ status: 'uploading' });
  }

  pushToDrive(job, sessionUri);
  res.status(202).json({ status: 'uploading' });
});

jobsRouter.delete('/:id', requireAuth, async (req, res) => {
  const found = await deleteJob(req.params.id);
  if (!found) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});
