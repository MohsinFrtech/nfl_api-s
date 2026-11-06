const {getRedis} = require("./redis");

const COOLDOWN_MS = 2 * 60 * 1000;
const KEY = "nfl:v1:upstream-cooldown";

let coolUntil = 0; // per-instance copy, so a cooling instance doesn't ask Redis on every call

// How long the upstream API should be left alone after a failure (0 = free to call). The pause lives in
// Redis so every instance shares it; without Redis, or if it fails, each instance pauses on its own.
async function cooldownLeftMs() {
  const now = Date.now();
  if (coolUntil > now) return coolUntil - now;
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const left = await redis.pttl(KEY);
    if (left > 0) {
      coolUntil = now + left;
      return left;
    }
  } catch (err) {
    console.error("Cooldown check failed:", err.message);
  }
  return 0;
}

// Called when the upstream API failed (down, timing out, rate limited, rejecting our key), so the next
// calls are skipped instead of each retrying and spending the monthly budget on a failing service.
async function startCooldown() {
  coolUntil = Date.now() + COOLDOWN_MS;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(KEY, "1", {px: COOLDOWN_MS});
  } catch (err) {
    console.error("Cooldown save failed:", err.message);
  }
}

module.exports = {cooldownLeftMs, startCooldown};
