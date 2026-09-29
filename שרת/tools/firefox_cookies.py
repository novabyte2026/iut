import base64, glob, os, shutil, sqlite3, subprocess, tempfile, time

profiles = glob.glob(os.path.expandvars(r'%APPDATA%\Mozilla\Firefox\Profiles\*\cookies.sqlite'))
src = max(profiles, key=os.path.getmtime)

tmp = tempfile.mkdtemp()
try:
    for suffix in ('', '-wal', '-shm'):
        if os.path.exists(src + suffix):
            shutil.copy2(src + suffix, os.path.join(tmp, 'cookies.sqlite' + suffix))
    db = sqlite3.connect(os.path.join(tmp, 'cookies.sqlite'))
    rows = db.execute(
        "SELECT host, path, isSecure, expiry, name, value, isHttpOnly FROM moz_cookies "
        "WHERE (host = 'youtube.com' OR host LIKE '%.youtube.com') AND originAttributes = ''"
    ).fetchall()
    db.close()
finally:
    shutil.rmtree(tmp, ignore_errors=True)

lines = ['# Netscape HTTP Cookie File']
names = []
now = time.time()
for host, path, secure, expiry, name, value, http_only in rows:
    if expiry > 10**11:
        expiry //= 1000
    if expiry and expiry < now:
        continue
    domain = ('#HttpOnly_' if http_only else '') + host
    lines.append('\t'.join([domain, 'TRUE' if host.startswith('.') else 'FALSE', path,
                            'TRUE' if secure else 'FALSE', str(int(expiry)), name, value]))
    names.append(name)

text = '\n'.join(lines) + '\n'
subprocess.run(['clip'], input=base64.b64encode(text.encode()), check=True)

logged_in = any(n in names for n in ('SID', '__Secure-3PSID', '__Secure-1PSID'))
print('profile:', os.path.basename(os.path.dirname(src)))
print('youtube cookies:', len(names), ' loggedIn:', logged_in, ' LOGIN_INFO:', 'LOGIN_INFO' in names)
print('names:', ','.join(sorted(set(names))))
print('clipboard: ready')
