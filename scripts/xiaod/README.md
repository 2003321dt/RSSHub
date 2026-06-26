# Xiaod Railway RSSHub Exporter

This directory contains the RSSHub-side exporter for `小D看剧日报`.

Railway Web Service:

- Deploy this RSSHub repo with the existing `Dockerfile`.
- Set Healthcheck Path to `/healthz`.
- Recommended env:
    - `NODE_ENV=production`
    - `DISABLE_IPV6=1`
    - `CACHE_TYPE=memory`
    - `CACHE_EXPIRE=300`
    - `CACHE_CONTENT_EXPIRE=3600`
    - `REQUEST_TIMEOUT=30000`
    - `REQUEST_RETRY=2`
    - `NO_LOGFILES=1`

Railway Cron exporter:

- Command: `node scripts/xiaod/export-hot-routes.mjs`
- Schedule: `30 0 * * *` when Railway cron is UTC, equivalent to 08:30 Asia/Shanghai.
- Required env for GitHub handoff:
    - `RSSHUB_BASE_URL=https://<your-rsshub-service>.up.railway.app`
    - `GITHUB_TOKEN=<fine-grained-token-with-contents-write>`
    - `OUTPUT_REPO=2003321dt/RSSHub`
    - `OUTPUT_BRANCH=main`
    - `OUTPUT_PATH=outputs/rsshub/latest-hotspots.json`

The exporter always writes a structured JSON result. Partial route failures are recorded in `failures` and do not erase successful route items.
