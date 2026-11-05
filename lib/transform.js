const {HttpError} = require("./errors");

function logo(t, ...rels) {
  const l = (t.logos || []).find((x) => rels.length === x.rel.filter((r) => r !== "full").length && rels.every((r) => x.rel.includes(r)));
  return l ? l.href : null;
}

function trimTeams(raw) {
  const league = raw && Array.isArray(raw.sports) && raw.sports[0] && (raw.sports[0].leagues || [])[0];
  if (!league || !Array.isArray(league.teams) || league.teams.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const teams = league.teams
    .map((x) => x.team)
    .filter((t) => t && t.id && t.isActive !== false)
    .map((t) => ({
      id: t.id,
      abbreviation: t.abbreviation || null,
      name: t.name || null,
      displayName: t.displayName || null,
      shortDisplayName: t.shortDisplayName || null,
      location: t.location || null,
      slug: t.slug || null,
      color: t.color || null,
      alternateColor: t.alternateColor || null,
      logo: logo(t, "default"),
      logoDark: logo(t, "dark"),
      logoScoreboard: logo(t, "scoreboard"),
      logoScoreboardDark: logo(t, "scoreboard", "dark"),
    }))
    .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
  return {season: league.season && league.season.displayName || null, teams};
}

const NFL_LEAGUE_ID = 28;
const NFL_TEAM_UID = /^s:20~l:28~/; // excludes college teams that are tagged on the same story

function newsType(type) {
  if (type === "Story") return "story";
  if (type === "HeadlineNews") return "headline";
  if (type === "Media") return "video";
  return "other";
}

// Photos first (up to 3); a story with only a video thumbnail falls back to that.
function newsImages(images) {
  const list = (Array.isArray(images) ? images : []).filter((i) => i && typeof i.url === "string");
  const photos = list.filter((i) => i.type !== "Media");
  const pick = photos.length ? photos.slice(0, 3) : list.slice(0, 1);
  return pick.map((i) => i.url.replace(/^http:\/\//, "https://"));
}

// teamsById: Map of team id -> {id, abbreviation, displayName} from /api/teams.
function trimNews(raw, teamsById = new Map()) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const items = raw
    .filter((n) => n && n.headline && n.links && n.links.web && n.links.web.href && n.published && !n.premium)
    .filter((n) => (n.categories || []).some((c) => c.type === "league" && c.leagueId === NFL_LEAGUE_ID))
    .map((n) => {
      const cats = Array.isArray(n.categories) ? n.categories : [];
      return {
        headline: n.headline,
        description: n.description || null,
        byline: n.byline || null,
        link: n.links.web.href.replace(/^http:\/\//, "https://"),
        type: newsType(n.type),
        published: n.published,
        images: newsImages(n.images),
        teams: cats
          .filter((c) => c.type === "team" && NFL_TEAM_UID.test(c.uid || ""))
          .map((c) => teamsById.get(String(c.teamId)) || {id: null, abbreviation: c.team && c.team.abbreviation || null, displayName: c.description}),
        athletes: cats.filter((c) => c.type === "athlete").map((c) => c.description),
      };
    })
    .sort((a, b) => b.published.localeCompare(a.published));
  if (items.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  return {fetchedAt: new Date().toISOString(), items};
}

function athleteId(href) {
  const m = /\/id\/(\d+)\//.exec(href || "");
  return m ? m[1] : null;
}

// teamsByName: Map of team displayName -> {id, abbreviation, displayName, logo} from /api/teams.
function trimInjuries(raw, teamsByName = new Map()) {
  if (!raw || raw.status !== "success" || !Array.isArray(raw.data)) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const injuries = [];
  for (const t of raw.data) {
    const team = teamsByName.get(t && t.displayName) || {id: null, abbreviation: null, displayName: t && t.displayName || null};
    for (const i of (t && t.items) || []) {
      const a = i.athlete || {};
      injuries.push({
        player: {
          id: athleteId(a.href),
          fullName: a.name || null,
          shortName: a.shortName || null,
          position: a.position || null,
          headshot: a.logo && a.logo.href || null,
        },
        team: {id: team.id, abbreviation: team.abbreviation, displayName: team.displayName},
        status: i.statusDesc || null,
        statusCode: i.type && i.type.abbreviation || null,
        date: i.date || null,
        comment: i.description || null,
      });
    }
  }
  return {fetchedAt: new Date().toISOString(), injuries};
}

const TEAM_RECORD_STATS = ["gamesPlayed", "wins", "losses", "ties", "winPercent", "pointsFor", "pointsAgainst", "pointDifferential", "streak", "playoffSeed"];

function trimTeamInfo(raw) {
  const t = raw && raw.team;
  if (!t || !t.id) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const records = (t.record && t.record.items) || [];
  const overall = records.find((r) => r.type === "total");
  const stats = {};
  for (const s of (overall && overall.stats) || []) {
    if (TEAM_RECORD_STATS.includes(s.name)) stats[s.name] = s.value;
  }
  const summaryOf = (type) => {
    const r = records.find((x) => x.type === type);
    return r && r.summary || null;
  };
  const venue = t.franchise && t.franchise.venue;
  const img = venue && (venue.images || [])[0];
  const ev = (t.nextEvent || [])[0];
  const comp = ev && (ev.competitions || [])[0];
  const opponent = comp && (comp.competitors || []).find((c) => c.team && c.team.id !== t.id);
  const status = comp && comp.status && comp.status.type;
  return {
    id: t.id,
    abbreviation: t.abbreviation || null,
    name: t.name || null,
    displayName: t.displayName || null,
    shortDisplayName: t.shortDisplayName || null,
    location: t.location || null,
    slug: t.slug || null,
    color: t.color || null,
    alternateColor: t.alternateColor || null,
    logo: logo(t, "default"),
    logoDark: logo(t, "dark"),
    logoScoreboard: logo(t, "scoreboard"),
    logoScoreboardDark: logo(t, "scoreboard", "dark"),
    standingSummary: t.standingSummary || null,
    record: {summary: overall ? overall.summary || null : null, home: summaryOf("home"), road: summaryOf("road"), ...stats},
    venue: venue && venue.fullName
      ? {
          name: venue.fullName,
          city: venue.address && venue.address.city || null,
          state: venue.address && venue.address.state || null,
          indoor: typeof venue.indoor === "boolean" ? venue.indoor : null,
          grass: typeof venue.grass === "boolean" ? venue.grass : null,
          image: img && img.href || null,
        }
      : null,
    nextGame: ev
      ? {
          id: ev.id || null,
          name: ev.name || null,
          shortName: ev.shortName || null,
          date: ev.date || null,
          week: ev.week && ev.week.number || null,
          seasonType: ev.seasonType && ev.seasonType.name || null,
          status: status ? {state: status.state || null, detail: status.detail || status.description || null} : null,
          homeAway: opponent ? (opponent.homeAway === "home" ? "away" : "home") : null,
          venue: comp.venue && comp.venue.fullName || null,
          broadcasts: (comp.broadcasts || []).map((b) => b.media && b.media.shortName).filter(Boolean),
          opponent: opponent
            ? {
                id: opponent.team.id,
                abbreviation: opponent.team.abbreviation || null,
                displayName: opponent.team.displayName || null,
                logo: logo(opponent.team, "default"),
                logoDark: logo(opponent.team, "dark"),
              }
            : null,
        }
      : null,
  };
}

function trimRoster(raw) {
  if (!raw || !Array.isArray(raw.data) || raw.data.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  return raw.data
    .filter((p) => p && p.playerId)
    .map((p) => ({
      id: String(p.playerId),
      firstName: p.firstName || null,
      lastName: p.lastName || null,
      fullName: p.fullName || p.displayName || null,
      shortName: p.shortName || null,
      link: p.link ? p.link.replace(/^http:\/\//, "https://") : null,
    }));
}

const toScore = (v) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

const LEADER_CATEGORIES = {passingLeader: "passing", rushingLeader: "rushing", receivingLeader: "receiving"};

function trimLeaders(leaders) {
  return (Array.isArray(leaders) ? leaders : [])
    .filter((l) => LEADER_CATEGORIES[l.name] && (l.leaders || [])[0] && l.leaders[0].athlete)
    .map((l) => {
      const top = l.leaders[0];
      const a = top.athlete;
      return {
        category: LEADER_CATEGORIES[l.name],
        displayValue: top.displayValue || null,
        player: {
          id: a.id || null,
          fullName: a.fullName || a.displayName || null,
          shortName: a.shortName || null,
          position: a.position && a.position.abbreviation || null,
          jersey: a.jersey || null,
          headshot: a.headshot || null,
        },
      };
    });
}

function trimCompetitor(c, state) {
  const t = c.team || {};
  const overall = (c.records || []).find((r) => r.type === "total");
  return {
    id: c.id || t.id || null,
    abbreviation: t.abbreviation || null,
    displayName: t.displayName || null,
    shortDisplayName: t.shortDisplayName || null,
    logo: t.logo || null,
    logoDark: t.logoDark || null,
    score: state === "pre" ? null : toScore(c.score), // upstream reports 0-0 before kickoff
    winner: typeof c.winner === "boolean" ? c.winner : null,
    record: overall && overall.summary || null,
    linescores: (c.linescores || []).map((l) => toScore(l.value)),
    leaders: trimLeaders(c.leaders),
  };
}

// raw: {"YYYYMMDD": {games: [...]}} as returned by both schedule endpoints.
function trimSchedule(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const days = Object.keys(raw)
    .filter((k) => /^\d{8}$/.test(k) && raw[k] && Array.isArray(raw[k].games))
    .sort()
    .map((k) => ({
      date: `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`,
      games: raw[k].games
        .filter((g) => g && g.id && (g.competitions || [])[0])
        .map((g) => {
          const comp = g.competitions[0];
          const competitors = comp.competitors || [];
          const home = competitors.find((c) => c.homeAway === "home");
          const away = competitors.find((c) => c.homeAway === "away");
          const st = (comp.status || g.status || {}).type || {};
          const venue = comp.venue || {};
          const gamecast = (g.links || []).find((l) => (l.rel || []).includes("summary"));
          return {
            id: g.id,
            name: g.name || null,
            shortName: g.shortName || null,
            week: g.week && g.week.number || null,
            date: g.date || comp.date || null,
            status: {state: st.state || null, detail: st.detail || st.description || null, period: (comp.status || g.status || {}).period ?? null, clock: (comp.status || g.status || {}).displayClock || null},
            venue: venue.fullName
              ? {name: venue.fullName, city: venue.address && venue.address.city || null, state: venue.address && venue.address.state || null, indoor: typeof venue.indoor === "boolean" ? venue.indoor : null}
              : null,
            neutralSite: typeof comp.neutralSite === "boolean" ? comp.neutralSite : null,
            broadcast: comp.broadcast || null,
            notes: (comp.notes || []).map((n) => n.headline).filter(Boolean),
            link: gamecast && gamecast.href ? gamecast.href.replace(/^http:\/\//, "https://") : null,
            home: home ? trimCompetitor(home, st.state) : null,
            away: away ? trimCompetitor(away, st.state) : null,
          };
        }),
    }))
    .filter((d) => d.games.length > 0);
  if (days.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  return days;
}

const toStat = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : v;
};

// Splits are rows of numbers matching the `names` columns, grouped by split type (home/away, month, opponent...).
function trimPlayerSplits(raw) {
  const ps = raw && raw.player_splits;
  if (!ps || !Array.isArray(ps.names) || !Array.isArray(ps.splitCategories)) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  // `categories` says how many of the leading columns belong to each stat group (tackles, fumbles, interceptions).
  const groupOf = [];
  for (const c of ps.categories || []) {
    for (let i = 0; i < c.count; i++) groupOf.push(c.displayName || c.name || null);
  }
  const statistics = ps.names.map((name, i) => ({
    key: name,
    label: (ps.labels || [])[i] || null,
    name: (ps.displayNames || [])[i] || null,
    description: (ps.descriptions || [])[i] || null,
    group: groupOf[i] || null,
  }));
  const splits = ps.splitCategories
    .filter((c) => Array.isArray(c.splits) && c.splits.length > 0)
    .map((c) => ({
      key: c.name,
      name: c.name === "split" ? "Home/Away" : c.displayName || c.name,
      rows: c.splits.map((r) => ({
        name: r.displayName || null,
        abbreviation: r.abbreviation || null,
        stats: Object.fromEntries(ps.names.map((n, i) => [n, toStat((r.stats || [])[i])])),
      })),
    }));
  if (statistics.length === 0 || splits.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  return {statistics, splits};
}

// Stat tables come as parallel arrays (names, labels, displayNames); `categories` says how many leading columns each group owns.
function statColumns(t) {
  const groupOf = [];
  for (const c of t.categories || []) {
    for (let i = 0; i < c.count; i++) groupOf.push(c.displayName || c.name || null);
  }
  return (t.names || []).map((key, i) => ({
    key,
    label: (t.labels || [])[i] || null,
    name: (t.displayNames || [])[i] || null,
    group: groupOf[i] || null,
  }));
}

const statRow = (columns, stats) => Object.fromEntries(columns.map((c, i) => [c.key, toStat((stats || [])[i])]));

function trimOverviewStatistics(st) {
  if (!st || !Array.isArray(st.names) || st.names.length === 0) return null;
  const columns = statColumns(st);
  return {
    name: st.displayName || null,
    columns,
    rows: (st.splits || []).map((r) => ({name: r.displayName || null, stats: statRow(columns, r.stats)})),
  };
}

function trimOverviewGameLog(gl) {
  const tables = gl && Array.isArray(gl.statistics) ? gl.statistics.filter((t) => Array.isArray(t.names)) : [];
  if (tables.length === 0) return null;
  const columns = tables.map((t) => ({name: t.displayName || null, columns: statColumns(t).map(({key, label, name}) => ({key, label, name}))}));
  const order = (tables[0].events || []).map((e) => String(e.eventId)); // most recent first
  const games = order.map((id) => {
    const e = (gl.events || {})[id] || {};
    const stats = {};
    tables.forEach((t, ti) => {
      const row = (t.events || []).find((x) => String(x.eventId) === id);
      stats[columns[ti].name] = row ? statRow(statColumns(t), row.stats) : null;
    });
    return {
      id,
      week: e.week || null,
      date: e.gameDate || null,
      atVs: e.atVs || null,
      opponent: e.opponent ? {id: e.opponent.id || null, abbreviation: e.opponent.abbreviation || null, displayName: e.opponent.displayName || null} : null,
      result: e.gameResult || null,
      score: e.score || null,
      stats,
    };
  });
  return {groups: columns, games};
}

function trimOverviewNextGame(ng) {
  const ev = ng && ng.league && (ng.league.events || [])[0];
  if (!ev) return null;
  const team = (c) => (c ? {id: c.id || null, abbreviation: c.abbreviation || null, displayName: c.displayName || null, logo: c.logo || null, logoDark: c.logoDark || null, record: c.record || null} : null);
  const competitors = ev.competitors || [];
  const detail = ev.fullStatus && ev.fullStatus.type && ev.fullStatus.type.detail;
  return {
    id: ev.id || null,
    name: ev.name || null,
    shortName: ev.shortName || null,
    date: ev.date || null,
    week: ev.week || null,
    status: {state: ev.status || null, detail: detail || null},
    venue: ev.location || null,
    broadcast: ev.broadcast || null,
    home: team(competitors.find((c) => c.homeAway === "home")),
    away: team(competitors.find((c) => c.homeAway === "away")),
  };
}

function trimOverviewNews(news) {
  return (Array.isArray(news) ? news : [])
    .filter((n) => n && n.headline && n.links && n.links.web && n.links.web.href && n.published && !n.premium)
    .map((n) => {
      const img = (n.images || []).find((i) => i && typeof i.url === "string");
      return {
        headline: n.headline,
        description: n.description || null,
        byline: n.byline || null,
        link: n.links.web.href.replace(/^http:\/\//, "https://"),
        type: newsType(n.type),
        published: n.published,
        image: img ? img.url.replace(/^http:\/\//, "https://") : null,
      };
    });
}

function trimPlayerOverview(raw) {
  const po = raw && raw.player_overview;
  if (!po || typeof po !== "object") {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const rw = po.rotowire;
  const published = rw && rw.published ? Date.parse(rw.published) : NaN;
  const f = po.fantasy;
  return {
    fetchedAt: new Date().toISOString(),
    statistics: trimOverviewStatistics(po.statistics),
    gameLog: trimOverviewGameLog(po.gameLog),
    nextGame: trimOverviewNextGame(po.nextGame),
    news: trimOverviewNews(po.news),
    // Short analyst note on the player's current situation.
    analysis: rw && rw.headline ? {headline: rw.headline, story: rw.story || null, published: Number.isFinite(published) ? new Date(published).toISOString() : rw.published || null} : null,
    fantasy: f && typeof f === "object"
      ? {draftRank: toStat(f.draftRank), positionRank: toStat(f.positionRank), percentOwned: toStat(f.percentOwned), last7Days: toStat(f.last7Days), projection: f.projection || null}
      : null,
  };
}

function trimTeamSchedule(raw) {
  const t = raw && raw.team;
  if (!raw || raw.status !== "success" || !t || !t.id || !Array.isArray(raw.events)) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const recordOf = (c) => {
    const r = (c.record || []).find((x) => x.type === "total");
    return r && r.displayValue || null;
  };
  const scoreOf = (c) => (c.score && typeof c.score.value === "number" ? c.score.value : null);
  const games = raw.events
    .filter((e) => e && e.id && (e.competitions || [])[0])
    .map((e) => {
      const comp = e.competitions[0];
      const mine = (comp.competitors || []).find((c) => c.id === t.id);
      const other = (comp.competitors || []).find((c) => c.id !== t.id);
      const st = (comp.status || {}).type || {};
      const venue = comp.venue || {};
      const gamecast = (e.links || []).find((l) => (l.rel || []).includes("summary") && (l.rel || []).includes("desktop"));
      const done = st.state === "post";
      return {
        id: e.id,
        name: e.name || null,
        shortName: e.shortName || null,
        week: e.week && e.week.number || null,
        seasonType: e.seasonType && e.seasonType.name || null,
        date: e.date || comp.date || null,
        status: {state: st.state || null, detail: st.detail || st.description || null},
        homeAway: mine && mine.homeAway || null,
        // W / L / T once the game is final, null before
        result: done && mine ? (mine.winner ? "W" : other && other.winner ? "L" : "T") : null,
        venue: venue.fullName
          ? {name: venue.fullName, city: venue.address && venue.address.city || null, state: venue.address && venue.address.state || null}
          : null,
        neutralSite: typeof comp.neutralSite === "boolean" ? comp.neutralSite : null,
        broadcasts: (comp.broadcasts || []).map((b) => b.media && b.media.shortName).filter(Boolean),
        link: gamecast && gamecast.href ? gamecast.href.replace(/^http:\/\//, "https://") : null,
        team: mine ? {score: done ? scoreOf(mine) : null, record: recordOf(mine)} : null,
        opponent: other && other.team
          ? {
              id: other.team.id || other.id || null,
              abbreviation: other.team.abbreviation || null,
              displayName: other.team.displayName || null,
              logo: logo(other.team, "default"),
              logoDark: logo(other.team, "dark"),
              score: done ? scoreOf(other) : null,
              record: recordOf(other),
            }
          : null,
      };
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (games.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  return {
    recordSummary: t.recordSummary || null,
    standingSummary: t.standingSummary || null,
    byeWeek: raw.byeWeek ?? null,
    games,
  };
}

const summaryTeam = (t) => ({
  id: t.id || null,
  abbreviation: t.abbreviation || null,
  displayName: t.displayName || null,
  shortDisplayName: t.shortDisplayName || null,
  color: t.color || null,
  logo: t.logo || null,
});

// Box score for one team's players: tables per category (passing, rushing...), rows keyed by stat key.
function summaryPlayerTables(statistics) {
  return (statistics || [])
    .filter((c) => Array.isArray(c.keys) && (c.athletes || []).length > 0)
    .map((c) => ({
      name: c.name || null,
      title: c.text || null,
      columns: c.keys.map((key, i) => ({key, label: (c.labels || [])[i] || null, description: (c.descriptions || [])[i] || null})),
      players: c.athletes.map((a) => ({
        id: a.athlete && a.athlete.id || null,
        fullName: a.athlete && a.athlete.displayName || null,
        jersey: a.athlete && a.athlete.jersey || null,
        headshot: a.athlete && a.athlete.headshot && a.athlete.headshot.href || null,
        stats: Object.fromEntries(c.keys.map((key, i) => [key, (a.stats || [])[i] ?? null])),
      })),
      totals: (c.totals || []).length ? Object.fromEntries(c.keys.map((key, i) => [key, c.totals[i] ?? null])) : null,
    }));
}

function trimGameSummary(raw) {
  const header = raw && raw.header;
  const comp = header && (header.competitions || [])[0];
  const box = raw && raw.boxScore;
  if (!comp || !box || !Array.isArray(box.teams) || !Array.isArray(raw.teams)) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const st = (comp.status && comp.status.type) || {};
  const state = st.state || null;
  const info = raw.gameInfo || {};
  const venue = info.venue || {};
  const teams = raw.teams.map((t) => {
    const record = (t.record || []).find((r) => r.type === "total");
    return {
      ...summaryTeam(t.team || {}),
      homeAway: t.homeAway || null,
      winner: typeof t.winner === "boolean" ? t.winner : null,
      score: state === "pre" ? null : toScore(t.score),
      linescores: (t.linescores || []).map((l) => toScore(l.displayValue)),
      record: record && record.displayValue || null,
    };
  });
  return {
    id: String(raw.id || header.id),
    season: raw.season && raw.season.year || null,
    week: raw.week || null,
    date: comp.date || null,
    status: {state, detail: st.detail || st.description || null},
    neutralSite: typeof comp.neutralSite === "boolean" ? comp.neutralSite : null,
    broadcasts: (comp.broadcasts || []).map((b) => b.media && b.media.shortName).filter(Boolean),
    venue: venue.fullName
      ? {name: venue.fullName, city: venue.address && venue.address.city || null, state: venue.address && venue.address.state || null, grass: typeof venue.grass === "boolean" ? venue.grass : null}
      : null,
    attendance: info.attendance || null,
    officials: (info.officials || []).map((o) => ({name: o.displayName || o.fullName || null, position: o.position && o.position.displayName || null})),
    teams,
    teamStats: box.teams.map((t) => ({
      team: summaryTeam(t.team || {}),
      stats: (t.statistics || []).map((x) => ({key: x.name, label: x.label || null, value: x.displayValue ?? null})),
    })),
    playerStats: (box.players || []).map((p) => ({team: summaryTeam(p.team || {}), tables: summaryPlayerTables(p.statistics)})),
    scoringPlays: (raw.scoringPlays || []).map((p) => ({
      id: p.id || null,
      quarter: p.period && p.period.number || null,
      clock: p.clock && p.clock.displayValue || null,
      team: p.team ? {id: p.team.id || null, abbreviation: p.team.abbreviation || null} : null,
      type: p.scoringType && p.scoringType.displayName || p.type && p.type.text || null,
      text: p.text ? p.text.trim() : null,
      awayScore: p.awayScore ?? null,
      homeScore: p.homeScore ?? null,
    })),
    drives: ((raw.drives && raw.drives.previous) || []).map((d) => ({
      id: d.id || null,
      team: d.team ? {id: d.team.id || null, abbreviation: d.team.abbreviation || null} : null,
      description: d.description || null,
      result: d.displayResult || d.result || null,
      isScore: typeof d.isScore === "boolean" ? d.isScore : null,
      plays: d.offensivePlays ?? null,
      yards: d.yards ?? null,
      timeElapsed: d.timeElapsed && d.timeElapsed.displayValue || null,
      start: d.start ? {quarter: d.start.period && d.start.period.number || null, clock: d.start.clock && d.start.clock.displayValue || null, position: d.start.text || null} : null,
      end: d.end ? {quarter: d.end.period && d.end.period.number || null, clock: d.end.clock && d.end.clock.displayValue || null, position: d.end.text || null} : null,
    })),
  };
}

// ESPN division ids as they appear in the standings (verified against the team lists of 2025 and 2026).
const DIVISIONS = {
  1: {conference: "NFC", name: "NFC East"},
  3: {conference: "NFC", name: "NFC West"},
  10: {conference: "NFC", name: "NFC North"},
  11: {conference: "NFC", name: "NFC South"},
  4: {conference: "AFC", name: "AFC East"},
  6: {conference: "AFC", name: "AFC West"},
  12: {conference: "AFC", name: "AFC North"},
  13: {conference: "AFC", name: "AFC South"},
};

function trimStandings(raw) {
  const entries = raw && raw.standings && raw.standings.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const teams = entries.map((en) => {
    const t = en.team || {};
    // Later entries of the same type (total_*) repeat the overall numbers, so the first one wins.
    const st = {};
    for (const x of en.stats || []) if (!(x.type in st)) st[x.type] = x;
    const val = (type) => (st[type] && typeof st[type].value === "number" ? st[type].value : null);
    const display = (type) => (st[type] && st[type].displayValue !== undefined ? st[type].displayValue : null);
    const division = DIVISIONS[val("divisionid")];
    if (!t.id || !division) {
      throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
    }
    return {
      id: t.id,
      abbreviation: t.abbreviation || null,
      displayName: t.displayName || null,
      shortDisplayName: t.shortDisplayName || null,
      logo: logo(t, "default"),
      logoDark: logo(t, "scoreboard", "dark"),
      conference: division.conference,
      division: division.name,
      divisionRank: val("divisionrank"),
      conferenceRank: val("conferencerank"),
      clincher: display("clincher") || null,
      record: st.total && st.total.summary || null,
      wins: val("wins"),
      losses: val("losses"),
      ties: val("ties"),
      winPercent: val("winpercent"),
      divisionRecord: display("divisionrecord"),
      conferenceRecord: display("conferencerecord"),
      pointsFor: val("pointsscored"),
      pointsAgainst: val("pointsallowed"),
      pointDifferential: val("total_pointdifferential"),
      gamesBehind: val("total_gamesbehind"),
      strengthOfSchedule: val("strengthofschedule"),
    };
  });
  const byRank = (key) => (a, b) => (a[key] ?? 99) - (b[key] ?? 99);
  const conferences = ["AFC", "NFC"].map((conference) => {
    const inConf = teams.filter((t) => t.conference === conference);
    const divisions = [...new Set(inConf.map((t) => t.division))].sort().map((name) => ({
      name,
      teams: inConf.filter((t) => t.division === name).sort(byRank("divisionRank")),
    }));
    return {name: conference, divisions, ranking: [...inConf].sort(byRank("conferenceRank"))};
  });
  return {conferences};
}

// Upstream sends the team's own stats and the opponent's stats as two parallel lists; merge them so each stat carries both.
// Opponent values are what the team's opponents did against it, with the team's league rank.
function trimTeamStatistics(raw) {
  const own = raw && raw.stats && raw.stats.categories;
  const opp = raw && raw.opponent;
  if (!Array.isArray(own) || own.length === 0) {
    throw new HttpError(502, "upstream_invalid_response", "Upstream API returned unexpected data");
  }
  const side = (s) => (s ? {
    value: typeof s.value === "number" ? s.value : null,
    displayValue: s.displayValue === undefined ? null : s.displayValue,
    perGame: typeof s.perGameValue === "number" ? Math.round(s.perGameValue * 1000) / 1000 : null,
  } : null);
  const ranked = (s) => {
    const o = side(s);
    return o && {...o, rank: typeof s.rank === "number" ? s.rank : null, rankDisplayValue: s.rankDisplayValue || null};
  };
  const categories = own.map((c) => {
    const oppStats = new Map(((Array.isArray(opp) && opp.find((o) => o.name === c.name)) || {stats: []}).stats.map((s) => [s.name, s]));
    const seen = new Set(); // upstream lists a few stats twice
    return {
      key: c.name,
      name: c.displayName || c.name,
      stats: (c.stats || []).filter((s) => s && s.name && !seen.has(s.name) && seen.add(s.name)).map((s) => ({
        key: s.name,
        label: s.abbreviation || null,
        name: s.displayName || null,
        description: s.description || null,
        team: side(s),
        opponent: ranked(oppStats.get(s.name)),
      })),
    };
  });
  return {categories};
}

module.exports = {trimTeams, trimNews, trimInjuries, trimTeamInfo, trimRoster, trimSchedule, trimPlayerSplits, trimPlayerOverview, trimTeamSchedule, trimGameSummary, trimStandings, trimTeamStatistics};
