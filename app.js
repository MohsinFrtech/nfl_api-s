const express = require("express");
const {cached} = require("./lib/cached");
const {fetchTeams, fetchNews, fetchInjuries, fetchTeamInfo, fetchRoster, fetchWeeklySchedule, fetchDailySchedule, fetchPlayerSplits, fetchPlayerOverview, fetchTeamSchedule, fetchGameSummary, fetchStandings, fetchTeamStatistics} = require("./lib/nflClient");
const {untilAfterNextGameMs} = require("./lib/gameTtl");
const {currentWeekTtlMs} = require("./lib/scheduleTtl");
const {currentSeason, parseSeason, parseWeek} = require("./lib/season");
const {HttpError} = require("./lib/errors");
const {parsePagination, paginate} = require("./lib/paginate");
const {rateLimit} = require("./lib/rateLimit");

const app = express();
app.disable("x-powered-by"); // don't advertise the framework in every response
app.use(express.json());
app.use("/api", rateLimit); // before any cache or upstream work, so blocked clients cost nothing

const HOUR_MS = 60 * 60 * 1000;
const TEAMS_TTL_MS = 7 * 24 * HOUR_MS; // team list only changes between seasons
// Team pages change after each of the team's games, so they expire 5h after the next kickoff (see untilAfterNextGameMs).
const TEAM_INFO_MAX_TTL_MS = 48 * HOUR_MS;
const INJURIES_TTL_MS = 12 * HOUR_MS; // practice reports and game-day statuses change during the week
const ROSTER_TTL_MS = 48 * HOUR_MS; // rosters change with trades, signings and cuts
const WEEKLY_SCHEDULE_TTL_MS = 12 * HOUR_MS; // week overview only; live scores come from the daily schedule
// Player pages change after each of the team's games, so they expire 5h after the next kickoff (see untilAfterNextGameMs).
const PLAYER_OVERVIEW_MAX_TTL_MS = 48 * HOUR_MS;
const TEAM_SCHEDULE_MAX_TTL_MS = 24 * HOUR_MS; // expires 5h after the next kickoff, see untilAfterNextGameMs
const PAST_SCHEDULE_TTL_MS = 365 * 24 * HOUR_MS; // finished seasons never change
// Game summary by state: live scores change, a finished game never does.
const GAME_LIVE_TTL_MS = 5 * 60 * 1000;
const GAME_PRE_TTL_MS = 12 * HOUR_MS;
const GAME_FINAL_TTL_MS = 30 * 24 * HOUR_MS;
const TEAM_STATISTICS_TTL_MS = 12 * HOUR_MS; // season totals change once a week, after the team plays
const STANDINGS_TTL_MS = 24 * HOUR_MS; // current season: changes after games
const PAST_STANDINGS_TTL_MS = 365 * 24 * HOUR_MS; // finished seasons never change
const PLAYER_SPLITS_TTL_MS = 24 * HOUR_MS; // a player's splits change at most once a week, after his team plays
const PAST_PLAYER_SPLITS_TTL_MS = 365 * 24 * HOUR_MS; // finished seasons never change
const NEWS_TTL_MS = 12 * HOUR_MS; // keep the call count low; raise the refresh rate here if fresher news is needed

// Opt-in paging (?page, ?limit). A roster can reach ~90 players, so its max lets a client fetch it all in one page.
const NEWS_PAGING = {defaultLimit: 10, maxLimit: 50};
const PLAYERS_PAGING = {defaultLimit: 20, maxLimit: 100};

// A CDN copy lives only as long as the cache entry has left, so it is never staler than the entry.
const CDN_MAX_AGE_S = 24 * 60 * 60;
const STALE_CDN_AGE_S = 60; // old data served because upstream failed: retry soon
const cacheHeaders = (status, ttlLeftMs) => ({
  "X-Cache": status,
  "Cache-Control": `public, max-age=0, s-maxage=${status === "STALE" ? STALE_CDN_AGE_S : Math.min(Math.floor(ttlLeftMs / 1000), CDN_MAX_AGE_S)}`,
});

const getTeams = () => cached("teams", TEAMS_TTL_MS, fetchTeams);

app.get("/", (req, res) => {
  res.json({message: "NFL API is running"});
});

app.get("/api/teams", async (req, res, next) => {
  try {
    const {data, status, ttlLeftMs} = await getTeams();
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

const getInjuries = () => cached("injuries", INJURIES_TTL_MS, async () => {
  // Tag injuries with our team ids; the list still works if the team list is unavailable.
  let teamsByName = new Map();
  try {
    const {data: league} = await getTeams();
    teamsByName = new Map(league.teams.map((t) => [t.displayName, {id: t.id, abbreviation: t.abbreviation, displayName: t.displayName}]));
  } catch (err) {
    console.error("Injuries: team list unavailable, teams will have no ids");
  }
  return fetchInjuries(teamsByName);
});

app.get("/api/injuries", async (req, res, next) => {
  try {
    const {data, status, ttlLeftMs} = await getInjuries();
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^\d{1,10}$/.test(id)) {
      throw new HttpError(400, "invalid_team_id", "team id must be a number");
    }
    // Only real team ids reach the upstream API, so random ids can't burn quota.
    const {data: league} = await getTeams();
    if (!league.teams.some((t) => t.id === id)) {
      throw new HttpError(404, "team_not_found", "No NFL team with that id");
    }
    const {data, status, ttlLeftMs} = await cached(
      `teaminfo:${id}`,
      (info) => untilAfterNextGameMs(info.nextGame ? [Date.parse(info.nextGame.date)] : [], TEAM_INFO_MAX_TTL_MS),
      () => fetchTeamInfo(id)
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id/schedule", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^\d{1,10}$/.test(id)) {
      throw new HttpError(400, "invalid_team_id", "team id must be a number");
    }
    const season = parseSeason(req.query.season);
    // Only real team ids reach the upstream API, so random ids can't burn quota.
    const {data: league} = await getTeams();
    const team = league.teams.find((t) => t.id === id);
    if (!team) {
      throw new HttpError(404, "team_not_found", "No NFL team with that id");
    }
    const {data, status, ttlLeftMs} = await cached(
      `teamschedule:${id}:${season}`,
      season === currentSeason()
        ? (schedule) => untilAfterNextGameMs(schedule.games.filter((g) => g.status.state !== "post").map((g) => Date.parse(g.date)), TEAM_SCHEDULE_MAX_TTL_MS)
        : PAST_SCHEDULE_TTL_MS,
      async () => ({fetchedAt: new Date().toISOString(), ...(await fetchTeamSchedule(id, season))})
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json({
      season,
      team: {id: team.id, abbreviation: team.abbreviation, displayName: team.displayName, logo: team.logo},
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id/statistics", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^\d{1,10}$/.test(id)) {
      throw new HttpError(400, "invalid_team_id", "team id must be a number");
    }
    // Only real team ids reach the upstream API, so random ids can't burn quota.
    const {data: league} = await getTeams();
    const team = league.teams.find((t) => t.id === id);
    if (!team) {
      throw new HttpError(404, "team_not_found", "No NFL team with that id");
    }
    const {data, status, ttlLeftMs} = await cached(
      `teamstatistics:${id}`,
      TEAM_STATISTICS_TTL_MS,
      async () => ({fetchedAt: new Date().toISOString(), ...(await fetchTeamStatistics(id))})
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json({
      team: {id: team.id, abbreviation: team.abbreviation, displayName: team.displayName, logo: team.logo},
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id/players", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^\d{1,10}$/.test(id)) {
      throw new HttpError(400, "invalid_team_id", "team id must be a number");
    }
    // Validate before touching the cache so bad requests never cost an upstream call.
    const pagination = parsePagination(req.query, PLAYERS_PAGING);
    const {data: league} = await getTeams();
    const team = league.teams.find((t) => t.id === id);
    if (!team) {
      throw new HttpError(404, "team_not_found", "No NFL team with that id");
    }
    const {data: players, status, ttlLeftMs} = await cached(`roster:${id}`, ROSTER_TTL_MS, () => fetchRoster(id));
    const teamInfo = {id: team.id, abbreviation: team.abbreviation, displayName: team.displayName, logo: team.logo};
    if (!pagination) {
      res.set(cacheHeaders(status, ttlLeftMs)).json({team: teamInfo, players});
      return;
    }
    const {items, pagination: info} = paginate(players, pagination);
    res.set(cacheHeaders(status, ttlLeftMs)).json({team: teamInfo, players: items, pagination: info});
  } catch (err) {
    next(err);
  }
});

// Despite the name, upstream returns the current week's game days (e.g. Thursday, Sunday, Monday).
app.get("/api/daily-schedule", async (req, res, next) => {
  try {
    const season = currentSeason();
    const {data, status, ttlLeftMs} = await cached(
      `daily-schedule:${season}`,
      (schedule) => currentWeekTtlMs(schedule.days.flatMap((d) => d.games.map((g) => ({state: g.status.state, start: Date.parse(g.date)})))),
      async () => {
        const days = await fetchDailySchedule(season);
        return {season, week: days[0].games[0].week, days};
      }
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/weekly-schedule", async (req, res, next) => {
  try {
    const season = parseSeason(req.query.season);
    const week = parseWeek(req.query.week, season);
    const {data, status, ttlLeftMs} = await cached(
      `weekly-schedule:${season}:${week}`,
      WEEKLY_SCHEDULE_TTL_MS,
      async () => ({season, week, days: await fetchWeeklySchedule(season, week)})
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

// Validates the ids and returns {team, player} from the cached team list and roster, so only real
// rostered players reach the upstream API and random ids can't burn quota.
async function rosterPlayer({id, playerId}) {
  if (!/^\d{1,10}$/.test(id)) {
    throw new HttpError(400, "invalid_team_id", "team id must be a number");
  }
  if (!/^\d{1,10}$/.test(playerId)) {
    throw new HttpError(400, "invalid_player_id", "player id must be a number");
  }
  const {data: league} = await getTeams();
  const team = league.teams.find((t) => t.id === id);
  if (!team) {
    throw new HttpError(404, "team_not_found", "No NFL team with that id");
  }
  const {data: roster} = await cached(`roster:${id}`, ROSTER_TTL_MS, () => fetchRoster(id));
  const player = roster.find((p) => p.id === playerId);
  if (!player) {
    throw new HttpError(404, "player_not_found", "No player with that id on this team's roster");
  }
  return {team, player};
}

const playerSummary = (p) => ({id: p.id, fullName: p.fullName, shortName: p.shortName, link: p.link});
const teamSummary = (t) => ({id: t.id, abbreviation: t.abbreviation, displayName: t.displayName});

app.get("/api/teams/:id/players/:playerId/splits", async (req, res, next) => {
  try {
    const season = parseSeason(req.query.season);
    const {team, player} = await rosterPlayer(req.params);
    const {data, status, ttlLeftMs} = await cached(
      `playersplits:${player.id}:${season}`,
      season === currentSeason() ? PLAYER_SPLITS_TTL_MS : PAST_PLAYER_SPLITS_TTL_MS,
      async () => ({fetchedAt: new Date().toISOString(), ...(await fetchPlayerSplits(player.id, season))})
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json({season, player: playerSummary(player), team: teamSummary(team), ...data});
  } catch (err) {
    next(err);
  }
});

app.get("/api/teams/:id/players/:playerId/overview", async (req, res, next) => {
  try {
    const {team, player} = await rosterPlayer(req.params);
    const {data, status, ttlLeftMs} = await cached(
      `playeroverview:${player.id}`,
      (overview) => untilAfterNextGameMs(overview.nextGame ? [Date.parse(overview.nextGame.date)] : [], PLAYER_OVERVIEW_MAX_TTL_MS),
      () => fetchPlayerOverview(player.id)
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json({player: playerSummary(player), team: teamSummary(team), ...data});
  } catch (err) {
    next(err);
  }
});

app.get("/api/game-summary", async (req, res, next) => {
  try {
    const id = req.query.id;
    if (typeof id !== "string" || !/^\d{6,12}$/.test(id)) {
      throw new HttpError(400, "invalid_game_id", "id must be a game id from the schedule endpoints");
    }
    const {data, status, ttlLeftMs} = await cached(
      `gamesummary:${id}`,
      (g) => (g.status.state === "post" ? GAME_FINAL_TTL_MS : g.status.state === "in" ? GAME_LIVE_TTL_MS : GAME_PRE_TTL_MS),
      () => fetchGameSummary(id)
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/standings", async (req, res, next) => {
  try {
    const season = parseSeason(req.query.season);
    const {data, status, ttlLeftMs} = await cached(
      `standings:${season}`,
      season === currentSeason() ? STANDINGS_TTL_MS : PAST_STANDINGS_TTL_MS,
      async () => ({season, fetchedAt: new Date().toISOString(), ...(await fetchStandings(season))})
    );
    res.set(cacheHeaders(status, ttlLeftMs)).json(data);
  } catch (err) {
    next(err);
  }
});

app.get("/api/news", async (req, res, next) => {
  try {
    // Validate before touching the cache so bad requests never cost an upstream call.
    const pagination = parsePagination(req.query, NEWS_PAGING);
    const {data, status, ttlLeftMs} = await cached("news", NEWS_TTL_MS, async () => {
      // Tag news items with our team ids; news still works if the team list is unavailable.
      let teamsById = new Map();
      try {
        const {data: league} = await getTeams();
        teamsById = new Map(league.teams.map((t) => [t.id, {id: t.id, abbreviation: t.abbreviation, displayName: t.displayName}]));
      } catch (err) {
        console.error("News: team list unavailable, teams will have no ids");
      }
      return fetchNews(teamsById);
    });
    if (!pagination) {
      res.set(cacheHeaders(status, ttlLeftMs)).json(data);
      return;
    }
    const {items, pagination: info} = paginate(data.items, pagination);
    res.set(cacheHeaders(status, ttlLeftMs)).json({...data, items, pagination: info});
  } catch (err) {
    next(err);
  }
});

app.use((req, res, next) => {
  next(new HttpError(404, "not_found", "Route not found"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    err = new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (!(err instanceof HttpError)) {
    console.error(err);
    err = new HttpError(500, "internal_error", "Something went wrong");
  }
  res.set(err.headers).status(err.status).json({error: {code: err.code, message: err.message}});
});

module.exports = app;
