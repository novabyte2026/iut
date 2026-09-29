/**
 * ה-API שדרכו קליינטים חיצוניים (userscript של Tampermonkey, או כל כלי
 * אחר) מדברים עם המערכת.
 *
 * doGet + google.script.run עובדים רק כשהדף עצמו טעון בתוך iframe של
 * Apps Script. קליינט חיצוני כמו userscript לא טוען את הדף הזה בכלל -
 * הוא פונה ישירות ב-HTTP POST, וזה מה ש-doPost קולט.
 *
 * GM_xmlhttpRequest (התוסף Tampermonkey) רץ בהקשר המורשה של התוסף
 * ולא של הדף, ולכן הוא עוקף CORS מיסודו. אין צורך בכותרות CORS כאן.
 *
 * אימות: טוקן קבוע ב-Script Properties, לא סיסמה למשתמש. זה כלי אישי -
 * הטוקן קיים רק כדי שכתובת ה-Web App לא תהיה קריאה-לכל-דיכף אם היא
 * דולפת (למשל דרך היסטוריית דפדפן), לא כדי להגביל שימוש.
 */

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ success: false, error: 'גוף הבקשה אינו JSON תקין' });
  }

  if (!checkApiToken_(body.token)) {
    return jsonOut_({ success: false, error: 'טוקן שגוי' });
  }

  try {
    switch (body.action) {
      case 'submit':          return jsonOut_(apiSubmit_(body));
      case 'status':           return jsonOut_(apiStatus_(body));
      case 'channel_preview':  return jsonOut_(apiChannelPreview_(body));
      case 'channel_download': return jsonOut_(apiChannelDownload_(body));
      case 'channel_status':   return jsonOut_(apiChannelStatus_(body));
      default:
        return jsonOut_({ success: false, error: 'פעולה לא מוכרת: ' + body.action });
    }
  } catch (err) {
    return jsonOut_({ success: false, error: err.message });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function checkApiToken_(token) {
  return !!token && token === secret_('API_TOKEN', true);
}

// === סרטון בודד ===

function apiSubmit_(body) {
  const url = String(body.url || '').trim();
  if (!isYouTubeUrl_(url)) throw new Error('נא לשלוח קישור יוטיוב תקין');

  const mode = body.mode === 'audio' ? 'audio' : 'video';
  const quality = QUALITIES.indexOf(String(body.quality)) > -1 ? String(body.quality)
                                                                : CONFIG.DEFAULT_QUALITY;

  const job = enqueueJob_(url, mode, quality, ownerEmail_());
  kickQueue_();
  return { success: true, jobId: job.id };
}

function apiStatus_(body) {
  const s = jobStatus(body.jobId);
  if (s.status === 'missing') return { success: false, error: 'העבודה לא נמצאה' };
  s.success = true;
  return s;
}

// === ערוץ שלם ===

function apiChannelPreview_(body) {
  const channelUrl = normalizeChannelUrl_(body.url);
  if (!channelUrl) throw new Error('כתובת ערוץ לא זוהתה');
  const mode = body.mode === 'audio' ? 'audio' : 'video';

  const listing = listChannelVideos_(channelUrl, CONFIG.CHANNEL_BATCH_LIMIT);
  const done = getChannelLog_(channelUrl, mode);
  const remaining = listing.videos.filter(function (v) { return done.indexOf(v.id) === -1; });

  return {
    success: true,
    channel: listing.title,
    totalInChannel: listing.videos.length,
    alreadyDownloaded: listing.videos.length - remaining.length,
    remaining: remaining.length,
    willDownload: Math.min(remaining.length, CONFIG.CHANNEL_BATCH_LIMIT),
  };
}

function apiChannelDownload_(body) {
  const channelUrl = normalizeChannelUrl_(body.url);
  if (!channelUrl) throw new Error('כתובת ערוץ לא זוהתה');

  const mode = body.mode === 'audio' ? 'audio' : 'video';
  const quality = QUALITIES.indexOf(String(body.quality)) > -1 ? String(body.quality)
                                                                : CONFIG.DEFAULT_QUALITY;

  const listing = listChannelVideos_(channelUrl, CONFIG.CHANNEL_BATCH_LIMIT);
  const done = getChannelLog_(channelUrl, mode);
  const batch = listing.videos
    .filter(function (v) { return done.indexOf(v.id) === -1; })
    .slice(0, CONFIG.CHANNEL_BATCH_LIMIT);

  if (!batch.length) throw new Error('אין סרטונים חדשים בערוץ הזה');

  const folderId = DriveApp['getFolderById'](targetFolderId_())
    .createFolder(safeFileName_(listing.title || channelUrl))
    .getId();

  const manifest = saveManifest_({
    id: newManifestId_(),
    channelUrl: channelUrl,
    channel: listing.title,
    format: mode,
    folderId: folderId,
    total: batch.length,
    doneCount: 0,
    failedCount: 0,
    blockedCount: 0,
    doneIds: [],
    status: 'running',
    requester: ownerEmail_(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  batch.forEach(function (v) {
    enqueueJob_(v.url, mode, quality, manifest.requester,
                { targetFolderId: folderId, manifestId: manifest.id, videoId: v.id });
  });

  kickQueue_();

  return { success: true, jobId: manifest.id, channel: manifest.channel, total: manifest.total };
}

function apiChannelStatus_(body) {
  const manifest = getManifest_(body.jobId);
  if (!manifest) return { success: false, error: 'העבודה לא נמצאה' };

  const processed = manifest.doneCount + manifest.failedCount + (manifest.blockedCount || 0);
  return {
    success: true,
    status: manifest.status,
    channel: manifest.channel,
    total: manifest.total,
    processed: processed,
    done: manifest.doneCount,
    failed: manifest.failedCount,
    blocked: manifest.blockedCount || 0,
    percent: manifest.total ? Math.floor((processed / manifest.total) * 100) : 0,
    downloadedIds: manifest.doneIds || [],
    folderLink: 'https://drive.google.com/drive/folders/' + manifest.folderId,
  };
}
