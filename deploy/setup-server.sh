#!/usr/bin/env bash
# One-command install of ProxyScout on an Ubuntu + Apache server.
#
#   bash setup-server.sh proxyscout.wagerassistant.com [port]
#
# Idempotent: safe to re-run. It
#   - installs the app to /opt/proxyscout/app (from GitHub) as a systemd service on 127.0.0.1:<port>
#   - generates a login password once (stored in /opt/proxyscout/proxyscout.env)
#   - creates a proxied Cloudflare DNS record and a Let's Encrypt certificate, using the
#     certbot token in /root/.secrets/cloudflare.ini when present
#   - adds an Apache vhost with noindex headers
#   - auto-deploys new commits on the branch every 2 minutes (/usr/local/bin/proxyscout-sync)
set -euo pipefail

DOMAIN="${1:?usage: setup-server.sh <domain> [port]}"
PORT="${2:-8787}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/mattriedl/ProxyScout.git}"
BASE=/opt/proxyscout
APP=$BASE/app
DATA=$BASE/data
ENVF=$BASE/proxyscout.env
RUN_USER=proxyscout
CF_INI=/root/.secrets/cloudflare.ini

log() { printf '\n== %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
command -v node >/dev/null || { echo "Node.js is not installed."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node 22.13+ required (found $(node -v))."; exit 1; }

if ss -ltnH "sport = :$PORT" | grep -q . && ! systemctl is-active -q proxyscout; then
  echo "Port $PORT is already in use by something else. Pass another port as the 2nd argument."
  exit 1
fi

log "User and code ($BRANCH)"
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin "$RUN_USER"
mkdir -p "$BASE" "$DATA"
[ -d "$APP/.git" ] || git clone -q --branch "$BRANCH" "$REPO_URL" "$APP"
chown -R "$RUN_USER:$RUN_USER" "$APP" "$DATA"
chmod 750 "$BASE"
runuser -u "$RUN_USER" -- env HOME="$BASE" bash -c \
  "cd '$APP' && git fetch -q origin '$BRANCH' && git reset -q --hard 'origin/$BRANCH' && npm ci --omit=dev --no-audit --no-fund --loglevel=error"
echo "code at $(git -C "$APP" rev-parse --short HEAD)"

NEW_PASSWORD=""
if [ ! -f "$ENVF" ]; then
  NEW_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-20)"
  umask 077
  printf 'APP_USER=admin\nAPP_PASSWORD=%s\n' "$NEW_PASSWORD" > "$ENVF"
  umask 022
fi
chmod 600 "$ENVF"

log "Service"
cat > /etc/systemd/system/proxyscout.service <<UNIT
[Unit]
Description=ProxyScout proxy scraper & checker ($DOMAIN)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP
ExecStart=$(command -v node) server.js
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA
EnvironmentFile=$ENVF
Restart=on-failure
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q proxyscout
systemctl restart proxyscout

log "Cloudflare DNS"
SERVER_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')"
if [ -f "$CF_INI" ]; then
  TOKEN="$(sed -n 's/^[[:space:]]*dns_cloudflare_api_token[[:space:]]*=[[:space:]]*//p' "$CF_INI" | tr -d '[:space:]')"
  cf() { curl -fsS --max-time 20 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
  ZONE_ID=""
  ZNAME="$DOMAIN"
  while [ -z "$ZONE_ID" ] && [[ "$ZNAME" == *.* ]]; do
    ZNAME="${ZNAME#*.}"
    ZONE_ID="$(cf "https://api.cloudflare.com/client/v4/zones?name=$ZNAME" 2>/dev/null | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result") or [];print(r[0]["id"] if r else "")' || true)"
  done
  if [ -n "$ZONE_ID" ]; then
    COUNT="$(cf "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=$DOMAIN" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["result"]))')"
    if [ "$COUNT" = 0 ]; then
      cf -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
        --data "{\"type\":\"A\",\"name\":\"$DOMAIN\",\"content\":\"$SERVER_IP\",\"proxied\":true,\"ttl\":1,\"comment\":\"ProxyScout\"}" >/dev/null
      echo "created proxied A record $DOMAIN -> $SERVER_IP"
    else
      echo "DNS record for $DOMAIN already exists"
    fi
  else
    echo "WARNING: the Cloudflare token can't see the zone for $DOMAIN. Add an A record to $SERVER_IP (proxied) manually."
  fi
else
  echo "No $CF_INI — add an A record for $DOMAIN to $SERVER_IP yourself."
fi

log "Certificate"
a2enmod -q proxy proxy_http headers ssl rewrite >/dev/null
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  if [ -f "$CF_INI" ]; then
    certbot certonly -n --agree-tos --register-unsafely-without-email --dns-cloudflare \
      --dns-cloudflare-credentials "$CF_INI" --dns-cloudflare-propagation-seconds 30 -d "$DOMAIN"
  else
    echo "No Cloudflare credentials for a DNS challenge; issue a certificate for $DOMAIN, then re-run."
    exit 1
  fi
fi

log "Apache"
cat > "/etc/apache2/sites-available/$DOMAIN.conf" <<VHOST
# ProxyScout — managed by deploy/setup-server.sh
<VirtualHost *:80>
    ServerName $DOMAIN
    Header always set X-Robots-Tag "noindex, nofollow, noarchive"
    RewriteEngine On
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>

<VirtualHost *:443>
    ServerName $DOMAIN
    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/$DOMAIN/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/$DOMAIN/privkey.pem

    Header always set X-Robots-Tag "noindex, nofollow, noarchive"
    Header always set X-Content-Type-Options "nosniff"
    Header always set Referrer-Policy "same-origin"

    ProxyPreserveHost On
    ProxyRequests Off
    ProxyTimeout 600
    RequestHeader set X-Forwarded-Proto "https"
    ProxyPass        /api/events http://127.0.0.1:$PORT/api/events flushpackets=on
    ProxyPassReverse /api/events http://127.0.0.1:$PORT/api/events
    ProxyPass        / http://127.0.0.1:$PORT/
    ProxyPassReverse / http://127.0.0.1:$PORT/

    ErrorLog \${APACHE_LOG_DIR}/$DOMAIN-error.log
    CustomLog \${APACHE_LOG_DIR}/$DOMAIN-access.log combined
</VirtualHost>
VHOST
a2ensite -q "$DOMAIN" >/dev/null
apache2ctl configtest
systemctl reload apache2

log "Auto-deploy"
cat > /usr/local/bin/proxyscout-sync <<SYNC
#!/usr/bin/env bash
# Deploy new commits of $BRANCH to ProxyScout.   proxyscout-sync [--force]
set -euo pipefail
APP=$APP; BRANCH=$BRANCH; RUN_USER=$RUN_USER; STATUS=/var/log/proxyscout-sync.status
exec 9>/run/proxyscout-sync.lock; flock -n 9 || exit 0
as_app() { runuser -u "\$RUN_USER" -- env HOME=$BASE "\$@"; }
cd "\$APP"
as_app git fetch -q origin "\$BRANCH" || exit 0
LOCAL="\$(as_app git rev-parse HEAD)"; REMOTE="\$(as_app git rev-parse "origin/\$BRANCH")"
if [ "\$LOCAL" = "\$REMOTE" ] && [ "\${1:-}" != "--force" ]; then exit 0; fi
echo "\$(date -Is) deploying \${LOCAL:0:7} -> \${REMOTE:0:7}"
LOCK_BEFORE="\$(as_app git rev-parse HEAD:package-lock.json 2>/dev/null || true)"
as_app git reset -q --hard "origin/\$BRANCH"
if [ "\$LOCK_BEFORE" != "\$(as_app git rev-parse HEAD:package-lock.json)" ] || [ "\${1:-}" = "--force" ]; then
  as_app npm ci --omit=dev --no-audit --no-fund --loglevel=error
fi
systemctl restart proxyscout
sleep 2
if systemctl is-active -q proxyscout; then
  echo "\$(date -Is) ok \${REMOTE:0:7}" | tee "\$STATUS"
else
  echo "\$(date -Is) FAILED \${REMOTE:0:7} — see journalctl -u proxyscout" | tee "\$STATUS"
fi
SYNC
chmod 755 /usr/local/bin/proxyscout-sync
echo "*/2 * * * * root /usr/local/bin/proxyscout-sync >> /var/log/proxyscout-sync.log 2>&1" > /etc/cron.d/proxyscout-sync
chmod 644 /etc/cron.d/proxyscout-sync

log "Smoke test"
sleep 2
source "$ENVF"
curl -s -o /dev/null -w "local  /api/info (with login) -> %{http_code}\n" -u "admin:$APP_PASSWORD" "http://127.0.0.1:$PORT/api/info"
curl -s -o /dev/null -w "local  /api/info (no login)   -> %{http_code}\n" "http://127.0.0.1:$PORT/api/info"
curl -s -o /dev/null -w "apache https (with login)     -> %{http_code}\n" -u "admin:$APP_PASSWORD" --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/info"
curl -sI --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/robots.txt" | grep -i x-robots-tag || true

echo
echo "ProxyScout: https://$DOMAIN   (service: proxyscout, port $PORT, branch $BRANCH)"
echo "Logs: journalctl -u proxyscout -f   |   deploys: /var/log/proxyscout-sync.log"
if [ -n "$NEW_PASSWORD" ]; then
  echo "Login: admin / $NEW_PASSWORD   (stored in $ENVF)"
else
  echo "Login: unchanged (see $ENVF)"
fi
