const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const LIVE_MS = 2 * MINUTE_MS; // a game is in progress, scores change
const LATE_START_MS = 5 * MINUTE_MS; // kickoff time passed but the game isn't live yet
const MAX_MS = HOUR_MS; // before kickoff and after the last game: re-check for time changes and for the next week taking over

// How long the current-week schedule stays fresh, from the states of its games ({state, start} with start as ms timestamp).
function currentWeekTtlMs(games, now = Date.now()) {
  if (games.some((g) => g.state === "in")) return LIVE_MS;
  const upcoming = games.filter((g) => g.state !== "post");
  const starts = upcoming.map((g) => g.start).filter(Number.isFinite);
  if (starts.length === 0) return MAX_MS;
  const untilKickoff = Math.min(...starts) - now;
  if (untilKickoff <= 0) return LATE_START_MS;
  return Math.min(Math.max(untilKickoff, MINUTE_MS), MAX_MS);
}

module.exports = {currentWeekTtlMs};
