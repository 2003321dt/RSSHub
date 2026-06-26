import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ROUTES = [
    { route: '/baidu/top/teleplay', source: 'RSSHub-Baidu-Teleplay', tags: ['teleplay'] },
    { route: '/douban/list/tv_real_time_hotest', source: 'RSSHub-Douban-TV', tags: ['tv'] },
    { route: '/douban/list/show_chinese_best_weekly', source: 'RSSHub-Douban-Variety', tags: ['variety'] },
    { route: '/weibo/search/hot', source: 'RSSHub-Weibo-Hot', tags: ['weibo', 'hot'] },
];

const RSSHUB_BASE_URL = (process.env.RSSHUB_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'http://127.0.0.1:1200').replace(/^([^:]+:\/\/)?/, (match) => match || 'https://').replace(/\/+$/, '');
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'outputs/rsshub/latest-hotspots.json';
const OUTPUT_REPO = process.env.OUTPUT_REPO || '';
const OUTPUT_BRANCH = process.env.OUTPUT_BRANCH || 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

function nowIso() {
    return new Date().toISOString();
}

function routeDefinitions() {
    const raw = process.env.RSSHUB_ROUTES_JSON || '';
    if (!raw.trim()) {
        return DEFAULT_ROUTES;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error('RSSHUB_ROUTES_JSON must be a JSON array');
    }
    return parsed
        .map((item) => ({
            route: String(item.route || '').trim(),
            source: String(item.source || item.source_name || item.route || 'RSSHub').trim(),
            tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        }))
        .filter((item) => item.route);
}

function stripHtml(value) {
    return String(value || '')
        .replaceAll(/<script[\s\S]*?<\/script>/gi, ' ')
        .replaceAll(/<style[\s\S]*?<\/style>/gi, ' ')
        .replaceAll(/<[^>]+>/g, ' ')
        .replaceAll(/\s+/g, ' ')
        .trim();
}

function itemUrl(item) {
    if (item.url) {
        return String(item.url);
    }
    if (item.external_url) {
        return String(item.external_url);
    }
    if (item.id && /^https?:\/\//i.test(String(item.id))) {
        return String(item.id);
    }
    return '';
}

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
        const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        const durationMs = Date.now() - startedAt;
        if (!response.ok) {
            let body = '';
            try {
                body = await response.text();
            } catch {
                body = '';
            }
            const error = new Error(`HTTP ${response.status} ${response.statusText}`);
            error.status = response.status;
            error.durationMs = durationMs;
            error.body = body.slice(0, 300);
            throw error;
        }
        return { payload: await response.json(), durationMs };
    } finally {
        clearTimeout(timer);
    }
}

async function fetchRoute(definition) {
    const fetchedAt = nowIso();
    const url = `${RSSHUB_BASE_URL}${definition.route}?format=json`;
    try {
        const { payload, durationMs } = await fetchJson(url);
        const feedItems = Array.isArray(payload.items) ? payload.items : [];
        if (!feedItems.length) {
            return {
                items: [],
                failure: {
                    type: 'route_failure',
                    route: definition.route,
                    url,
                    fetched_at: fetchedAt,
                    status: 'empty_items',
                    error_code: 'EMPTY_ITEMS',
                    message: 'RSSHub route returned no items',
                    duration_ms: durationMs,
                    retryable: true,
                },
            };
        }
        return {
            items: feedItems
                .map((item, index) => ({
                    source: definition.source,
                    source_role: 'primary_public',
                    route: definition.route,
                    rank: index + 1,
                    title: String(item.title || '').trim(),
                    url: itemUrl(item),
                    summary: stripHtml(item.summary || item.content_text || item.content_html || ''),
                    published_at: item.date_published || item.date_modified || fetchedAt,
                    hot_score: Math.max(1, 100 - index),
                    category: 'hotspot',
                    tags: definition.tags,
                    raw_payload: {
                        source_role: 'primary_public',
                        source_kind: 'railway_rsshub',
                        route: definition.route,
                        raw_id: item.id || '',
                        fetched_at: fetchedAt,
                        duration_ms: durationMs,
                        item,
                    },
                }))
                .filter((item) => item.title && item.url),
            failure: undefined,
        };
    } catch (error) {
        const aborted = error?.name === 'AbortError';
        return {
            items: [],
            failure: {
                type: 'route_failure',
                route: definition.route,
                url,
                fetched_at: fetchedAt,
                status: aborted ? 'failed_timeout' : error.status ? 'failed_http' : 'failed_parse',
                http_status: error.status || null,
                error_code: aborted ? 'TIMEOUT' : error.status ? 'HTTP_ERROR' : 'FETCH_OR_PARSE_ERROR',
                message: String(error.message || error),
                duration_ms: error.durationMs || REQUEST_TIMEOUT_MS,
                retryable: true,
            },
        };
    }
}

async function writeLocalJson(filePath, payload) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmp, filePath);
}

async function githubRequest(apiPath, init = {}) {
    const response = await fetch(`https://api.github.com${apiPath}`, {
        ...init,
        headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${GITHUB_TOKEN}`,
            'x-github-api-version': '2022-11-28',
            ...init.headers,
        },
    });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    }
    return response.json();
}

async function publishToGithub(payload) {
    if (!GITHUB_TOKEN || !OUTPUT_REPO) {
        return { status: 'skipped_not_configured' };
    }
    const contentPath = OUTPUT_PATH.replace(/^\/+/, '');
    const existing = await githubRequest(`/repos/${OUTPUT_REPO}/contents/${encodeURIComponent(contentPath).replaceAll('%2F', '/')}?ref=${OUTPUT_BRANCH}`);
    const body = {
        message: `Update RSSHub hotspots ${payload.finished_at}`,
        branch: OUTPUT_BRANCH,
        content: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8').toString('base64'),
        ...(existing?.sha ? { sha: existing.sha } : {}),
    };
    await githubRequest(`/repos/${OUTPUT_REPO}/contents/${encodeURIComponent(contentPath).replaceAll('%2F', '/')}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: 'success', repo: OUTPUT_REPO, path: contentPath, branch: OUTPUT_BRANCH };
}

async function main() {
    const definitions = routeDefinitions();
    const results = await Promise.all(definitions.map((definition) => fetchRoute(definition)));
    const items = results.flatMap((result) => result.items);
    const failures = results.map((result) => result.failure).filter(Boolean);
    const finishedAt = nowIso();
    const payload = {
        status: items.length && failures.length ? 'degraded_partial' : items.length ? 'success' : 'failed',
        source: 'Railway-RSSHub',
        source_role: 'primary_public',
        finished_at: finishedAt,
        routes: definitions.map((item) => item.route),
        items,
        failures,
    };
    await writeLocalJson(OUTPUT_PATH, payload);
    const publish = await publishToGithub(payload);
    process.stdout.write(`${JSON.stringify({ status: payload.status, items: items.length, failures: failures.length, output_path: OUTPUT_PATH, publish })}\n`);
    if (!items.length) {
        process.exitCode = 1;
    }
}

try {
    await main();
} catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'failed', message: String(error?.stack || error) })}\n`);
    process.exitCode = 1;
}
