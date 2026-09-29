// ==UserScript==
// @name        הורדה לדרייב מיוטיוב
// @namespace   yt-to-drive
// @version     1.0
// @description כפתור צף על יוטיוב: הורדת סרטון בודד או ערוץ שלם, ישירות לדרייב האישי
// @match       *://*.youtube.com/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // הגדרות
  // ============================================================
  //
  // שני הערכים האלה שייכים לפריסה שלכם ב-Apps Script ואי אפשר לנחש
  // אותם: WEB_APP_URL היא כתובת ה-exec שקיבלתם מ-Deploy, ו-API_TOKEN
  // הוא הערך ששמרתם ב-Script Properties תחת אותו שם (ראו Setup.gs,
  // generateToken() מייצר אחד).
  //
  // אפשר למלא כאן ישירות, או להשאיר ריק ולהזין בפעם הראשונה שהכפתור
  // נלחץ - הערכים נשמרים אז ב-GM_setValue וכל עדכון עתידי של הקובץ
  // (מ-@updateURL, אם הגדרתם) לא ידרוס אותם.

  const DEFAULT_WEB_APP_URL = '';
  const DEFAULT_API_TOKEN = '';

  const POLL_INTERVAL_MS = 3000;
  const CHANNEL_POLL_INTERVAL_MS = 15000;

  function getSetting(key, fallback) {
    return GM_getValue(key, '') || fallback;
  }

  function webAppUrl() {
    return getSetting('webAppUrl', DEFAULT_WEB_APP_URL);
  }

  function apiToken() {
    return getSetting('apiToken', DEFAULT_API_TOKEN);
  }

  function isConfigured() {
    return !!(webAppUrl() && apiToken());
  }

  // ============================================================
  // תקשורת עם השרת
  // ============================================================
  //
  // GM_xmlhttpRequest רץ בהקשר המורשה של Tampermonkey ולא בהקשר של
  // הדף, ולכן הוא עוקף את מדיניות ה-CORS של youtube.com. בלי ההרשאה
  // הזאת (@grant) קריאה רגילה מה-JS של הדף ל-script.google.com הייתה
  // נחסמת.

  function callApi(action, payload) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: webAppUrl(),
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(Object.assign({ token: apiToken(), action: action }, payload)),
        onload: function (response) {
          let body;
          try {
            body = JSON.parse(response.responseText);
          } catch (e) {
            reject(new Error('תשובה לא תקינה מהשרת (' + response.status + '): ' +
                             response.responseText.slice(0, 200)));
            return;
          }
          if (body.success === false) reject(new Error(body.error || 'שגיאה לא ידועה'));
          else resolve(body);
        },
        onerror: function () {
          reject(new Error('אין תשובה מהשרת. בדקו חיבור לאינטרנט ושה-Web App פרוס.'));
        },
      });
    });
  }

  // ============================================================
  // זיהוי עמוד ערוץ / פלייליסט
  // ============================================================

  function getChannelUrlFromPage() {
    const path = window.location.pathname;
    const search = window.location.search;

    if (path === '/playlist' && /[?&]list=/.test(search)) {
      const listId = new URLSearchParams(search).get('list');
      if (listId) return 'https://www.youtube.com/playlist?list=' + listId;
    }

    const match = path.match(/^\/(@[\w\-.]+|channel\/[\w\-]+|c\/[\w\-.]+|user\/[\w\-.]+)/);
    return match ? 'https://www.youtube.com/' + match[1] : null;
  }

  function isChannelPage() {
    return !!getChannelUrlFromPage();
  }

  // ============================================================
  // ממשק: כפתור צף
  // ============================================================

  const COLORS = { brand: '#5b4ee0', ok: '#1a7f4b', err: '#c0362c' };

  function el(tag, styles, attrs) {
    const node = document.createElement(tag);
    if (styles) Object.assign(node.style, styles);
    if (attrs) Object.assign(node, attrs);
    return node;
  }

  let isBusy = false;

  function createFloatingMenu() {
    if (document.getElementById('ytd-container')) return;

    const container = el('div', {
      position: 'fixed', bottom: '20px', left: '20px', zIndex: '999999',
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '10px',
      fontFamily: 'Arial, sans-serif',
    }, { id: 'ytd-container' });

    const optionsRow = el('div', {
      display: 'none', gap: '8px', background: 'rgba(255,255,255,.95)',
      padding: '8px', borderRadius: '14px', boxShadow: '0 4px 15px rgba(0,0,0,.2)',
    }, { id: 'ytd-options' });

    const videoBtn = pillButton('🎬 וידאו', function () { startFlow('video'); });
    const audioBtn = pillButton('🎵 אודיו', function () { startFlow('audio'); });
    optionsRow.appendChild(videoBtn);
    optionsRow.appendChild(audioBtn);

    const mainBtn = el('button', {
      width: '56px', height: '56px', borderRadius: '50%', border: 'none',
      background: COLORS.brand, color: '#fff', fontSize: '26px', cursor: 'pointer',
      boxShadow: '0 4px 10px rgba(0,0,0,.3)',
    }, { id: 'ytd-main-btn', innerText: '⬇️', title: 'הורדה לדרייב' });

    mainBtn.onclick = function () {
      if (isBusy) return;
      if (!isConfigured()) { promptSettings(); return; }
      optionsRow.style.display = optionsRow.style.display === 'flex' ? 'none' : 'flex';
    };
    mainBtn.oncontextmenu = function (e) { e.preventDefault(); promptSettings(); };

    container.appendChild(optionsRow);
    container.appendChild(mainBtn);
    document.body.appendChild(container);
  }

  function pillButton(label, onClick) {
    const btn = el('button', {
      padding: '10px 14px', borderRadius: '20px', border: 'none',
      background: '#fff', color: '#222', fontSize: '14px', cursor: 'pointer',
      boxShadow: '0 2px 6px rgba(0,0,0,.15)', whiteSpace: 'nowrap',
    }, { innerText: label });
    btn.onclick = function () {
      document.getElementById('ytd-options').style.display = 'none';
      onClick();
    };
    return btn;
  }

  function setBusy(busy) {
    isBusy = busy;
    const btn = document.getElementById('ytd-main-btn');
    if (btn) { btn.style.opacity = busy ? '.5' : '1'; }
  }

  function promptSettings() {
    showInputModal(
      '⚙️ הגדרות חיבור',
      'כתובת ה-Web App (מ-Deploy ב-Apps Script):',
      webAppUrl(),
      function (url) {
        if (!url) return;
        GM_setValue('webAppUrl', url.trim());
        showInputModal('⚙️ הגדרות חיבור', 'הטוקן (מ-Script Properties, מפתח API_TOKEN):',
          apiToken(), function (token) {
            if (token) GM_setValue('apiToken', token.trim());
          });
      });
  }

  // ============================================================
  // זרימת סרטון בודד
  // ============================================================

  function startFlow(mode) {
    if (isChannelPage()) startChannelFlow(mode);
    else startVideoFlow(mode);
  }

  function startVideoFlow(mode) {
    setBusy(true);
    callApi('submit', { url: window.location.href, mode: mode })
      .then(function (res) { pollVideo(res.jobId); })
      .catch(function (err) { setBusy(false); showModal('❌', 'שגיאה', err.message); });
  }

  function pollVideo(jobId) {
    GM_setValue('activeJob', JSON.stringify({ type: 'video', jobId: jobId }));

    // מציגים משהו מיד, לפני הדגימה הראשונה - בלעדיה יש כמה שניות שקטות
    // אחרי הלחיצה שנראות כאילו כלום לא קרה.
    showProgressModal('ממתין בתור', '', 0);

    const timer = setInterval(function () {
      callApi('status', { jobId: jobId }).then(function (s) {
        renderVideoProgress(s);
        if (s.status === 'done' || s.status === 'error') {
          clearInterval(timer);
          setBusy(false);
          GM_setValue('activeJob', '');
        }
      }).catch(function (err) {
        clearInterval(timer);
        setBusy(false);
        showModal('❌', 'שגיאה', err.message);
      });
    }, POLL_INTERVAL_MS);
  }

  const STAGE_LABELS = {
    queued: 'ממתין בתור בשרת', download: 'מוריד', merge: 'ממזג וידאו ואודיו',
  };
  const STATUS_LABELS = {
    queued: 'ממתין בתור', resolving: 'מאתר את הסרטון', preparing: 'השרת מוריד וממזג',
    transferring: 'מעביר לדרייב',
  };

  function renderVideoProgress(s) {
    if (s.status === 'done') {
      showModal('✅', 'ההורדה הושלמה', s.title || '', s.driveUrl, s.mergeCommand);
      return;
    }
    if (s.status === 'error') {
      showModal('❌', 'ההורדה נכשלה', s.error || 'שגיאה לא ידועה');
      return;
    }

    const lines = [s.title || ''];
    if (s.status === 'preparing' && STAGE_LABELS[s.stage]) lines.push(STAGE_LABELS[s.stage]);
    if (s.percent) lines.push(s.percent + '%');
    showProgressModal(STATUS_LABELS[s.status] || s.status, lines.filter(Boolean).join('\n'),
                      s.percent || 0);
  }

  // ============================================================
  // זרימת ערוץ שלם
  // ============================================================

  function startChannelFlow(mode) {
    const channelUrl = getChannelUrlFromPage();
    if (!channelUrl) { showModal('❌', 'שגיאה', 'לא זוהתה כתובת ערוץ בעמוד הזה.'); return; }

    setBusy(true);
    callApi('channel_preview', { url: channelUrl, mode: mode }).then(function (res) {
      setBusy(false);

      if (!res.willDownload) {
        showModal('ℹ️', 'אין סרטונים חדשים',
          'כל ' + res.totalInChannel + ' הסרטונים בערוץ "' + res.channel + '" כבר ירדו.');
        return;
      }

      showConfirmModal('📺', 'הורדת ערוץ: ' + res.channel,
        'נמצאו ' + res.remaining + ' סרטונים חדשים.\n' +
        'הלחיצה הזו תוריד ' + res.willDownload + ' מהם' +
        (res.alreadyDownloaded ? ' (מדלגים על ' + res.alreadyDownloaded + ' שכבר ירדו).' : '.') +
        '\n\nההורדה רצה ברקע - אפשר להמשיך לגלוש.',
        'התחל הורדה',
        function () { submitChannel(channelUrl, mode, res.remaining, res.willDownload); });
    }).catch(function (err) {
      setBusy(false);
      showModal('❌', 'שגיאה', err.message);
    });
  }

  function submitChannel(channelUrl, mode, remaining, willDownload) {
    setBusy(true);
    showProgressModal('פותח את עבודת הערוץ...', '', 0);

    callApi('channel_download', { url: channelUrl, mode: mode }).then(function (res) {
      const remainingAfter = Math.max(0, remaining - willDownload);
      showProgressModal('מוריד את הערוץ: ' + res.channel, '0 מתוך ' + res.total, 0);
      pollChannel(res.jobId, res.channel, remainingAfter);
    }).catch(function (err) {
      setBusy(false);
      showModal('❌', 'שגיאה', err.message);
    });
  }

  function pollChannel(jobId, channel, remainingAfter) {
    GM_setValue('activeJob', JSON.stringify({ type: 'channel', jobId: jobId, channel: channel }));

    const timer = setInterval(function () {
      callApi('channel_status', { jobId: jobId }).then(function (s) {
        if (s.status === 'done') {
          clearInterval(timer);
          setBusy(false);
          GM_setValue('activeJob', '');

          const summary = '✅ ירדו: ' + s.done + '\n❌ נכשלו: ' + s.failed +
            '\n⛔ נחסמו: ' + s.blocked +
            (remainingAfter ? '\n\nנשארו עוד ' + remainingAfter +
                              ' סרטונים בערוץ - אפשר ללחוץ שוב.' : '');
          showModal('✅', 'הורדת הערוץ הסתיימה: ' + channel, summary, s.folderLink);
          return;
        }

        showProgressModal('מוריד את הערוץ: ' + channel,
          s.processed + ' מתוך ' + s.total + ' (' + s.percent + '%)\n' +
          '✅ ' + s.done + '  ❌ ' + s.failed + '  ⛔ ' + s.blocked,
          s.percent);
      }).catch(function () { /* ננסה שוב בסבב הבא */ });
    }, CHANNEL_POLL_INTERVAL_MS);
  }

  function resumeActiveJob() {
    const raw = GM_getValue('activeJob', '');
    if (!raw) return;
    try {
      const job = JSON.parse(raw);
      if (job.type === 'video') pollVideo(job.jobId);
      else if (job.type === 'channel') pollChannel(job.jobId, job.channel, 0);
    } catch (e) {
      GM_setValue('activeJob', '');
    }
  }

  // ============================================================
  // חלוניות
  // ============================================================

  let currentOverlay = null;

  function closeOverlay() {
    if (currentOverlay && currentOverlay.parentNode) currentOverlay.parentNode.removeChild(currentOverlay);
    currentOverlay = null;
  }

  function baseOverlay() {
    closeOverlay();
    const overlay = el('div', {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,.65)', zIndex: '9999999',
      display: 'flex', justifyContent: 'center', alignItems: 'center', fontFamily: 'Arial, sans-serif',
    });
    currentOverlay = overlay;
    document.body.appendChild(overlay);
    return overlay;
  }

  function modalBox() {
    return el('div', {
      background: '#fff', padding: '26px', borderRadius: '14px', textAlign: 'center',
      maxWidth: '400px', width: '90%', boxShadow: '0 6px 24px rgba(0,0,0,.35)', direction: 'rtl',
    });
  }

  function closeButton(label) {
    const btn = el('button', {
      marginTop: '16px', padding: '10px 20px', border: 'none', borderRadius: '20px',
      background: COLORS.brand, color: '#fff', fontWeight: 'bold', cursor: 'pointer', width: '100%',
    }, { innerText: label || 'סגור' });
    btn.onclick = closeOverlay;
    return btn;
  }

  function showModal(emoji, title, text, linkUrl, copyCommand) {
    const overlay = baseOverlay();
    const modal = modalBox();

    modal.appendChild(el('div', { fontSize: '38px' }, { innerText: emoji }));
    modal.appendChild(el('h2', { margin: '10px 0' }, { innerText: title }));
    modal.appendChild(el('p', { whiteSpace: 'pre-line', color: '#444' }, { innerText: text || '' }));

    if (linkUrl) {
      const link = el('a', {
        display: 'block', margin: '14px 0', padding: '10px', borderRadius: '20px',
        background: COLORS.ok, color: '#fff', textDecoration: 'none', fontWeight: 'bold',
      }, { href: linkUrl, target: '_blank', rel: 'noopener', innerText: '📂 פתח בדרייב' });
      modal.appendChild(link);
    }

    if (copyCommand) {
      const box = el('div', {
        margin: '10px 0', padding: '10px', background: '#f4f3fb', borderRadius: '8px',
        fontFamily: 'monospace', fontSize: '12px', direction: 'ltr', textAlign: 'left',
        wordBreak: 'break-all',
      }, { innerText: copyCommand });
      modal.appendChild(box);

      const copyBtn = el('button', {
        padding: '8px 16px', border: 'none', borderRadius: '16px', background: '#eee', cursor: 'pointer',
      }, { innerText: 'העתק פקודת מיזוג' });
      copyBtn.onclick = function () { navigator.clipboard.writeText(copyCommand); };
      modal.appendChild(copyBtn);
    }

    modal.appendChild(closeButton());
    overlay.appendChild(modal);
  }

  function showInputModal(title, label, currentValue, onSubmit) {
    const overlay = baseOverlay();
    const modal = modalBox();

    modal.appendChild(el('h2', { margin: '0 0 10px' }, { innerText: title }));
    modal.appendChild(el('p', { color: '#666', fontSize: '14px' }, { innerText: label }));

    const input = el('input', {
      width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ccc',
      fontSize: '14px', boxSizing: 'border-box', direction: 'ltr',
    }, { type: 'text', value: currentValue || '' });
    modal.appendChild(input);

    const row = el('div', { display: 'flex', gap: '8px', marginTop: '14px' });
    const ok = el('button', {
      flex: '1', padding: '10px', border: 'none', borderRadius: '16px',
      background: COLORS.brand, color: '#fff', cursor: 'pointer',
    }, { innerText: 'שמור' });
    const cancel = el('button', {
      flex: '1', padding: '10px', border: 'none', borderRadius: '16px',
      background: '#eee', cursor: 'pointer',
    }, { innerText: 'ביטול' });

    ok.onclick = function () { const v = input.value; closeOverlay(); onSubmit(v); };
    cancel.onclick = closeOverlay;

    row.appendChild(ok);
    row.appendChild(cancel);
    modal.appendChild(row);
    overlay.appendChild(modal);
    input.focus();
  }

  function showConfirmModal(emoji, title, text, confirmLabel, onConfirm) {
    const overlay = baseOverlay();
    const modal = modalBox();

    modal.appendChild(el('div', { fontSize: '38px' }, { innerText: emoji }));
    modal.appendChild(el('h2', { margin: '10px 0' }, { innerText: title }));
    modal.appendChild(el('p', { whiteSpace: 'pre-line', color: '#444' }, { innerText: text }));

    const row = el('div', { display: 'flex', gap: '8px', marginTop: '16px' });
    const ok = el('button', {
      flex: '1', padding: '10px', border: 'none', borderRadius: '16px',
      background: COLORS.ok, color: '#fff', cursor: 'pointer',
    }, { innerText: confirmLabel });
    const cancel = el('button', {
      flex: '1', padding: '10px', border: 'none', borderRadius: '16px',
      background: '#eee', cursor: 'pointer',
    }, { innerText: 'ביטול' });

    ok.onclick = function () { closeOverlay(); onConfirm(); };
    cancel.onclick = closeOverlay;

    row.appendChild(ok);
    row.appendChild(cancel);
    modal.appendChild(row);
    overlay.appendChild(modal);
  }

  /** מתעדכנת במקום להיפתח מחדש, כדי שהסרגל לא יהבהב בכל דגימה. */
  function showProgressModal(title, text, percent) {
    const existing = document.getElementById('ytd-progress-title');
    if (existing && currentOverlay) {
      existing.innerText = title;
      document.getElementById('ytd-progress-text').innerText = text;
      document.getElementById('ytd-progress-bar').style.width = (percent || 0) + '%';
      return;
    }

    const overlay = baseOverlay();
    const modal = modalBox();

    modal.appendChild(el('div', { fontSize: '34px' }, { innerText: '⬇️' }));
    modal.appendChild(el('h2', { margin: '8px 0', fontSize: '18px' },
      { id: 'ytd-progress-title', innerText: title }));
    modal.appendChild(el('p', { whiteSpace: 'pre-line', color: '#444', fontSize: '14px' },
      { id: 'ytd-progress-text', innerText: text }));

    const barOuter = el('div', {
      width: '100%', height: '8px', background: '#eee', borderRadius: '4px',
      overflow: 'hidden', margin: '12px 0',
    });
    const bar = el('div', {
      width: (percent || 0) + '%', height: '100%', background: COLORS.brand, transition: 'width .4s',
    }, { id: 'ytd-progress-bar' });
    barOuter.appendChild(bar);
    modal.appendChild(barOuter);

    modal.appendChild(closeButton('סגור (ההורדה ממשיכה ברקע)'));
    overlay.appendChild(modal);
  }

  // ============================================================

  window.addEventListener('load', function () {
    createFloatingMenu();
    resumeActiveJob();
  });
  setInterval(createFloatingMenu, 3000);
})();
