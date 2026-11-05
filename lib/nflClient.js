const {HttpError} = require("./errors");
const {reserveUpstreamCall} = require("./budget");
const {trimTeams, trimNews, trimInjuries, trimTeamInfo, trimRoster, trimSchedule, trimPlayerSplits, trimPlayerOverview, trimTeamSchedule, trimGameSummary, trimStandings, trimTeamStatistics} = require("./transform");

const TIMEOUT_MS = 8000;
const LARGE_TIMEOUT_MS = 20000; // for multi-MB upstream payloads

function config() {
  const {NFL_API_URL, NFL_API_HOST, NFL_API_TOKEN} = process.env;
  if (!NFL_API_URL || !NFL_API_HOST || !NFL_API_TOKEN) {
    console.error("Missing NFL_API_URL, NFL_API_HOST or NFL_API_TOKEN");
    throw new HttpError(500, "server_misconfigured", "Server is not configured correctly");
  }
  return {NFL_API_URL, NFL_API_HOST, NFL_API_TOKEN};
}

async function request(path, params = {}, timeoutMs = TIMEOUT_MS) {
  const {NFL_API_URL, NFL_API_HOST, NFL_API_TOKEN} = config();
  await reserveUpstreamCall(); // counts the call against the monthly limit, or refuses once it is reached
  const url = new URL(path, NFL_API_URL);
  url.search = new URLSearchParams(params).toString();

  let res;
  try {
    res = await fetch(url, {
      headers: {"x-rapidapi-key": NFL_API_TOKEN, "x-rapidapi-host": NFL_API_HOST},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err.name === "TimeoutError";
    console.error("Upstream request failed:", err.message);
    throw new HttpError(
      timedOut ? 504 : 502,
      timedOut ? "upstream_timeout" : "upstream_unreachable",
      timedOut ? "Upstream API timed out" : "Could not reach upstream API"
    );
  }

  if (res.status === 429) {
    console.error("Upstream rate limit / quota exceeded");
    throw new HttpError(503, "upstream_rate_limited", "Upstream API limit reached, try again later", {"Retry-After": "300"});
  }
  if (res.status === 401 || res.status === 403) {
    console.error(`Upstream rejected credentials (${res.status})`);
    throw new HttpError(502, "upstream_auth_failed", "Upstream API request failed");
  }
  if (!res.ok) {
    console.error(`Upstream returned ${res.status}`);
    throw new HttpError(502, "upstream_error", "Upstream API request failed");
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned invalid data");
  }
  if (!data || typeof data !== "object") {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  return data;
}

const fetchTeams = async () => trimTeams(await request("/nflteamlist"));

const fetchNews = async (teamsById) => trimNews(await request("/nfl-news"), teamsById);

const fetchInjuries = async (teamsByName) => trimInjuries(await request("/v2/injuries", {}, LARGE_TIMEOUT_MS), teamsByName);

const fetchTeamInfo = async (teamId) => trimTeamInfo(await request("/nflteaminfo", {teamid: teamId}));

const fetchRoster = async (teamId) => trimRoster(await request("/players/id", {teamId}));

const fetchWeeklySchedule = async (season, week) => trimSchedule(await request("/nfl-schedule-weekly", {year: String(season), week: String(week)}, LARGE_TIMEOUT_MS));

const fetchDailySchedule = async (season) => trimSchedule(await request("/nflschedule", {year: String(season), current: "true"}, LARGE_TIMEOUT_MS));

const fetchPlayerSplits = async (playerId, season) => trimPlayerSplits(await request("/player-splits", {playerId, season: String(season), type: "nfl"}, LARGE_TIMEOUT_MS));

const fetchPlayerOverview = async (playerId) => trimPlayerOverview(await request("/player-overview", {playerId}, LARGE_TIMEOUT_MS));

const fetchTeamSchedule = async (teamId, season) => trimTeamSchedule(await request("/nfl-schedule-team", {season: String(season), teamId}, LARGE_TIMEOUT_MS));

const fetchGameSummary = async (gameId) => trimGameSummary(await request("/nflsummary", {id: gameId}, LARGE_TIMEOUT_MS));

const fetchStandings = async (season) => trimStandings(await request("/nflstandings", {year: String(season)}, LARGE_TIMEOUT_MS));

const fetchTeamStatistics = async (teamId) => trimTeamStatistics(await request("/nfl-team-statistic", {teamId}));

module.exports = {fetchTeamStatistics, fetchStandings, fetchGameSummary, fetchTeamSchedule, fetchPlayerOverview, fetchPlayerSplits, fetchTeams, fetchNews, fetchInjuries, fetchTeamInfo, fetchRoster, fetchWeeklySchedule, fetchDailySchedule};
