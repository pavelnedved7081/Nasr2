#!/usr/bin/env node
/**
 * Temporary debug script for Phase 1 of the aja.ir (Artesh / Iranian Army) RSS investigation —
 * see the task description for adding aja.ir as a second sync-rss.mjs source alongside
 * sepahnews.ir. Prints raw findings only (feed XML, article HTML/text landmarks) for a human to
 * inspect before any extraction code is written, the same way debug-article-text.mjs did for the
 * sepahnews.ir 36167 investigation. Delete this file once aja.ir extraction is implemented and
 * confirmed working (Phase 2).
 *
 * Usage: node scripts/debug-aja-rss.mjs [rssUrl]
 */
import { fetchArticleHtml } from './sync-rss.mjs';
import { XMLParser } from 'fast-xml-parser';

const DEFAULT_RSS_URL = 'https://www.aja.ir/portal/rsspage/?fa-ir/news/45459/45608/اخبار';
const rssUrl = process.argv[2] || DEFAULT_RSS_URL;
const USER_AGENT = 'Nasr2DashboardBot/1.0 (+https://github.com/pavelnedved7081/Nasr2)';

// Phrasing similar to existing Artesh events already in data/events.json — used only to pick
// interesting sample links out of the feed, not assumed to match sepahnews.ir's landmarks.
const ACTION_KEYWORDS = ['صاعقه', 'مرحله', 'منهدم', 'پهپاد'];
const SAMPLE_COUNT = 3;

// Hypotheses to check against actual fetched text, not assumed true.
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
];
const CONTAINER_RE =
  /<(div|section|article)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:content|body|matn|متن|article|story|news[-_]?text|desc)[^"']*["'][^>]*>/gi;

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

async function main() {
  console.log(`Fetching RSS: ${rssUrl}`);
  const res = await fetch(rssUrl, { headers: { 'User-Agent': USER_AGENT } });
  console.log(`RSS fetch status: ${res.status}`);
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();

  console.log(`\n=== Raw XML length: ${xml.length} chars ===`);

  // Pull raw <item>...</item> blocks straight out of the XML text (not the parsed object), so
  // field formatting (CDATA, entity encoding, attribute order) is shown exactly as the feed sends
  // it, with no normalization from the parser.
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  console.log(`\n=== Total <item> count (raw regex match on XML text): ${itemBlocks.length} ===`);

  if (itemBlocks.length > 0) {
    console.log('\n=== Full sample raw <item> block (first item, byte-for-byte as it appears) ===');
    console.log(itemBlocks[0]);
  }

  const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: '__cdata' });
  const feed = parser.parse(xml);
  const channel = feed?.rss?.channel;
  console.log('\n=== Parsed channel-level fields (title/link/description) ===');
  console.log(
    JSON.stringify(
      { title: fieldText(channel?.title), link: fieldText(channel?.link), description: fieldText(channel?.description) },
      null,
      2
    )
  );

  const rawItems = channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  console.log(`\n=== Total <item> count (parsed): ${items.length} ===`);

  if (items.length > 0) {
    console.log('\n=== Parsed first item (all fields, as the XML parser sees them) ===');
    console.log(JSON.stringify(items[0], null, 2));
  }

  console.log(`\n=== Searching for items matching action keywords: ${ACTION_KEYWORDS.join(', ')} ===`);
  const matches = items.filter((it) => {
    const title = fieldText(it.title);
    return ACTION_KEYWORDS.some((kw) => title.includes(kw));
  });
  console.log(`Found ${matches.length} matching items:`);
  for (const it of matches) {
    console.log(`  - [${fieldText(it.pubDate)}] ${fieldText(it.title)} -> ${fieldText(it.link)}`);
  }

  const samples = matches.slice(0, SAMPLE_COUNT);
  if (samples.length === 0) {
    console.log('\nNo keyword matches found; falling back to the first 3 items in the feed as samples.');
    samples.push(...items.slice(0, SAMPLE_COUNT));
  }

  for (const [idx, it] of samples.entries()) {
    const title = fieldText(it.title);
    const link = fieldText(it.link);
    const guid = fieldText(it.guid);
    console.log(`\n\n########## SAMPLE ${idx + 1} ##########`);
    console.log(`title: ${title}`);
    console.log(`link: ${link}`);
    console.log(`guid: ${guid}`);
    console.log(`pubDate (raw): ${fieldText(it.pubDate)}`);
    console.log(`description (raw): ${fieldText(it.description)}`);

    console.log('\n--- Numeric groups found in link (candidate news codes) ---');
    console.log(JSON.stringify(link.match(/\d+/g) || []));

    let html;
    try {
      html = await fetchArticleHtml(link, { timeoutMs: 15000 });
    } catch (err) {
      console.error(`Failed to fetch article HTML: ${err.message}`);
      continue;
    }
    console.log(`\nFetched article HTML: ${html.length} chars`);

    console.log('\n--- Candidate content-container elements found in raw HTML ---');
    const containerMatches = [...html.matchAll(CONTAINER_RE)].map((m) => m[0]);
    console.log(containerMatches.length ? containerMatches.join('\n') : '(none found)');

    console.log('\n--- <meta>/<time> pubDate candidates in raw HTML ---');
    const metaTags = html.match(/<meta\b[^>]*(?:property|name)\s*=\s*["'][^"']*(?:date|time)[^"']*["'][^>]*>/gi) || [];
    console.log(metaTags.length ? metaTags.join('\n') : '(no matching <meta> tags found)');
    const timeTags = html.match(/<time\b[^>]*>[\s\S]*?<\/time>/gi) || [];
    console.log(timeTags.length ? timeTags.join('\n') : '(no <time> elements found)');

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

    console.log('\n--- Full stripped text (for manual landmark inspection) ---');
    console.log(stripped);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
