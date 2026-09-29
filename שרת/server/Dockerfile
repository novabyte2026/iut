# yt-dlp הוא סקריפט פייתון ו-ffmpeg הוא מה שממזג וידאו ואודיו נפרדים.
# בלי שניהם אין 1080p, וזו כל הסיבה שהחצי הזה של המערכת רץ במכולה
# ולא ב-Apps Script.

# ספק ה-PO Token של yt-dlp (bgutil), בנוי מראש. לוקחים ממנו רק את /app
# (הקוד המקומפל ו-node_modules). התמונה שלו בנויה על node:26-bookworm-slim,
# ולכן גם התמונה שלנו - כך המודול הבינארי canvas שבתוכו תואם ל-Node שמריץ אותו.
FROM brainicism/bgutil-ytdlp-pot-provider:2.0.0-node AS pot

FROM node:26-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # קישור סימבולי לאותה תיקייה ש-yt-dlp יושב בה: בריצה ב-Railway
 # yt-dlp נמצא ו-ffmpeg לא, כנראה בגלל PATH מצומצם בזמן ריצה.
 && ln -sf /usr/bin/ffmpeg /usr/local/bin/ffmpeg \
 && ln -sf /usr/bin/ffprobe /usr/local/bin/ffprobe \
 && ffmpeg -version

# ADD עם כתובת נבדק מחדש בכל בנייה, ולכן גרסה חדשה של yt-dlp שוברת את
# המטמון ונמשכת אוטומטית. RUN curl היה נשאר תקוע על הגרסה הראשונה שנבנתה.
# ה-nightly ולא ה-stable: תיקונים לשינויים של יוטיוב מגיעים לשם קודם.
ADD https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp

# התוסף של yt-dlp שפונה לספק ה-PO Token. yt-dlp טוען zip מתיקיית התוספים.
ADD https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/2.0.0/bgutil-ytdlp-pot-provider.zip /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip

RUN chmod 755 /usr/local/bin/yt-dlp \
 && chmod 644 /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip \
 && yt-dlp --version

COPY --from=pot /app /opt/bgutil
RUN test -f /opt/bgutil/build/main.js

WORKDIR /app

# שכבה נפרדת לתלויות: שינוי בקוד לא מבטל את מטמון ה-npm ci.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# נתיבים מוחלטים לבינאריים, כדי ש-spawn לא יהיה תלוי כלל ב-PATH של זמן
# הריצה. PATH מפורש נשמר גם הוא, בשביל yt-dlp שמחפש את ffmpeg ואת node
# (מנוע ה-JavaScript שלו) בעצמו.
ENV NODE_ENV=production \
    DATA_DIR=/data/jobs \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    POT_SERVER_SCRIPT=/opt/bgutil/build/main.js \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ריצה כמשתמש לא-root. תמונות node כבר מגדירות את המשתמש node.
RUN mkdir -p /data/jobs && chown -R node:node /data
USER node

EXPOSE 3000
CMD ["node", "src/index.js"]
