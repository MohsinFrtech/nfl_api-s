const {getRedis} = require("./redis");
const {HttpError} = require("./errors");

const DEFAULT_MONTHLY_LIMIT = 19000; // RapidAPI plan is 20,000/month; the gap covers a billing cycle that differs from the calendar month
const COUNTER_TTL_S = 40 * 24 * 60 * 60;

// Counts every upstream call in Redis (shared by all instances) and refuses once the monthly limit
// is reached, so callers fall back to cached data. Without Redis there is no shared count, so nothing is enforced.
async function reserveUpstreamCall() {
  const redis = getRedis();
  if (!redis) return;
  const limit = Number(process.env.UPSTREAM_MONTHLY_LIMIT) || DEFAULT_MONTHLY_LIMIT;
  const key = `nfl:v1:usage:${new Date().toISOString().slice(0, 7)}`;
  let count;
  try {
    count = await redis.incr(key);
    if (count === 1) await redis.expire(key, COUNTER_TTL_S);
  } catch (err) {
    console.error("Usage counter unavailable, allowing the call:", err.message);
    return;
  }
  if (count > limit) {
    console.error(`Upstream monthly limit reached (${limit}), refusing the call`);
    throw new HttpError(503, "upstream_budget_exhausted", "Monthly upstream API limit reached, only cached data is available", {"Retry-After": "3600"});
  }
}

module.exports = {reserveUpstreamCall};
