const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const AFTER_GAME_MS = 5 * HOUR_MS; // an NFL game lasts about 3.5h, the extra time lets upstream publish the result
const MIN_REFRESH_MS = 30 * MINUTE_MS;

// How long a page that depends on upcoming games stays fresh: until AFTER_GAME_MS past the earliest
// upcoming kickoff in `starts` (ms timestamps), at most capMs.
function untilAfterNextGameMs(starts, capMs, now = Date.now()) {
  const ends = starts.filter(Number.isFinite).map((s) => s + AFTER_GAME_MS).filter((e) => e > now);
  if (ends.length === 0) return capMs;
  return Math.min(Math.max(Math.min(...ends) - now, MIN_REFRESH_MS), capMs);
}

module.exports = {untilAfterNextGameMs};
