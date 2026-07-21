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
import { fetchArticleText, fetchArticleHtml } from './sync-rss.mjs';

const DEFAULT_LINK =
  'https://sepahnews.ir/fa/news/36167/سامانه-راداری-برد-بلند-و-چندین-فروند-هواپیمای-راهبردی-سوخت‌رسان-آمریکا-منهدم-گردید';
const DEFAULT_TITLE =
  'سامانه راداری برد بلند و چندین فروند هواپیمای راهبردی سوخت‌رسان آمریکا منهدم گردید';

const link = process.argv[2] || DEFAULT_LINK;
const title = process.argv[3] || DEFAULT_TITLE;

try {
  const html = await fetchArticleHtml(link);
  console.log(`link: ${link}`);
  console.log(`fetched ${html.length} chars of raw HTML`);

  // Look for candidate container elements that might hold ONLY the real article body
  // (as opposed to the sidebar/related-headlines widget), to see whether a structural
  // fix (parse HTML, extract one container) is possible instead of a text-landmark hack.
  console.log('--- candidate container elements (id/class matching body/content/news/matn/post/text) ---');
  const containerRe = /<(div|section|article)\b[^>]*\b(?:class|id)\s*=\s*["']([^"']*)["'][^>]*>/gi;
  const keywords = /body|content|matn|متن|news-text|post-content|article-body|single|detail/i;
  let m;
  let count = 0;
  while ((m = containerRe.exec(html)) && count < 40) {
    if (keywords.test(m[2])) {
      console.log(m[0]);
      count += 1;
    }
  }
  if (count === 0) console.log('(none found)');

  const articleText = await fetchArticleText(link);
  const userContent = `عنوان: ${title}\n\nمتن: ${articleText}`;

  console.log(`fetched ${articleText.length} chars of stripped article text`);
  console.log('--- userContent that would be sent to the model (full) ---');
  console.log(userContent);
} catch (err) {
  console.error(`fetchArticleText failed for ${link}: ${err.message}`);
  process.exit(1);
}
