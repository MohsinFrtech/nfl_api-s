const cache = require("./cache");
const lock = require("./lock");

const inflight = new Map(); // key -> Promise, so concurrent misses in one instance share one upstream call
const LOCK_WAIT_MS = 8000; // how long to wait for another instance that is already fetching the key
const LOCK_POLL_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOtherInstance(key) {
  for (let waited = 0; waited < LOCK_WAIT_MS; waited += LOCK_POLL_MS) {
    await sleep(LOCK_POLL_MS);
    const data = await cache.get(key);
    if (data) return data;
  }
  return undefined;
}

async function load(key, ttlMs, loader) {
  const haveLock = await lock.acquire(key);
  if (!haveLock) {
    const data = await waitForOtherInstance(key);
    if (data) return data;
    // The other instance failed or is too slow: fetch it ourselves.
  }
  try {
    const data = await loader();
    await cache.set(key, data, typeof ttlMs === "function" ? ttlMs(data) : ttlMs);
    return data;
  } finally {
    if (haveLock) await lock.release(key);
  }
}

// Returns {data, status, ttlLeftMs}: status is HIT, MISS or STALE (old data served because the loader failed);
// ttlLeftMs is how long the entry stays fresh, used to set the CDN cache time.
// ttlMs is a number, or a function of the loaded data when the cache time depends on its content.
async function cached(key, ttlMs, loader) {
  const hit = await cache.get(key);
  if (hit) return {data: hit, status: "HIT", ttlLeftMs: cache.remainingMs(key)};

  let pending = inflight.get(key);
  if (!pending) {
    pending = load(key, ttlMs, loader).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }

  try {
    const data = await pending;
    return {data, status: "MISS", ttlLeftMs: cache.remainingMs(key)};
  } catch (err) {
    const stale = await cache.getStale(key);
    if (stale) return {data: stale, status: "STALE", ttlLeftMs: 0};
    throw err;
  }
}

module.exports = {cached};
