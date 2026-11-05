const {HttpError} = require("./errors");

const FIRST_SEASON = 2021;
const REGULAR_SEASON_WEEKS = 18;
const DAY_MS = 24 * 60 * 60 * 1000;

function easternParts(now = Date.now()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric"})
      .formatToParts(now)
      .map((x) => [x.type, x.value])
  );
  return {year: Number(p.year), month: Number(p.month), day: Number(p.day)};
}

// A season is named by the year it starts in; it runs through the Super Bowl in February, and the next one starts in March.
function currentSeason(now = Date.now()) {
  const {year, month} = easternParts(now);
  return month >= 3 ? year : year - 1;
}

// Week 1 starts on the Tuesday before the first Thursday after Labor Day (first Monday of September); weeks run Tuesday to Monday.
function currentWeek(season, now = Date.now()) {
  const labor = new Date(Date.UTC(season, 8, 1));
  while (labor.getUTCDay() !== 1) labor.setUTCDate(labor.getUTCDate() + 1);
  const week1Start = labor.getTime() + DAY_MS; // Tuesday after Labor Day
  const {year, month, day} = easternParts(now);
  const today = Date.UTC(year, month - 1, day);
  return Math.min(Math.max(Math.floor((today - week1Start) / (7 * DAY_MS)) + 1, 1), REGULAR_SEASON_WEEKS);
}

function parseSeason(value, now = Date.now()) {
  const current = currentSeason(now);
  if (value === undefined) return current;
  if (!/^\d{4}$/.test(String(value)) || Number(value) < FIRST_SEASON || Number(value) > current) {
    throw new HttpError(400, "invalid_season", `season must be a year from ${FIRST_SEASON} to ${current}`);
  }
  return Number(value);
}

function parseWeek(value, season, now = Date.now()) {
  if (value === undefined) return season === currentSeason(now) ? currentWeek(season, now) : 1;
  if (!/^\d{1,2}$/.test(String(value)) || Number(value) < 1 || Number(value) > REGULAR_SEASON_WEEKS) {
    throw new HttpError(400, "invalid_week", `week must be a number from 1 to ${REGULAR_SEASON_WEEKS}`);
  }
  return Number(value);
}

module.exports = {currentSeason, currentWeek, parseSeason, parseWeek, REGULAR_SEASON_WEEKS};
