const {getRedis} = require("./redis");

const LOCK_TTL_MS = 30 * 1000; // longer than the slowest upstream call, so a crashed holder can't block for long

// Lets one instance fetch a missing key while the others wait for its result, so a cache
// expiring under load costs one upstream call instead of one per instance. Without Redis,
// or if it fails, every caller just proceeds.
async function acquire(key) {
  const redis = getRedis();
  if (!redis) return true;
  try {
    return (await redis.set(`nfl:v1:lock:${key}`, "1", {nx: true, px: LOCK_TTL_MS})) === "OK";
  } catch (err) {
    console.error("Redis lock failed:", err.message);
    return true;
  }
}

async function release(key) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`nfl:v1:lock:${key}`);
  } catch (err) {
    console.error("Redis unlock failed:", err.message);
  }
}

module.exports = {acquire, release};
