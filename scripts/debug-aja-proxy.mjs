#!/usr/bin/env node
/**
 * Verifies the aja.ir Cloudflare Worker proxy (cloudflare-worker/src/index.js) actually gets past
 * aja.ir's block on GitHub Actions' IP range, by fetching an aja.ir URL through the deployed
 * Worker from a GitHub Actions runner and reporting status/content-type/body sample. Delete once
 * the Worker approach is confirmed and wired into sync-rss.mjs.
 *
 * Usage: node scripts/debug-aja-proxy.mjs <workerUrl> <targetUrl> <proxySecret>
 */
const [workerUrl, targetUrl, proxySecret] = process.argv.slice(2);
if (!workerUrl || !targetUrl || !proxySecret) {
  console.error('Usage: node scripts/debug-aja-proxy.mjs <workerUrl> <targetUrl> <proxySecret>');
  process.exit(1);
}

const proxiedUrl = `${workerUrl.replace(/\/$/, '')}/?url=${encodeURIComponent(targetUrl)}`;
console.log(`Target URL: ${targetUrl}`);
console.log(`Fetching via proxy: ${proxiedUrl}`);

try {
  const res = await fetch(proxiedUrl, { headers: { 'X-Proxy-Secret': proxySecret } });
  console.log(`\nHTTP status: ${res.status}`);
  console.log(`content-type: ${res.headers.get('content-type')}`);

  const text = await res.text();
  console.log(`Body length: ${text.length} chars`);
  console.log('\n--- First ~1000 chars of response body ---');
  console.log(text.slice(0, 1000));
} catch (err) {
  console.error(`Proxy fetch failed: ${err.message}`);
  process.exit(1);
}
