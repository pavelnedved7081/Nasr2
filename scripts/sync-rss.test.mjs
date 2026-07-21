import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  jalaliToGregorian,
  isValidJalaliDateString,
  validateExtraction,
  processItems,
  main,
} from './sync-rss.mjs';

const LOCATIONS = {
  princeHassan: { name: 'پایگاه هوایی پرنس حسن', country: 'jordan', lat: 30.2833, lng: 36.0833 },
};

function validExtraction(overrides = {}) {
  return {
    wave: '1',
    force: 'aerospace',
    source: 'sepah',
    loc: 'princeHassan',
    loc_raw_text: null,
    target: 'پایگاه هوایی',
    weapon: 'موشک',
    outcome: 'اصابت مستقیم',
    code: 'C1',
    dateP: '۱۷ تیر ۱۴۰۵',
    time: '08:00',
    ...overrides,
  };
}

function rssItem(guid, title = 'اطلاعیه نصر ۲') {
  return { guid, link: `https://example.com/${guid}`, title, description: 'موج اول عملیات صاعقه' };
}

// --- isValidJalaliDateString / jalaliToGregorian ---

test('isValidJalaliDateString accepts a well-formed Jalali date', () => {
  assert.equal(isValidJalaliDateString('۱۷ تیر ۱۴۰۵'), true);
});

test('isValidJalaliDateString rejects "unknown"', () => {
  assert.equal(isValidJalaliDateString('unknown'), false);
});

test('isValidJalaliDateString rejects missing/empty/non-string values', () => {
  assert.equal(isValidJalaliDateString(''), false);
  assert.equal(isValidJalaliDateString(undefined), false);
  assert.equal(isValidJalaliDateString(null), false);
  assert.equal(isValidJalaliDateString(42), false);
});

test('isValidJalaliDateString rejects an unrecognized month name', () => {
  assert.equal(isValidJalaliDateString('۱۷ نامعتبر ۱۴۰۵'), false);
});

test('jalaliToGregorian still throws on unparseable input (internal invariant)', () => {
  assert.throws(() => jalaliToGregorian('unknown'));
});

// --- validateExtraction ---

test('validateExtraction rejects an otherwise-valid extraction with dateP "unknown"', () => {
  const { ok, errors } = validateExtraction(validExtraction({ dateP: 'unknown' }), LOCATIONS);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('unparseable date')));
});

test('validateExtraction accepts a fully valid extraction', () => {
  const { ok } = validateExtraction(validExtraction(), LOCATIONS);
  assert.equal(ok, true);
});

// --- processItems: the core regression test for this fix ---

test('processItems does not throw on an unparseable date and routes it to pending-review, while still processing the rest of the batch', async () => {
  const items = [
    rssItem('guid-bad-date'),
    rssItem('guid-good'),
  ];

  const extractionsByGuid = {
    'guid-bad-date': validExtraction({ dateP: 'unknown' }),
    'guid-good': validExtraction(),
  };

  const events = [];
  const pendingReview = [];
  const issuesOpened = [];

  await assert.doesNotReject(() =>
    processItems(items, {
      locations: LOCATIONS,
      events,
      pendingReview,
      seenSet: new Set(),
      systemPrompt: 'test',
      nextId: 1,
      extractEventFn: async (item) => extractionsByGuid[item.guid],
      openPendingReviewIssueFn: async (item, extraction, errors) => {
        issuesOpened.push({ guid: item.guid, errors });
      },
    })
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].dateP, '۱۷ تیر ۱۴۰۵');

  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].guid, 'guid-bad-date');
  assert.ok(pendingReview[0].errors.some((e) => e.includes('unparseable date')));

  assert.equal(issuesOpened.length, 1);
  assert.equal(issuesOpened[0].guid, 'guid-bad-date');
});

test('processItems isolates an unexpected throw from extraction to a single item', async () => {
  const items = [
    rssItem('guid-throws'),
    rssItem('guid-good'),
  ];

  const events = [];
  const pendingReview = [];

  await assert.doesNotReject(() =>
    processItems(items, {
      locations: LOCATIONS,
      events,
      pendingReview,
      seenSet: new Set(),
      systemPrompt: 'test',
      nextId: 1,
      extractEventFn: async (item) => {
        if (item.guid === 'guid-throws') throw new Error('network blew up');
        return validExtraction();
      },
      openPendingReviewIssueFn: async () => {},
    })
  );

  assert.equal(events.length, 1);
  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].guid, 'guid-throws');
  assert.ok(pendingReview[0].errors.some((e) => e.includes('network blew up')));
});

test('processItems isolates a throw from openPendingReviewIssueFn (e.g. GitHub API down) to a single item', async () => {
  const items = [
    rssItem('guid-issue-fails'),
    rssItem('guid-good'),
  ];
  const events = [];
  const pendingReview = [];

  await assert.doesNotReject(() =>
    processItems(items, {
      locations: LOCATIONS,
      events,
      pendingReview,
      seenSet: new Set(),
      systemPrompt: 'test',
      nextId: 1,
      extractEventFn: async (item) =>
        item.guid === 'guid-issue-fails' ? validExtraction({ dateP: 'unknown' }) : validExtraction(),
      openPendingReviewIssueFn: async (item) => {
        if (item.guid === 'guid-issue-fails') throw new Error('GitHub API unavailable');
      },
    })
  );

  assert.equal(events.length, 1);
  assert.ok(pendingReview.length >= 1);
  assert.ok(pendingReview.every((e) => e.guid === 'guid-issue-fails'));
});

// --- Full pipeline integration test (Phase 2 style: real fs read/write against a temp data dir) ---

test('main() end-to-end: unparseable date lands in pending-review.json on disk, valid item lands in events.json, run succeeds', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nasr2-sync-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(tmpDir, 'locations.json'), JSON.stringify(LOCATIONS));
  await fs.writeFile(path.join(tmpDir, 'events.json'), '[]');
  await fs.writeFile(path.join(tmpDir, 'seen-guids.json'), '[]');
  await fs.writeFile(path.join(tmpDir, 'pending-review.json'), '[]');

  const rssXml = `<?xml version="1.0"?>
<rss><channel>
  <item><guid>guid-bad-date</guid><link>https://example.com/1</link><title>اطلاعیه نصر ۲ یک</title><description>موج اول عملیات صاعقه</description></item>
  <item><guid>guid-good</guid><link>https://example.com/2</link><title>اطلاعیه نصر ۲ دو</title><description>موج دوم عملیات صاعقه</description></item>
</channel></rss>`;

  const extractionsByGuid = {
    'guid-bad-date': validExtraction({ dateP: 'unknown' }),
    'guid-good': validExtraction(),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('sepahnews.ir')) {
      return { ok: true, text: async () => rssXml };
    }
    if (String(url).includes('openrouter.ai')) {
      const body = JSON.parse(opts?.body ?? '{}');
      const userMsg = body.messages.find((m) => m.role === 'user').content;
      const guid = userMsg.includes('یک') ? 'guid-bad-date' : 'guid-good';
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(extractionsByGuid[guid]) } }],
        }),
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  try {
    await assert.doesNotReject(() => main({ dataDir: tmpDir }));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const pendingReview = JSON.parse(await fs.readFile(path.join(tmpDir, 'pending-review.json'), 'utf8'));
  const events = JSON.parse(await fs.readFile(path.join(tmpDir, 'events.json'), 'utf8'));

  assert.equal(pendingReview.length, 1);
  assert.equal(pendingReview[0].guid, 'guid-bad-date');

  assert.equal(events.length, 1);
  assert.equal(events[0].dateG, '2026-07-08');
});
