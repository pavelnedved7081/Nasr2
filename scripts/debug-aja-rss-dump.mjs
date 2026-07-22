#!/usr/bin/env node
/**
 * One-off diagnostic: dumps every item currently in the aja.ir (Artesh) RSS feed as structured
 * JSON (title/guid/pubDate/link), sorted oldest-to-newest, so a human can manually cross-reference
 * it against the 30 hand-curated Artesh events already in data/events.json (ids 62-91) — those came
 * from a Word doc, not the RSS pipeline, so they have no stored guid/link and aren't yet represented
 * in data/seen-guids.json. No filtering, no relevance check, no writes to any pipeline file.
 *
 * Reuses proxyFetch() from sync-rss.mjs (the only transport that can reach aja.ir from CI) rather
 * than reimplementing the fetch.
 *
 * Usage: node scripts/debug-aja-rss-dump.mjs [rssUrl] [outFile]
 */
import fs from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { proxyFetch } from './sync-rss.mjs';

const DEFAULT_RSS_URL = 'https://www.aja.ir/portal/rsspage/?fa-ir/news/45459/45608/اخبار';
const rssUrl = process.argv[2] || DEFAULT_RSS_URL;
const outFile = process.argv[3] || null;

function fieldText(field) {
  if (field && typeof field === 'object') return field['#text'] ?? field.__cdata ?? '';
  return field ?? '';
}

async function main() {
  console.log(`Fetching Artesh RSS via proxy: ${rssUrl}`);
  const xml = await proxyFetch(rssUrl, { timeoutMs: 20000 });
  console.log(`Fetched ${xml.length} chars of XML`);

  const parser = new XMLParser({ ignoreAttributes: false });
  const feed = parser.parse(xml);
  const rawItems = feed?.rss?.channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  console.log(`Parsed ${items.length} <item> entries`);

  const dumped = items.map((it) => ({
    title: fieldText(it.title),
    guid: fieldText(it.guid),
    pubDate: fieldText(it.pubDate),
    link: fieldText(it.link),
  }));

  dumped.sort((a, b) => {
    const da = new Date(a.pubDate).getTime();
    const db = new Date(b.pubDate).getTime();
    if (Number.isNaN(da) && Number.isNaN(db)) return 0;
    if (Number.isNaN(da)) return -1;
    if (Number.isNaN(db)) return 1;
    return da - db;
  });

  const json = JSON.stringify(dumped, null, 2);

  if (outFile) {
    await fs.writeFile(outFile, json + '\n');
    console.log(`Wrote ${dumped.length} items to ${outFile}`);
  }

  console.log('\n=== FULL FEED DUMP (oldest-to-newest by pubDate) ===');
  console.log(json);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
