// Two-level TTL cache: per-instance memory in front, Redis (shared by every instance, survives
// restarts) behind it when configured. Redis errors are logged and treated as misses so the
// app keeps working on memory alone.
const {getRedis} = require("./redis");

const PREFIX = "nfl:v1:"; // bump the version to ignore every stored entry after a data-shape change
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_MS = 60 * 60 * 1000;
const memory = new Map(); // key -> {value, expiresAt}

async function readRedis(key) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(PREFIX + key);
    if (raw === null || raw === undefined) return null;
    const stored = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {value: stored.v, expiresAt: stored.e};
  } catch (err) {
    console.error("Redis read failed:", err.message);
    return null;
  }
}

async function get(key) {
  const entry = memory.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  // Memory is empty or expired: another instance may have refreshed it.
  const stored = await readRedis(key);
  if (!stored) return undefined;
  memory.set(key, stored);
  return stored.expiresAt > Date.now() ? stored.value : undefined;
}

// Expired-but-recent value, used when the upstream API is failing.
async function getStale(key) {
  const entry = memory.get(key);
  if (entry) return entry.value;
  const stored = await readRedis(key);
  return stored ? stored.value : undefined;
}

async function set(key, value, ttlMs) {
  const expiresAt = Date.now() + ttlMs;
  memory.set(key, {value, expiresAt});
  const redis = getRedis();
  if (!redis) return;
  try {
    // Kept for MAX_STALE_MS past expiry so it can still be served if upstream fails.
    await redis.set(PREFIX + key, JSON.stringify({v: value, e: expiresAt}), {ex: Math.ceil((ttlMs + MAX_STALE_MS) / 1000)});
  } catch (err) {
    console.error("Redis write failed:", err.message);
  }
}

// Milliseconds until the entry expires (0 if missing or already expired).
function remainingMs(key) {
  const entry = memory.get(key);
  return entry ? Math.max(entry.expiresAt - Date.now(), 0) : 0;
}

// For tests: forget this instance's memory, as a fresh serverless instance would.
function clearMemory() {
  memory.clear();
}

const timer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memory) {
    if (entry.expiresAt + MAX_STALE_MS <= now) memory.delete(key);
  }
}, CLEANUP_MS);
timer.unref();

module.exports = {get, getStale, set, remainingMs, clearMemory};
