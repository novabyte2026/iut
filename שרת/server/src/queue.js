/**
 * תור העבודות של השרת.
 *
 * מפה בזיכרון ועובדים בכמות מוגבלת. אין כאן מסד נתונים בכוונה: השרת
 * הוא תחנת מעבר, והמצב הקובע נמצא בצד של Apps Script. אם השרת מופעל
 * מחדש באמצע, Apps Script פשוט יגיש את הבקשה שוב.
 *
 * מצבים: queued -> working -> ready | error
 */

import { config } from './config.js';
import { log } from './log.js';
import { newJobId, createJobDir, removeJobDir } from './storage.js';
import { download } from './ytdlp.js';

/** @type {Map<string, object>} */
export const jobs = new Map();

const waiting = [];
let running = 0;

export function createJob({ url, mode, quality }) {
  const id = newJobId();
  const job = {
    id,
    url,
    mode: mode === 'audio' ? 'audio' : 'video',
    quality: String(quality || '1080'),
    status: 'queued',
    stage: '',
    progress: 0,
    title: '',
    duration: 0,
    file: null,
    error: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  jobs.set(id, job);
  waiting.push(id);
  pump();
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export async function deleteJob(id) {
  const job = jobs.get(id);
  if (!job) return false;

  // עבודה שרצה לא נמחקת מתחת לרגליים של העובד; מסמנים ומנקים בסוף.
  if (job.status === 'working') {
    job.cancelled = true;
    return true;
  }
  jobs.delete(id);
  const index = waiting.indexOf(id);
  if (index > -1) waiting.splice(index, 1);
  await removeJobDir(id);
  return true;
}

function touch(job, fields) {
  Object.assign(job, fields, { updatedAt: Date.now() });
}

function pump() {
  while (running < config.concurrency && waiting.length) {
    const id = waiting.shift();
    const job = jobs.get(id);
    if (!job || job.cancelled) continue;

    running++;
    process(job)
      .catch((err) => log.error('עובד קרס', { id, error: err.message }))
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function process(job) {
  try {
    touch(job, { status: 'working', stage: 'metadata', progress: 0 });

    const dir = await createJobDir(job.id);
    const file = await download({
      url: job.url,
      mode: job.mode,
      quality: job.quality,
      dir,
      onMeta: (meta) => {
        touch(job, { title: meta.title, duration: meta.duration, stage: 'download' });
      },
      onProgress: (progress, stage) => {
        // לא עוברים דרך touch כדי לא לרענן את updatedAt על כל אחוז;
        // הגיל צריך להימדד מסיום העבודה, לא מהפעימה האחרונה.
        job.progress = progress;
        job.stage = stage;
      },
    });

    if (job.cancelled) {
      await removeJobDir(job.id);
      jobs.delete(job.id);
      return;
    }

    touch(job, { status: 'ready', stage: 'done', progress: 100, file });
    log.info('עבודה מוכנה', { id: job.id, title: job.title.slice(0, 60) });
  } catch (err) {
    touch(job, { status: 'error', error: err.message, permanent: Boolean(err.permanent), stage: '' });
    await removeJobDir(job.id);
    log.error('עבודה נכשלה', { id: job.id, error: err.message });
  }
}

export function queueStats() {
  return { running, waiting: waiting.length, total: jobs.size };
}
