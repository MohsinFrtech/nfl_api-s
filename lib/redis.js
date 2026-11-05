const {Redis} = require("@upstash/redis");

// Upstash Redis (Vercel Marketplace) is optional: without its env vars the app runs on its
// per-instance memory cache only. Vercel injects UPSTASH_REDIS_REST_* (or KV_REST_API_* on older stores).
let client;

function getRedis() {
  if (client === undefined) {
    const {UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, KV_REST_API_URL, KV_REST_API_TOKEN} = process.env;
    const url = UPSTASH_REDIS_REST_URL || KV_REST_API_URL;
    const token = UPSTASH_REDIS_REST_TOKEN || KV_REST_API_TOKEN;
    client = url && token ? new Redis({url, token}) : null;
  }
  return client;
}

// For tests: swap in a fake client (or null to disable).
function setRedis(next) {
  client = next;
}

module.exports = {getRedis, setRedis};
