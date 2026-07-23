// Vercel Serverless Function — GET/POST /api/scores
// Shared leaderboard backed by Upstash Redis via the REDIS_URL connection string.

import Redis from "ioredis";

const KEY = "board";
const MAX = 100; // keep the top 100 runs

let client;
function getClient() {
  if (!process.env.REDIS_URL) throw new Error("missing-redis-env");
  if (!client) {
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableAutoPipelining: true,
    });
  }
  return client;
}

const sortBoard = (list) =>
  list
    .slice()
    .sort(
      (a, b) =>
        b.pct - a.pct ||
        b.correct - a.correct ||
        (a.ms ?? Infinity) - (b.ms ?? Infinity) ||
        a.ts - b.ts
    );

async function readBoard() {
  const raw = await getClient().get(KEY);
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
      // Completion time in ms (tiebreaker). Null if absent/invalid so it never
      // wins a tie by accident; capped at 24h.
      let ms = Math.round(Number(body.ms));
      if (!Number.isFinite(ms) || ms <= 0) ms = null;
      else ms = Math.min(ms, 86400000);
      const entry = { name, pct, correct, total, ms, ts: Date.now() };

      const board = await readBoard();
      // One entry per player: reject a name already on the board
      // (case-insensitive, whitespace-trimmed).
      const norm = (s) => String(s).trim().toLowerCase();
      if (board.some((e) => norm(e.name) === norm(name))) {
        return res.status(409).json({
          duplicate: true,
          error: `"${name}" is already on the leaderboard. Each player posts once — use a different name if this isn't you.`,
        });
      }
      board.push(entry);
      const top = sortBoard(board).slice(0, MAX);
      await getClient().set(KEY, JSON.stringify(top));
      return res.status(200).json({ board: top, ts: entry.ts });
    }

    res.setHeader("allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (e) {
    const missing = e && e.message === "missing-redis-env";
    return res.status(500).json({
      error: missing
        ? "REDIS_URL not found. It should be provided by the Upstash integration in Vercel."
        : "Server error talking to the leaderboard store.",
    });
  }
}
