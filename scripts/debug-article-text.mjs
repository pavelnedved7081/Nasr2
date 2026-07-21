#!/usr/bin/env node
/**
 * Temporary debug script for investigating item news/36167's persistent "garbled output" failure
 * (see pending-review.json — it has failed on every retry across different router-selected
 * models, which points at the input text rather than model randomness).
 *
 * Fetches an article page via the same fetchArticleText() sync-rss.mjs uses for real, and prints
 * the exact `userContent` string that extractEvent() would send to the model, so it can be
 * inspected for contamination (bad tag-stripping, embedded widget text, etc.) before attempting
 * a fix. Delete this file once 36167 is diagnosed.
 *
 * Usage: node scripts/debug-article-text.mjs [link] [title]
 */
import { fetchArticleText } from './sync-rss.mjs';

const DEFAULT_LINK =
  'https://sepahnews.ir/fa/news/36167/سامانه-راداری-برد-بلند-و-چندین-فروند-هواپیمای-راهبردی-سوخت‌رسان-آمریکا-منهدم-گردید';
const DEFAULT_TITLE =
  'سامانه راداری برد بلند و چندین فروند هواپیمای راهبردی سوخت‌رسان آمریکا منهدم گردید';

const link = process.argv[2] || DEFAULT_LINK;
const title = process.argv[3] || DEFAULT_TITLE;

try {
  const articleText = await fetchArticleText(link);
  const userContent = `عنوان: ${title}\n\nمتن: ${articleText}`;

  console.log(`link: ${link}`);
  console.log(`fetched ${articleText.length} chars of cleaned article text (noise stripped)`);
  console.log('--- userContent that would be sent to the model (full) ---');
  console.log(userContent);
} catch (err) {
  console.error(`fetchArticleText failed for ${link}: ${err.message}`);
  process.exit(1);
}
