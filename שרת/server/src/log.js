/**
 * לוג קצר בשורה אחת לאירוע.
 *
 * Railway אוספת stdout כמו שהוא, ולכן פורמט אחיד וקצר שווה יותר מספרייה
 * חיצונית. אין כאן כתובות מדיה מלאות ואין טוקנים - הלוגים של Railway
 * גלויים לכל מי שיש לו גישה לפרויקט.
 */

import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, message, fields = {}) {
  if (LEVELS[level] > threshold) return;

  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), message];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') {
      parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  error: (m, f) => emit('error', m, f),
  warn: (m, f) => emit('warn', m, f),
  info: (m, f) => emit('info', m, f),
  debug: (m, f) => emit('debug', m, f),
};

/** מקצר כתובת לצורכי לוג: שומר מארח ונתיב, זורק פרמטרים חתומים. */
export function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.slice(0, 80);
  } catch {
    return String(url).slice(0, 80);
  }
}
