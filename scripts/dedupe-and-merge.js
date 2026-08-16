/**
 * dedupe-and-merge.js
 *
 * Fixes two problems in the Opportunity Radar update script:
 *
 *  ISSUE 1 — Duplicate events: the same show gets scraped from multiple
 *  source pages under slightly different names ("Autumn Fair 2026",
 *  "Autumn Fair 2026 (incorporating Moda Fashion)") and ends up as 2-3
 *  separate calendar entries instead of one.
 *
 *  ISSUE 2 — Baseline events silently dropped: events from the original
 *  Excel handover (baseline-events.json) must always appear on the
 *  calendar, even in a month where the live scrape doesn't happen to
 *  re-find them. A scrape is additive/corrective, never a replacement
 *  for the baseline.
 *
 * Usage in your update script:
 *
 *   const { buildFinalEventList } = require('./dedupe-and-merge');
 *   const baseline = require('./baseline-events.json');
 *   const scraped = await scrapeAllSources();       // your existing scraper
 *   const finalEvents = buildFinalEventList(baseline, scraped);
 *   fs.writeFileSync('events.json', JSON.stringify(finalEvents, null, 2));
 */

// ---------- STEP 1: Normalize names for comparison ----------
function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')       // strip parenthetical suffixes: "(incorporating Moda Fashion)"
    .replace(/[^a-z0-9\s]/g, '')     // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- STEP 2: Cheap string-similarity check ----------
// Word-overlap ratio is enough here — we don't need a full edit-distance
// library for event names. Returns 0..1.
function similarity(a, b) {
  const wordsA = new Set(normalizeName(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.max(wordsA.size, wordsB.size);
}

const SIMILARITY_THRESHOLD = 0.6; // tune if you get false merges/misses

// ---------- STEP 3: Date-range overlap check ----------
// Two events can only be duplicates if their dates overlap. This also
// stops unrelated same-named annual fixtures (e.g. two different years
// of "INDX Home") from being wrongly merged.
function datesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !bStart) return false;
  return aStart <= (bEnd || bStart) && bStart <= (aEnd || aStart);
}

// ---------- STEP 4: Alias-aware matching against the baseline ----------
// Checks a scraped event against every baseline event's name AND its
// known aliases (e.g. "NBF Bed Industry Awards" is an alias of the
// baseline "The Bed Show" — this stops it becoming a fake new event).
function matchesBaselineEntry(scrapedEvent, baselineEntry, knownAliases) {
  if (!datesOverlap(scrapedEvent.dateStart, scrapedEvent.dateEnd, baselineEntry.dateStart, baselineEntry.dateEnd)) {
    return false;
  }
  const namesToCheck = [baselineEntry.name, ...(baselineEntry.aliases || [])];
  const extraAliases = knownAliases[baselineEntry.canonical_id] || [];
  namesToCheck.push(...extraAliases);

  return namesToCheck.some(candidateName => similarity(scrapedEvent.name, candidateName) >= SIMILARITY_THRESHOLD);
}

// ---------- STEP 5: Merge two records for the same event ----------
// Two different merge modes, because they answer different questions:
//
//  - In-scrape dedup (mode 'peer'): neither record is authoritative yet,
//    so "keep the longer/more complete name" is a reasonable heuristic.
//
//  - Baseline merge (mode 'baseline'): baseRecord IS the authoritative
//    canonical entry. A scraped alias match (e.g. "NBF Bed Industry
//    Awards" matching the "The Bed Show" baseline) confirms the show is
//    still running and can enrich its description/link — but must NEVER
//    overwrite the canonical name. Getting this backwards is exactly how
//    "The Bed Show" would silently get relabelled to a sub-event's name.
function mergeEventRecords(baseRecord, incomingRecord, mode = 'peer') {
  const longer = (a, b) => ((a || '').length >= (b || '').length ? a : b);
  return {
    ...baseRecord,
    name: mode === 'baseline' ? baseRecord.name : longer(baseRecord.name, incomingRecord.name),
    description: longer(baseRecord.description, incomingRecord.description),
    location: baseRecord.location || incomingRecord.location,
    dateStart: baseRecord.dateStart || incomingRecord.dateStart,
    dateEnd: baseRecord.dateEnd || incomingRecord.dateEnd,
    link: baseRecord.link || incomingRecord.link,
    sources: Array.from(new Set([...(baseRecord.sources || []), ...(incomingRecord.sources || [incomingRecord.source])].filter(Boolean))),
    lastVerified: incomingRecord.detected || baseRecord.lastVerified,
  };
}

// ---------- STEP 6: Deduplicate a raw scraped list against itself ----------
// Handles Issue 1 in isolation: collapses near-duplicate entries within
// one scrape run, BEFORE it's compared against the baseline at all.
function dedupeWithinScrape(scrapedEvents) {
  const buckets = []; // each bucket = array of events considered the same show

  for (const event of scrapedEvents) {
    let placed = false;
    for (const bucket of buckets) {
      const rep = bucket[0]; // representative event for the bucket
      if (
        datesOverlap(event.dateStart, event.dateEnd, rep.dateStart, rep.dateEnd) &&
        similarity(event.name, rep.name) >= SIMILARITY_THRESHOLD
      ) {
        bucket.push(event);
        placed = true;
        break;
      }
    }
    if (!placed) buckets.push([event]);
  }

  return buckets.map(bucket =>
    bucket.reduce((merged, e) => mergeEventRecords(merged, e), bucket[0])
  );
}

// ---------- STEP 7: Merge deduplicated scrape results into the baseline ----------
// This is the function that guarantees baseline events never silently
// disappear (Issue 2), while still updating them with fresher scraped
// details when a match is found, and folding in genuinely new finds.
function mergeIntoBaseline(baseline, dedupedScrapedEvents) {
  const knownAliases = baseline.known_aliases || {};
  const baselineEvents = baseline.baseline_events.filter(e => e.status !== 'superseded');
  const usedBaselineIds = new Set();
  const finalList = [];

  // Pass 1: for each baseline event, look for a matching scraped update.
  for (const baseEvent of baselineEvents) {
    const match = dedupedScrapedEvents.find(scraped =>
      matchesBaselineEntry(scraped, baseEvent, knownAliases)
    );
    if (match) {
      usedBaselineIds.add(baseEvent.canonical_id);
      finalList.push(mergeEventRecords(baseEvent, match, 'baseline'));
    } else {
      // No fresh match this run — KEEP the baseline entry as-is rather
      // than dropping it. Flag it so a human can see it wasn't
      // re-confirmed this cycle.
      finalList.push({ ...baseEvent, notReconfirmedThisRun: true });
    }
  }

  // Pass 2: anything scraped that didn't match ANY baseline event is a
  // genuine new discovery — append it, clearly marked for review.
  for (const scraped of dedupedScrapedEvents) {
    const alreadyUsed = baselineEvents.some(
      b => usedBaselineIds.has(b.canonical_id) && matchesBaselineEntry(scraped, b, knownAliases)
    );
    if (!alreadyUsed) {
      finalList.push({ ...scraped, canonical_id: scraped.canonical_id || null, newDiscovery: true });
    }
  }

  return finalList;
}

// ---------- Public entry point ----------
function buildFinalEventList(baseline, scrapedEvents) {
  const deduped = dedupeWithinScrape(scrapedEvents);
  return mergeIntoBaseline(baseline, deduped);
}

module.exports = {
  normalizeName,
  similarity,
  datesOverlap,
  dedupeWithinScrape,
  mergeIntoBaseline,
  buildFinalEventList,
};
