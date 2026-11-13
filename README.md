# ProxyScout

Proxy scraper and checker with a modern web dashboard. Scrapes public proxy lists, tests every proxy for speed, anonymity, Google access, HTTPS support and country, stores results in a local SQLite database, and exports what you need.

## Features

**Scraping**
- 12 built-in sources (8 enabled by default), plus unlimited custom sources
- Parses plain `ip:port` lists, `protocol://ip:port` URLs, HTML tables and JSON
- 1–100 parallel fetches, per-source and global proxy limits, live per-source progress
- "Test source" preview before saving a custom source
- Optional auto-hand-off of new proxies to the checker

**Checking**
- HTTP, HTTPS (CONNECT), SOCKS4 and SOCKS5, plus auto-detect for unknown lists
- Response time (connect → first byte through the proxy)
- Anonymity: elite / anonymous / transparent, graded against a proxy judge
- Google access over HTTPS (flags block and captcha pages) — also marks HTTP proxies that support HTTPS
- Country lookup (ip-api.com batch, cached)
- 1–1000 concurrent tests, timeout, retries, custom target URL and "must contain" text
- Scopes: untested, failed only, working (re-verify), all, or any selection

**Database & export**
- Local SQLite, no cloud dependency; working proxies saved automatically
- Filter by status, type, anonymity, Google, country, max response time, free-text search
- Sort any column, bulk select (page or all matching), copy, re-test, export, delete
- Export TXT (`ip:port` or `protocol://ip:port`), CSV and JSON

**Interface**
- Dashboard with KPIs, protocol / anonymity mix, response-time histogram, top countries
- Live progress over server-sent events, activity log with level filters
- Dark and light themes, mobile layout, built-in guide (F1), keyboard shortcuts

## Run it

Requires Node.js 18.17+ (22 recommended).

```bash
npm install --omit=dev
npm start
# open http://127.0.0.1:8787
```

Configuration is by environment variable:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback when behind Apache/nginx |
| `APP_PASSWORD` | *(none)* | Enables a login prompt (HTTP basic auth). **Set this whenever the app is reachable from the internet** |
| `APP_USER` | `admin` | Login username |
| `DATA_DIR` | `./data` | Where `proxyscout.db` lives |
| `PUBLIC_IP` | *(auto)* | Comma-separated server IP(s), if the judge can't detect them |

## One-command server install (Ubuntu + Apache + Cloudflare)

```bash
curl -fsSL https://raw.githubusercontent.com/mattriedl/ProxyScout/main/deploy/setup-server.sh -o /root/proxyscout-setup.sh
bash /root/proxyscout-setup.sh proxyscout.example.com
```

This installs the app as a service on `127.0.0.1:8787`, generates a login password (printed once, kept in `/opt/proxyscout/proxyscout.env`), creates a proxied Cloudflare DNS record and a Let's Encrypt certificate (using `/root/.secrets/cloudflare.ini`), adds an Apache vhost, and pulls new commits from `main` every 2 minutes. Re-running it is safe. Deploy status: `/var/log/proxyscout-sync.log`. A deploy restarts the service, which ends any job that is running.

The app always sends `X-Robots-Tag: noindex`, serves a disallow-all `robots.txt` and requires a login, so search engines never index it and it has no effect on the parent domain.

## Manual install on an Ubuntu server behind Apache

```bash
# 1. App files
sudo mkdir -p /opt/proxyscout && sudo cp -r . /opt/proxyscout
cd /opt/proxyscout && sudo npm install --omit=dev
sudo useradd --system --home /opt/proxyscout --shell /usr/sbin/nologin proxyscout
sudo chown -R proxyscout:proxyscout /opt/proxyscout

# 2. Service (edit APP_PASSWORD first)
sudo cp deploy/proxyscout.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now proxyscout

# 3. Apache reverse proxy on a subdomain
sudo a2enmod proxy proxy_http headers rewrite ssl
sudo cp deploy/apache-proxyscout.conf /etc/apache2/sites-available/proxyscout.conf
# edit ServerName + certificate paths, then:
sudo a2ensite proxyscout && sudo systemctl reload apache2
```

The service binds to `127.0.0.1:8787`, so no firewall port needs opening; Apache serves it on 443. The Apache config sets `flushpackets=on` so the live progress stream isn't buffered.

Raise the open-file limit if you run more than ~500 threads (the service file sets `LimitNOFILE=65535`).

## Notes on accuracy

- **Anonymity needs a judge that sees the proxy directly.** The default judge is `http://httpbin.org/get`. ProxyScout also serves its own judge at `/judge`, but only use it when the app is reachable without Cloudflare or a reverse proxy in between — those add `X-Forwarded-For` headers and every proxy would grade as "anonymous".
- **Response time** is measured to the target URL (or the judge if no target is set).
- **Google pass** means `https://www.google.com/` loaded through the proxy with valid TLS and no `/sorry/` or captcha page.
- Free public proxies churn constantly; expect 3–10% alive on a typical run. Re-test the **Failed** scope later — some come back.

## Files

```
server.js          Express app, REST API, live event stream, built-in /judge
lib/net.js         Raw-socket HTTP client through HTTP / CONNECT / SOCKS4 / SOCKS5
lib/checker.js     Test job: speed, anonymity, Google, HTTPS, retries
lib/scraper.js     Scrape job: parallel fetch, parse, de-duplicate, limits
lib/parse.js       ip:port extraction from text, HTML and JSON
lib/geo.js         Batched, cached, rate-limited country lookup
lib/db.js          SQLite schema, built-in sources, settings
public/            Single-page UI (no build step)
deploy/            systemd unit and Apache vhost
```

Use it on proxies you're permitted to use, and respect the terms of the sites you test against.
