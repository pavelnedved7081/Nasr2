#!/usr/bin/env node
/**
 * Phase 1 investigation for aja.ir (Artesh) article page structure, fetched through the Iranian
 * VPS proxy (GET <proxyBaseUrl>/?url=<encoded target>, header X-Proxy-Secret) since aja.ir is
 * unreachable directly from GitHub Actions. Prints raw findings only (container candidates,
 * landmark searches, GUID occurrences, full stripped text) for a human to inspect before any
 * extraction code is written — same approach as debug-article-text.mjs / debug-aja-rss.mjs.
 * Delete this file once aja.ir article extraction is implemented and confirmed working (Phase 2).
 *
 * Usage: node scripts/debug-aja-article-structure.mjs <proxySecret> [proxyBaseUrl] [rssUrl]
 */
const [proxySecret, proxyBaseUrlArg, rssUrlArg] = process.argv.slice(2);
if (!proxySecret) {
  console.error('Usage: node scripts/debug-aja-article-structure.mjs <proxySecret> [proxyBaseUrl] [rssUrl]');
  process.exit(1);
}
const PROXY_BASE = (proxyBaseUrlArg || 'http://109.122.250.213:8787').replace(/\/$/, '');
const RSS_URL = rssUrlArg || 'https://www.aja.ir/portal/rsspage/?fa-ir/news/45459/45608/اخبار';

// The confirmed sample article given directly in the task.
const CONFIRMED_SAMPLE = {
  title: 'سه پایگاه مهم آمریکا در کویت، هدف حملات پهپادهای انهدامی ارتش قرار گرفت',
  link:
    'https://www.aja.ir//Home/ShowPage.aspx?Object=news&CategoryID=9ce0ffff-6667-4cc8-8cc7-7d8be06f03e4&LayoutID=6341690b-b7bb-4b01-be11-a64bd748a77a&ID=c9d90bbb-c976-4da3-8e98-2ce3f9e3018a',
  guid: 'c9d90bbb-c976-4da3-8e98-2ce3f9e3018a',
};

// Used only to locate 1-2 additional cross-check samples ("HIMARS" / "دو پایگاه") out of the live
// feed — not assumed to match sepahnews.ir's landmarks.
const CROSSCHECK_KEYWORDS = ['هایمارس', 'هیمارس', 'HIMARS', 'دو پایگاه'];

const OPENING_CANDIDATES = [
  'روابط عمومی ارتش جمهوری اسلامی ایران',
  'روابط عمومی ارتش',
  'ستاد کل نیروهای مسلح',
];
const CLOSING_CANDIDATES = [
  'اشتراک گذاری',
  'اشتراک‌گذاری',
  'برچسب ها',
  'برچسب‌ها',
  'اخبار مرتبط',
  'ارسال دیدگاه',
  'نظر خود را بنویسید',
  'دیدگاه کاربران',
  'اخبار مشابه',
];
const CONTAINER_RE =
  /<(div|section|article)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:content|body|matn|متن|article|story|news[-_]?text|desc|PageContent|MainContent)[^"']*["'][^>]*>/gi;

function stripHtmlGeneric(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function findAll(text, needle) {
  const idxs = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i === -1) break;
    idxs.push(i);
    from = i + needle.length;
  }
  return idxs;
}

function fieldText(field) {
  if (field && typeof field === 'object') return field['#text'] ?? field.__cdata ?? '';
  return field ?? '';
}

async function fetchViaProxy(targetUrl, { timeoutMs = 20000 } = {}) {
  const proxiedUrl = `${PROXY_BASE}/?url=${encodeURIComponent(targetUrl)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(proxiedUrl, {
      headers: { 'X-Proxy-Secret': proxySecret },
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get('content-type'), text };
  } finally {
    clearTimeout(timer);
  }
}

async function findCrossCheckSamples() {
  console.log(`\nFetching RSS via proxy to locate cross-check samples: ${RSS_URL}`);
  let xml;
  try {
    const { status, text } = await fetchViaProxy(RSS_URL);
    console.log(`RSS proxy fetch status: ${status}, length: ${text.length} chars`);
    xml = text;
  } catch (err) {
    console.error(`RSS proxy fetch failed: ${err.message}`);
    return [];
  }

  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: '__cdata' });
  const feed = parser.parse(xml);
  const rawItems = feed?.rss?.channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  console.log(`Parsed ${items.length} feed items`);

  const matches = items.filter((it) => {
    const title = fieldText(it.title);
    return CROSSCHECK_KEYWORDS.some((kw) => title.includes(kw));
  });
  console.log(`Found ${matches.length} cross-check keyword matches:`);
  for (const it of matches) {
    console.log(`  - ${fieldText(it.title)} -> ${fieldText(it.link)}`);
  }

  return matches.slice(0, 2).map((it) => ({
    title: fieldText(it.title),
    link: fieldText(it.link),
    guid: fieldText(it.guid),
  }));
}

async function analyzeSample(sample, idx) {
  console.log(`\n\n########## SAMPLE ${idx + 1} ##########`);
  console.log(`title: ${sample.title}`);
  console.log(`link: ${sample.link}`);
  console.log(`guid: ${sample.guid}`);

  let html;
  try {
    const { status, contentType, text } = await fetchViaProxy(sample.link);
    console.log(`\nProxy fetch status: ${status}, content-type: ${contentType}, length: ${text.length} chars`);
    html = text;
  } catch (err) {
    console.error(`Failed to fetch article HTML via proxy: ${err.message}`);
    return;
  }

  console.log('\n--- Candidate content-container elements found in raw HTML ---');
  const containerMatches = [...html.matchAll(CONTAINER_RE)].map((m) => m[0]);
  console.log(containerMatches.length ? containerMatches.join('\n') : '(none found)');

  console.log('\n--- <meta>/<time> pubDate candidates in raw HTML ---');
  const metaTags = html.match(/<meta\b[^>]*(?:property|name)\s*=\s*["'][^"']*(?:date|time)[^"']*["'][^>]*>/gi) || [];
  console.log(metaTags.length ? metaTags.join('\n') : '(no matching <meta> tags found)');

  console.log(`\n--- GUID "${sample.guid}" occurrences in raw HTML ---`);
  const guidIdxs = sample.guid ? findAll(html, sample.guid) : [];
  console.log(`found ${guidIdxs.length} occurrence(s) at [${guidIdxs.join(', ')}]`);
  for (const i of guidIdxs) {
    console.log(`  context: ...${html.slice(Math.max(0, i - 80), i + sample.guid.length + 80).replace(/\s+/g, ' ')}...`);
  }

  const stripped = stripHtmlGeneric(html);
  console.log(`\n--- Generic tag-stripped text: ${stripped.length} chars ---`);

  console.log('\n--- Opening-phrase landmark search (hypotheses, not assumptions) ---');
  for (const phrase of OPENING_CANDIDATES) {
    const idxs = findAll(stripped, phrase);
    console.log(`  "${phrase}": ${idxs.length ? `found at [${idxs.join(', ')}]` : 'not found'}`);
  }

  console.log('\n--- Closing/noise landmark search ---');
  for (const phrase of CLOSING_CANDIDATES) {
    const idxs = findAll(stripped, phrase);
    console.log(`  "${phrase}": ${idxs.length ? `found at [${idxs.join(', ')}]` : 'not found'}`);
  }

  console.log('\n--- Full raw HTML (for manual container/class inspection) ---');
  console.log(html);

  console.log('\n--- Full stripped text (for manual landmark inspection) ---');
  console.log(stripped);
}

async function main() {
  const crossCheckSamples = await findCrossCheckSamples();
  const samples = [CONFIRMED_SAMPLE, ...crossCheckSamples];

  for (const [idx, sample] of samples.entries()) {
    await analyzeSample(sample, idx);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
