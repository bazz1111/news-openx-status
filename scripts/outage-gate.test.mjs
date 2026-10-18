import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONFIRM_GAP_MS,
  classifyHttpResult,
  parseSites,
  planUpptime,
  probeSite,
  readRecordedStatus,
  resolveGate,
} from "./outage-gate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sites = parseSites(readFileSync(join(root, ".upptimerc.yml"), "utf8"));
const bySlug = Object.fromEntries(sites.map((site) => [site.slug, site]));

const liveBodies = {
  health: '{"mode":"live","status":"ok"}',
  news: '{"mode":"live","items":[],"total":0}',
  stats: '{"mode":"live","hourly":[],"total":0}',
};

describe("config", () => {
  test("keeps the three public checks and waits out a 90s deploy", () => {
    assert.deepEqual(
      sites.map((site) => site.slug),
      ["health", "news", "stats"],
    );
    assert.equal(bySlug.health.url, "https://news.openx.ccwu.cc/api/health");
    assert.equal(bySlug.news.url, "https://news.openx.ccwu.cc/api/news?limit=1");
    assert.equal(bySlug.stats.url, "https://news.openx.ccwu.cc/api/stats");
    assert.equal(bySlug.health.maxRedirects, 0);
    assert.equal(bySlug.health.maxResponseTime, 5000);
    assert.deepEqual(bySlug.health.expectedStatusCodes, [200]);
    assert.deepEqual(bySlug.health.headers, [
      "User-Agent: news-openx-status/1.0 (+https://github.com/bazz1111/news-openx-status)",
      "Accept: application/json",
    ]);
    assert.ok(CONFIRM_GAP_MS > 90_000);
    assert.ok(CONFIRM_GAP_MS < 5 * 60 * 1000);
  });

  test("workflow still schedules the same crons and vetoes Upptime explicitly", () => {
    const workflow = readFileSync(join(root, ".github/workflows/uptime.yml"), "utf8");
    assert.match(workflow, /cron: '\*\/5 \* \* \* \*'/);
    assert.match(workflow, /cron: '17 \*\/6 \* \* \*'/);
    assert.match(workflow, /node scripts\/outage-gate\.mjs/);
    assert.match(workflow, /steps\.outage-gate\.outputs\.run_upptime != 'false'/);
  });
});

describe("classifyHttpResult", () => {
  test("matches the live-mode body rules", () => {
    for (const slug of ["health", "news", "stats"]) {
      assert.equal(classifyHttpResult(bySlug[slug], 200, liveBodies[slug], 100), "up");
      assert.equal(classifyHttpResult(bySlug[slug], 200, '{"mode":"off"}', 100), "down");
    }
  });

  test("follows Upptime: slow responses are degraded, then a missing body match is down", () => {
    const health = bySlug.health;
    assert.equal(classifyHttpResult(health, 200, liveBodies.health, 5000), "up");
    assert.equal(classifyHttpResult(health, 200, liveBodies.health, 5001), "degraded");
    assert.equal(classifyHttpResult(health, 200, '{"mode":"off"}', 5001), "down");
    assert.equal(classifyHttpResult(health, 503, liveBodies.health, 100), "down");
    assert.equal(classifyHttpResult(health, 503, liveBodies.health, 9000), "degraded");
    assert.equal(classifyHttpResult(health, 0, "", 0), "down");
  });
});

describe("planUpptime", () => {
  const up = (slug) => ({ slug, status: "up" });
  const down = (slug) => ({ slug, status: "down" });

  test("a single new failure does not open an issue", () => {
    const decision = planUpptime({
      round1: [down("health"), up("news"), up("stats")],
      round2: null,
      recordedStatus: { health: "up", news: "up", stats: "up" },
    });
    assert.equal(decision.sleep, true);
    assert.equal(decision.runUpptime, false);
  });

  test("a failure that is still present on the second probe may open an issue", () => {
    const decision = planUpptime({
      round1: [down("health"), up("news")],
      round2: [down("health"), up("news")],
      recordedStatus: { health: "up", news: "up" },
    });
    assert.equal(decision.reason, "confirmed");
    assert.equal(decision.runUpptime, true);
  });

  test("a failure that recovers before the second probe does not open an issue", () => {
    const decision = planUpptime({
      round1: [down("health")],
      round2: [up("health")],
      recordedStatus: { health: "up" },
    });
    assert.equal(decision.reason, "recovered");
    assert.equal(decision.runUpptime, true);
  });

  test("an already-down check is rechecked immediately so recovery can close the issue", () => {
    const ongoing = planUpptime({
      round1: [down("health")],
      round2: null,
      recordedStatus: { health: "down" },
    });
    assert.equal(ongoing.reason, "no-new-failure");
    assert.equal(ongoing.runUpptime, true);

    const recovered = planUpptime({
      round1: [up("health")],
      round2: null,
      recordedStatus: { health: "down" },
    });
    assert.equal(recovered.runUpptime, true);
    assert.equal(recovered.sleep, false);
  });

  test("a check that fails only on the second probe is not enough to run Upptime", () => {
    const decision = planUpptime({
      round1: [down("health"), up("news")],
      round2: [up("health"), down("news")],
      recordedStatus: { health: "up", news: "up" },
    });
    assert.equal(decision.reason, "unconfirmed-second-probe");
    assert.equal(decision.runUpptime, false);
  });

  test("degraded is a failure that needs the same confirmation", () => {
    const decision = planUpptime({
      round1: [{ slug: "stats", status: "degraded" }],
      round2: null,
      recordedStatus: { stats: "up" },
    });
    assert.equal(decision.sleep, true);
  });
});

describe("resolveGate", () => {
  test("waits once, then confirms only if the same check is still failing", async () => {
    const sleeps = [];
    const confirmed = await resolveGate({
      round1: [{ slug: "health", status: "down" }],
      recordedStatus: { health: "up" },
      probeAgain: async () => [{ slug: "health", status: "down" }],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.deepEqual(sleeps, [CONFIRM_GAP_MS]);
    assert.equal(confirmed.reason, "confirmed");

    const recovered = await resolveGate({
      round1: [{ slug: "health", status: "down" }],
      recordedStatus: { health: "up" },
      probeAgain: async () => [{ slug: "health", status: "up" }],
      sleep: async () => {},
    });
    assert.equal(recovered.reason, "recovered");
    assert.equal(recovered.runUpptime, true);
  });
});

describe("readRecordedStatus", () => {
  test("treats a missing or up history as up", () => {
    assert.equal(readRecordedStatus("status: up\n"), "up");
    assert.equal(readRecordedStatus(""), "up");
    assert.equal(readRecordedStatus("status: down\n"), "down");
    assert.equal(readRecordedStatus("status: degraded\n"), "degraded");
  });
});

describe("probeSite", () => {
  test("probes status, body, and timing without following redirects", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/health" });
        res.end();
        return;
      }
      if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(liveBodies.health);
        }, 80);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(liveBodies.health);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    try {
      const site = {
        ...bySlug.health,
        url: `${base}/health`,
        connectTimeout: 2,
        requestTimeout: 2,
      };
      const ok = await probeSite(site);
      assert.equal(ok.status, "up");
      assert.equal(ok.httpCode, 200);

      const redirected = await probeSite({ ...site, url: `${base}/redirect` });
      assert.equal(redirected.httpCode, 302);
      assert.equal(redirected.status, "down");

      const slow = await probeSite({
        ...site,
        url: `${base}/slow`,
        maxResponseTime: 20,
      });
      assert.equal(slow.status, "degraded");
      assert.ok(slow.responseTimeMs >= 20);
    } finally {
      server.close();
    }
  });
});
