# Sepah News RSS sync

`sync-rss.mjs` keeps `/data/events.json` up to date automatically by watching
the official Sepah News RSS feed for new statements about Operation Nasr 2 /
Sa'eqeh.

## What it does

1. Fetches `https://sepahnews.ir/fa/rss/allnews` with a clearly identifying
   User-Agent (`Nasr2DashboardBot/1.0`).
2. Skips any item already recorded in `/data/seen-guids.json`.
3. Filters the rest by keyword relevance: a broad keyword (اطلاعیه، نصر ۲،
   نصر۲، صاعقه، موج، پایگاه، کد خبر) **and** a military-action keyword
   (منهدم، تخریب، اصابت، حمله، ضربه، انهدام، سرنگون، شلیک، منفجر، etc.) must
   both be present — a broad-keyword-only match (an administrative notice
   about fake/impersonation pages, a political speech, etc.) doesn't
   qualify. Irrelevant items are marked seen and otherwise ignored. If an
   item previously stuck in `pending-review.json` is reclassified as
   irrelevant on a retry, it's removed from pending-review (and its Issue
   closed) instead of being left there indefinitely.
4. For each relevant item, derives the fields the RSS `<description>` is too
   terse to give a model reliably, instead of asking the model to guess them:
   - `dateG` comes straight from the item's `<pubDate>` (RFC 822), and `dateP`
     (Persian display date) is derived from `dateG` using the same
     Tir-1-1405 = 2026-06-22 epoch the rest of the project uses (the inverse
     of the Gregorian-to-Jalali conversion). If `<pubDate>` is missing or
     unparseable, the item goes straight to pending-review.
   - `code` is parsed directly out of the item's `<link>` URL (pattern
     `/news/(\d+)/`).
   - The full article page (the `<link>` URL) is fetched and its main text
     content extracted (HTML stripped), and that full text — not just the
     short RSS `<description>` — is what's passed to the model, so it can
     recover wave/phase numbers and fuller target/weapon/outcome detail. If
     the page fetch fails or times out, the item goes to pending-review
     instead of crashing the run.
5. Asks an LLM (via [OpenRouter](https://openrouter.ai), model
   `openrouter/free`, structured JSON-schema output) to extract only what it
   can reliably read from the article text — wave, force, source, location,
   target, weapon, outcome, time — using the location ids in
   `/data/locations.json` as the only valid set. If the model can't confidently
   match a known location, it returns `loc: null` plus `loc_raw_text` instead
   of guessing. The model's raw JSON response is parsed tolerantly: a
   ` ```json ` code fence or leading/trailing prose around the object is
   stripped/extracted before parsing (`parseModelJson`); only a response with
   no recoverable JSON object at all counts as a genuine extraction failure.
6. Resolves `loc`/`loc_raw_text` against the gazetteer with a
   normalization/fuzzy-match layer (`resolveLocation`) before validating:
   diacritics, zero-width characters (ZWNJ-vs-space), and letter variants are
   normalized on both sides; a small typo in `loc` (edit distance ≤ 2) or a
   `loc_raw_text` that contains a known location's name (its distinctive part,
   generic words like "پایگاه"/"هوایی" aside) as a substring is accepted; a
   country name/id (or a close typo of one) mistakenly put in `loc` resolves
   to `loc: null` plus the matched country (`loc_country_match`) rather than a
   crash or a false location match. Anything still unresolved keeps the
   fuzzy-match candidates considered (id + edit distance) on the
   pending-review entry (`loc_candidates`) for a human reviewer.
7. Validates every extraction: non-empty required fields (`wave` is exempt —
   many real statements don't mention one, and a missing/empty `wave`
   defaults to `"—"`, matching the convention already used in
   `events.json`), valid force/source, `loc` must exist in `locations.json`
   (after the fuzzy resolution above), the independently-derived
   `dateG`/`dateP`/`code`, and a lightweight sanity check on the combined
   target/weapon/outcome text that flags likely-corrupted model output
   (Hebrew-range or other out-of-place script characters, or a single "word"
   mixing Persian/Arabic and Latin letters with no separator). Anything that
   validates cleanly is appended to `/data/events.json` with a new sequential
   id. `target`/`weapon`/`outcome` are stored as `{fa, en: "", ar: ""}` —
   EN/AR translation for bot-added events is still a manual follow-up.
8. Anything that fails validation, or has no resolvable location, is appended
   to `/data/pending-review.json` (with the raw item title/link and the
   model's partial extraction) instead of `events.json`, and a GitHub Issue
   titled `Pending review: <item title>` labeled `needs-review` is opened so
   a human can place it by hand. The issue number is stored on the pending
   entry (`issue_number`) so later runs can find it.
9. Recomputes `/data/meta.json` (date ranges + `last_synced`) whenever new
   events were added.
10. Updates `/data/seen-guids.json` only with items that were **fully
   resolved** this run — added to `events.json`, or confidently classified
   irrelevant by the keyword filter. Items routed to `pending-review.json`
   are deliberately *not* marked seen, so they're retried from scratch on
   every subsequent run until they validate or a human resolves them by
   hand. An item already present in `pending-review.json` from an earlier
   run is matched by guid: if it fails again, its entry is refreshed in
   place (no second Issue is opened); if it now succeeds, it's moved into
   `events.json`, its guid is added to `seen-guids.json`, and its Issue is
   closed with a "Resolved automatically on retry." comment.

## Schedule

Runs via `.github/workflows/sync-sepahnews.yml` every 6 hours
(`0 */6 * * *`), plus on-demand via the "Run workflow" button
(`workflow_dispatch`) in the Actions tab.

## Required secret

The workflow needs an OpenRouter API key in **Settings → Secrets and
variables → Actions → New repository secret**, named `OPENROUTER_API_KEY`.
This script cannot create that secret itself — add it manually before the
first scheduled run (or the run will fail on the OpenRouter request and
nothing will be committed).

`GITHUB_TOKEN` (used for committing and opening review issues) is provided
automatically by GitHub Actions — no setup needed, but the workflow does
need `permissions: contents: write, issues: write`, which is already set in
the workflow file.

## Manual review flow

When an item lands in `data/pending-review.json` (and its matching GitHub
Issue), the bot leaves it alone — it never guesses a location or invents
coordinates. To resolve one:

1. Open the corresponding `needs-review` issue and read the raw RSS text
   plus the model's partial extraction.
2. Decide the correct `loc` id from `data/locations.json` (add a new
   location entry first if the target genuinely doesn't have one yet).
3. Move the entry from `data/pending-review.json` into `data/events.json`
   by hand, giving it the next sequential `id`, filling in `dateG` (Tir-1-1405
   = 2026-06-22 epoch, same as the sync script), and wrapping
   `target`/`weapon`/`outcome` as `{fa, en, ar}` objects — or ask a future
   Claude Code session to draft that edit for you once you've picked the
   location.
4. Remove the entry from `data/pending-review.json` and close the issue.

## Local testing

```sh
npm ci
OPENROUTER_API_KEY=... node scripts/sync-rss.mjs
```

Network access to `sepahnews.ir` and `openrouter.ai` is required; there is
no offline/dry-run mode.
