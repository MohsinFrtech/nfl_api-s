const {getRedis} = require("./redis");
const {HttpError} = require("./errors");

const DEFAULT_LIMIT_PER_MIN = 60;
const WINDOW_S = 60;

// On Vercel the platform sets these headers itself, so the first address is the real client.
function clientIp(req) {
  const header = req.get("x-vercel-forwarded-for") || req.get("x-forwarded-for") || "";
  return header.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

// Fixed one-minute window per client IP, counted in Redis so every instance shares it.
// Without Redis, or if Redis fails, requests are allowed: a Redis outage must not take the API down.
async function rateLimit(req, res, next) {
  const redis = getRedis();
  if (!redis) return next();
  const limit = Number(process.env.RATE_LIMIT_PER_MIN) || DEFAULT_LIMIT_PER_MIN;
  const nowS = Math.floor(Date.now() / 1000);
  const windowId = Math.floor(nowS / WINDOW_S);
  const key = `nfl:v1:rl:${clientIp(req)}:${windowId}`;
  let count;
  try {
    count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_S * 2);
  } catch (err) {
    console.error("Rate limiter unavailable, allowing the request:", err.message);
    return next();
  }
  if (count > limit) {
    const retryAfter = (windowId + 1) * WINDOW_S - nowS;
    return next(new HttpError(429, "rate_limited", "Too many requests, please slow down", {"Retry-After": String(retryAfter)}));
  }
  next();
}

module.exports = {rateLimit, clientIp};
