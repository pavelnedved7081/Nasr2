/**
 * Minimal proxy for fetching aja.ir (Iranian Army news site) content server-side. aja.ir blocks
 * TCP connections from GitHub Actions' (Azure) IP ranges outright, so sync-rss.mjs can't reach it
 * directly from a GitHub Actions runner; Cloudflare's edge IPs are a different range that may not
 * be on the same blocklist. Routes requests through this Worker instead.
 *
 * GET /?url=<encoded target URL>
 *   - target host must be exactly www.aja.ir or aja.ir, or the request is rejected — this must
 *     never become a general-purpose open proxy.
 *   - if PROXY_SECRET is configured (via `wrangler secret put PROXY_SECRET`), the request must
 *     carry a matching `X-Proxy-Secret` header.
 *   - on success, returns the upstream response body as-is with its original content-type and
 *     permissive CORS headers.
 */
const ALLOWED_HOSTS = new Set(['www.aja.ir', 'aja.ir']);
const UPSTREAM_USER_AGENT = 'Nasr2DashboardBot/1.0 (+https://github.com/pavelnedved7081/Nasr2)';

function corsHeaders() {
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Proxy-Secret, Content-Type',
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    if (env.PROXY_SECRET) {
      if (request.headers.get('X-Proxy-Secret') !== env.PROXY_SECRET) {
        return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
      }
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return new Response('Missing "url" query parameter', { status: 400, headers: corsHeaders() });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response('Invalid "url" query parameter', { status: 400, headers: corsHeaders() });
    }

    if (
      !ALLOWED_HOSTS.has(targetUrl.hostname) ||
      (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:')
    ) {
      return new Response('Target host not allowed', { status: 403, headers: corsHeaders() });
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(targetUrl.toString(), {
        headers: { 'User-Agent': UPSTREAM_USER_AGENT },
      });
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err.message}`, { status: 502, headers: corsHeaders() });
    }

    const headers = corsHeaders();
    const contentType = upstreamRes.headers.get('content-type');
    if (contentType) headers.set('Content-Type', contentType);

    return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
  },
};
