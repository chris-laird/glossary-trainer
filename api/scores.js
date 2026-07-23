// Vercel Serverless Function — GET/POST /api/scores
// Shared leaderboard backed by Upstash Redis via its REST API (no npm deps).
//
// Reads credentials from env vars set by the Upstash/Vercel integration.
// It accepts either the Upstash names or the legacy Vercel KV names:
//   UPSTASH_REDIS_REST_URL   / UPSTASH_REDIS_REST_TOKEN
//   KV_REST_API_URL          / KV_REST_API_TOKEN

const KEY = "board";
const MAX = 100; // keep the top 100 runs

function creds() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return { url, token };
}

// Run one Redis command through the Upstash REST endpoint.
async function redis(command) {
  const { url, token } = creds();
  if (!url || !token) throw new Error("missing-redis-env");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error("redis-http-" + r.status);
  const data = await r.json();
  return data.result;
}

const sortBoard = (list) =>
  list.slice().sort((a, b) => b.pct - a.pct || b.correct - a.correct || b.ts - a.ts);

async function readBoard() {
  const raw = await redis(["GET", KEY]);
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  try {
    if (req.method === "GET") {
      return res.status(200).json(sortBoard(await readBoard()));
    }

    if (req.method === "POST") {
      const body =
        req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");

      const clampInt = (n, lo, hi) => {
        n = Math.round(Number(n));
        if (!Number.isFinite(n)) return lo;
        return Math.max(lo, Math.min(hi, n));
      };
      const name = String(body.name ?? "").trim().slice(0, 24) || "Player";
      const total = clampInt(body.total, 1, 500);
      const correct = clampInt(body.correct, 0, total);
      const pct = clampInt(body.pct, 0, 100);
      const entry = { name, pct, correct, total, ts: Date.now() };

      const board = await readBoard();
      board.push(entry);
      const top = sortBoard(board).slice(0, MAX);
      await redis(["SET", KEY, JSON.stringify(top)]);
      return res.status(200).json({ board: top, ts: entry.ts });
    }

    res.setHeader("allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (e) {
    const missing = e && e.message === "missing-redis-env";
    return res.status(500).json({
      error: missing
        ? "Redis env vars not found. Connect Upstash Redis in the Vercel Storage tab (or set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN), then redeploy."
        : "Server error talking to the leaderboard store.",
    });
  }
}
