# שרת החילוץ — Railway

החצי שמריץ בינאריים. yt-dlp מחלץ, ffmpeg ממזג, והתוצאה מוגשת עם תמיכה
ב־`Range` כדי שהצד של Apps Script יוכל למשוך אותה בנתחים ולדחוף לדרייב.

---

## למה בכלל שני חצאים

| | רץ כאן (Railway) | רץ שם (Apps Script) |
|---|---|---|
| yt-dlp, ffmpeg | ✅ בינאריים במכולה | ❌ אין הרצת תהליכים |
| 1080p ומעלה | ✅ ffmpeg ממזג רצועות נפרדות | ❌ אין ffmpeg |
| העלאה לדרייב אישי | ❌ דורש OAuth מלא | ✅ `ScriptApp.getOAuthToken()` |
| עלות | דקות מכולה | חינם |

הצד של דרייב הוא הסיבה האמיתית לפיצול. חשבון שירות היה נראה כמו הפתרון
המתבקש להעלאה מהשרת, אבל **לחשבון שירות אין מכסת אחסון משלו בדרייב**, ולכן
הוא לא יכול להיות הבעלים של קבצים בדרייב אישי וההעלאה נכשלת ב־
`storageQuotaExceeded`. Apps Script מקבל טוקן לחשבון שלכם בחינם ועוקף את זה.

---

## חסימת הבוטים — הדבר שישבור לכם את השרת

יוטיוב חוסמת אגרסיבית כתובות IP של ספקי ענן, ו־Railway בכללן. הסימפטום:

```
ERROR: Sign in to confirm you're not a bot
```

זה לא באג ולא גרסה ישנה של yt-dlp. הפתרון היחיד שעובד באופן יציב הוא קובץ
עוגיות מדפדפן שמחובר לחשבון יוטיוב:

1. התקינו תוסף לייצוא עוגיות בפורמט Netscape.
2. **פתחו חלון פרטי**, התחברו ליוטיוב, וייצאו את העוגיות משם.
3. סגרו את החלון הפרטי **בלי להתנתק**.

השלב השלישי אינו קפריזה: יוטיוב מסובבת עוגיות סשן, וגלישה רגילה באותו חשבון
תפסול את הקובץ שייצאתם תוך שעות. חלון פרטי שנסגר בלי logout מקפיא את הסשן.

ל-Railway אין כפתור "העלה קובץ" ללוח הבקרה, ולכן אי אפשר לשים את `cookies.txt`
על ה-Volume ישירות. הדרך המעשית: מקודדים אותו ל-base64 ומדביקים כמשתנה
סביבה — `writeCookiesFromEnv()` ב-`config.js` כותב אותו לדיסק בעלייה:

```bash
base64 -w0 cookies.txt   # לינוקס / מק / Git Bash
```

```powershell
certutil -encode cookies.txt cookies.b64   # PowerShell - מוציא שורות BEGIN/END, יש להסיר
```

את הפלט מדביקים ב-Variables תחת `COOKIES_B64`. אין צורך להגדיר `COOKIES_FILE`
בנפרד — הוא נקבע אוטומטית כשיש `COOKIES_B64`.

השתמשו בחשבון משני. העוגיות האלה נותנות גישה לחשבון, וקובץ שדולף שווה
לסיסמה שדלפה.

---

## הקמה

### 1. פריסה

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

Railway מזהה את `Dockerfile` דרך `railway.json`. תחת Settings ← Networking
לחצו Generate Domain — הכתובת שתתקבל היא מה שנכנס ל־`RAILWAY_ENDPOINT`
בצד של Apps Script.

### 2. Volume

Settings ← Volumes ← New Volume, ומפו ל־`/data`.

בלי זה הכול עדיין עובד, אבל כל פריסה מחדש מוחקת הורדות שנמצאות באוויר,
וגם קובץ העוגיות נעלם.

### 3. משתני סביבה

צרו טוקן:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

הגדירו ב־Railway תחת Variables את `SHARED_TOKEN`, ואת אותו ערך בדיוק
ב־Script Properties של Apps Script תחת `RAILWAY_TOKEN`. שאר המשתנים
מתועדים ב־`.env.example` ויש להם ברירות מחדל סבירות.

### 4. בדיקה

```bash
curl https://your-app.up.railway.app/health
```

`cookies: true` בתשובה אומר שקובץ העוגיות נטען. אם הוא `false`, כל הורדה
תיכשל בחסימת בוטים.

---

## ה־API

הצרכן היחיד הוא פרויקט Apps Script. כל הנתיבים תחת `/api` דורשים
`Authorization: Bearer <SHARED_TOKEN>`, כולל בקשות הנתחים.

```
POST   /api/jobs              {url, mode, quality}
                              -> 202 {id, status}

GET    /api/jobs/:id          -> {status, stage, progress, title, files[]}
                                 status: queued | working | ready | error

GET    /api/files/:id/:name   Range: bytes=0-8388607
                              -> 206 + Content-Range

DELETE /api/jobs/:id          -> 204   משחרר את הדיסק

GET    /api/channel?url=..    -> {title, videos: [{id, title, url}]}
                                 רשימה בלבד, בלי הורדה - לזרימת "הורד ערוץ"

GET    /health                ללא אימות (Railway בודקת חיות)
```

**תמיכת `Range` היא חלק מהחוזה, לא אופטימיזציה.** `UrlFetchApp` לא מקבל
יותר מ־50MB בתשובה אחת, ולכן הצד השני מושך בנתחי 8MB. שרת שיתעלם מהכותרת
יפיל כל הורדה מעל 50MB.

---

## מבנה

| קובץ | תפקיד |
|---|---|
| `src/index.js` | חיווט, סגירה מסודרת מול SIGTERM |
| `src/config.js` | קריאת סביבה ואימות בעלייה |
| `src/queue.js` | תור בזיכרון עם הגבלת מקביליות |
| `src/ytdlp.js` | הרצת yt-dlp, פרסור התקדמות, תרגום שגיאות |
| `src/storage.js` | מחזור חיים של קבצים, תקרת דיסק, ניקוי לפי גיל |
| `src/routes/files.js` | הגשה עם `Range` |
| `src/routes/jobs.js` | ה־API של העבודות |
| `src/routes/channel.js` | רשימת סרטוני ערוץ (`yt-dlp --flat-playlist`), בלי הורדה |
| `src/auth.js` | טוקן משותף בהשוואת זמן קבוע |

---

## תפעול

התור יושב בזיכרון בכוונה. השרת הוא תחנת מעבר, והמצב הקובע נמצא בצד של
Apps Script — הפעלה מחדש באמצע גורמת ל־404, והצד השני מזמין מחדש לבד.

`CONCURRENCY=1` היא ברירת המחדל כי מיזוג ffmpeg צורך CPU והמכולות של
Railway צנועות. העלו רק אם ראיתם שיש מקום.

`yt-dlp` מתעדכן תכופות כי יוטיוב משנה פורמטים. בנייה מחדש של התמונה מושכת
גרסה עדכנית; אין עדכון אוטומטי בזמן ריצה. אם הורדות מתחילות להיכשל בלי
סיבה נראית לעין, זה החשוד הראשון — פרסו מחדש.

| תסמין | סיבה |
|---|---|
| `Sign in to confirm you're not a bot` | אין עוגיות, או שפג תוקפן |
| `הקובץ שנוצר ריק` | חריגה מ־`MAX_FILE_MB`; yt-dlp עצר באמצע |
| 404 על כל בקשת מצב | השרת הופעל מחדש. תקין, הצד השני יזמין מחדש |
| הדיסק מתמלא | Apps Script לא שולח DELETE. הניקוי לפי גיל יטפל |
| `yt-dlp לא נמצא בנתיב` | הבנייה נכשלה. בדקו את לוג ה־Docker |
