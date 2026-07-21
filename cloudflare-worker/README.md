# aja.ir proxy Worker

`src/index.js` is a minimal Cloudflare Worker that fetches `aja.ir` pages
server-side and returns them as-is. It exists because aja.ir (the Iranian
Army news site) blocks TCP connections from GitHub Actions' (Azure) IP
ranges outright — confirmed via `scripts/debug-aja-rss.mjs`, which timed
out on every scheme/host variant tried, while the same URL loads fine from
a normal residential network. Cloudflare's edge IPs are a different range
that may not be on the same blocklist, so `sync-rss.mjs` can route its
aja.ir requests through this Worker instead of fetching aja.ir directly.

**This is Phase 1: the Worker exists and can be deployed/tested standalone,
but nothing in the sync pipeline calls it yet.** `sync-rss.mjs` is
unchanged. Once the Worker is deployed and confirmed to actually get past
aja.ir's block (tested from GitHub Actions), a follow-up change will wire
`sync-rss.mjs`'s aja.ir requests through it.

It only proxies requests whose target host is exactly `www.aja.ir` or
`aja.ir` — anything else gets a 403, so this can't become a general-purpose
open proxy. An optional shared-secret header adds basic access control.

## What it does

`GET https://<your-worker>/?url=<url-encoded target URL>`

- Rejects the request (403) unless the target URL's host is exactly
  `www.aja.ir` or `aja.ir`.
- If a `PROXY_SECRET` is configured (see below), requires a matching
  `X-Proxy-Secret` request header, or responds 401.
- Fetches the target URL server-side (with a `Nasr2DashboardBot/1.0`
  User-Agent) and returns the upstream response body unchanged, with the
  upstream's `Content-Type` and permissive CORS headers
  (`Access-Control-Allow-Origin: *`).
- Returns 502 if the upstream fetch itself fails.

There's no request-count rate limiting in the Worker code — Cloudflare's
free tier doesn't give a Worker script an easy, reliable way to do that
(it would need Durable Objects or KV, which is more infrastructure than
this needs right now). The shared-secret header is the abuse guard: without
it, anyone who finds the Worker URL could use your Workers quota to fetch
aja.ir pages (not sensitive data, but still your quota). If you want actual
rate limiting later, Cloudflare's dashboard has WAF rate limiting rules
that can be attached to the Worker's route without touching this code.

## Deploying (manual — do this yourself)

Claude Code doesn't have Cloudflare account access, so these steps need to
be run by hand.

1. Install Wrangler if you don't have it:
   ```sh
   npm install -g wrangler
   ```
2. Log in (opens a browser to authorize):
   ```sh
   wrangler login
   ```
3. (Recommended) Set a shared secret so the Worker isn't a fully open
   endpoint. Pick any random string:
   ```sh
   cd cloudflare-worker
   wrangler secret put PROXY_SECRET
   # paste/type your chosen secret when prompted
   ```
   If you skip this step, the Worker runs without the header check (fine
   for a quick test, not recommended to leave that way long-term).
4. Deploy:
   ```sh
   wrangler deploy
   ```
   Wrangler prints the live URL on success, typically
   `https://aja-proxy.<your-account-subdomain>.workers.dev`.

   Alternatively, if you'd rather not install Wrangler locally: open the
   Cloudflare dashboard → Workers & Pages → Create → paste the contents of
   `src/index.js` into the online editor → Deploy. You can add the
   `PROXY_SECRET` under the Worker's Settings → Variables and Secrets tab
   in that case instead of step 3.

5. Note the resulting Worker URL — it's needed for the Phase 1 test
   dispatch (fetching aja.ir through it from GitHub Actions) and later for
   wiring it into `sync-rss.mjs`.

### Optional: custom domain route

Since `nasrdashboard.com` is already on Cloudflare, you can put the Worker
on a subdomain of it instead of the default `workers.dev` URL: in the
dashboard, open the deployed Worker → **Settings → Domains & Routes → Add
→ Custom Domain**, e.g. `aja-proxy.nasrdashboard.com`. This is optional —
the `workers.dev` URL works fine too.

## Testing after deployment

```sh
curl "https://<your-worker-url>/?url=https%3A%2F%2Fwww.aja.ir%2F" \
  -H "X-Proxy-Secret: <your-secret>"
```
(Omit the `-H` flag if you didn't set `PROXY_SECRET`.) This should return
aja.ir's homepage HTML. If it does, the Worker is reachable and correctly
proxying; the real test — whether Cloudflare's IPs actually get past
aja.ir's block where GitHub Actions' didn't — happens next, by dispatching
a GitHub Actions run that fetches the RSS feed through this URL instead of
directly.

## Local development

```sh
cd cloudflare-worker
wrangler dev
```
Runs the Worker locally (Wrangler prints a local URL, e.g.
`http://localhost:8787`) for iterating on `src/index.js` without
redeploying each time. Note this only helps with the Worker's own
logic (routing, validation, secret check) — it doesn't tell you whether
Cloudflare's *deployed* edge IPs get past aja.ir's block, since local dev
traffic doesn't originate from Cloudflare's network.
