// Hold a new Upptime outage until the same check fails twice, 120s apart.
//
// Upptime v1.46 opens a down/degraded issue after its own retries (2s, then
// 10s). That still falls inside a 60–90s deploy. This gate probes first and
// runs Upptime only when a new failure is still present after CONFIRM_GAP_MS.
// Recovery is not delayed: an already-down check, or a check that is up, goes
// straight to Upptime so an open issue still closes on the next healthy probe.
//
// ponytail: Upptime checks every site in one shot, and this script does not
// persist streaks between runs. A check that fails only on the second probe can
// ride along if another check failed twice. A failure that starts after this
// round already returned up can still be recorded by Upptime in the same run.
// Upgrade path: store per-check streaks and skip Upptime until that check has
// two failures of its own.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Longer than a 60–90s deploy, shorter than the 5-minute schedule. */
export const CONFIRM_GAP_MS = 120_000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY_BYTES = 1_000_000;

const DEFAULT_EXPECTED_STATUS_CODES = [
  200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300, 301, 302, 303, 304, 305,
  306, 307, 308,
];

function parseScalar(raw) {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseScalar(part));
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * ponytail: line parser for the flat site list in this repo's .upptimerc.yml.
 * Multiline values are not supported; keep each site field on one line.
 */
export function parseSites(yamlText) {
  const sites = [];
  let inSites = false;
  let site = null;
  let listKey = null;

  const pushSite = () => {
    if (!site) return;
    if (!site.slug || !/^[a-z0-9][a-z0-9-]*$/.test(site.slug)) {
      throw new Error(`site ${site.name || "(unnamed)"} has a missing or unsafe slug`);
    }
    sites.push(site);
    site = null;
    listKey = null;
  };

  for (const line of yamlText.replace(/\r\n/g, "\n").split("\n")) {
    if (!inSites) {
      if (line.trim() === "sites:") inSites = true;
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const siteStart = line.match(/^ {2}- ([^:]+):\s*(.*)$/);
    if (siteStart) {
      pushSite();
      site = {};
      listKey = null;
      site[siteStart[1].trim()] = parseScalar(siteStart[2]);
      continue;
    }
    if (!site) continue;

    const listItem = line.match(/^ {6}- (.*)$/);
    if (listItem && listKey) {
      const items = site[listKey] || [];
      items.push(parseScalar(listItem[1]));
      site[listKey] = items;
      continue;
    }

    const field = line.match(/^ {4}([^:]+):\s*(.*)$/);
    if (field) {
      const key = field[1].trim();
      if (field[2].trim() === "") {
        listKey = key;
        site[key] = [];
      } else {
        listKey = null;
        site[key] = parseScalar(field[2]);
      }
      continue;
    }

    if (/^\S/.test(line)) break;
  }

  pushSite();
  if (!sites.length) throw new Error("no sites in .upptimerc.yml");
  return sites;
}

export function readRecordedStatus(yamlText) {
  const match = String(yamlText).match(/^status:\s*(\S+)/m);
  if (match && (match[1] === "down" || match[1] === "degraded")) return match[1];
  return "up";
}

/** Same up/down/degraded rules as Upptime's getStatusFromHttpResult. */
export function classifyHttpResult(site, httpCode, body, responseTimeMs) {
  const expected = (
    site.expectedStatusCodes?.length
      ? site.expectedStatusCodes
      : DEFAULT_EXPECTED_STATUS_CODES
  ).map(Number);
  const timeMs = Number(responseTimeMs);
  const responseTime = Number.isFinite(timeMs) && timeMs > 0 ? timeMs : 0;
  let status = expected.includes(Number(httpCode)) ? "up" : "down";
  if (responseTime > (site.maxResponseTime ?? 60000)) status = "degraded";

  const text = typeof body === "string" ? body : "";
  if (status === "up") {
    if (site.__dangerous__body_down && text.includes(site.__dangerous__body_down)) {
      status = "down";
    }
    if (site.__dangerous__body_degraded && text.includes(site.__dangerous__body_degraded)) {
      status = "degraded";
    }
  }
  if (
    site.__dangerous__body_degraded_if_text_missing &&
    !text.includes(site.__dangerous__body_degraded_if_text_missing)
  ) {
    status = "degraded";
  }
  if (
    site.__dangerous__body_down_if_text_missing &&
    !text.includes(site.__dangerous__body_down_if_text_missing)
  ) {
    status = "down";
  }
  if (site.__dangerous__body_down_if_regex_missing) {
    const pattern = new RegExp(site.__dangerous__body_down_if_regex_missing);
    if (!pattern.test(text)) status = "down";
  }
  return status;
}

function isNewFailure(slug, status, recordedStatus) {
  return status !== "up" && (recordedStatus[slug] || "up") === "up";
}

/**
 * @returns {{ runUpptime: boolean, sleep: boolean, reason: string }}
 */
export function planUpptime({ round1, round2, recordedStatus }) {
  const recorded = recordedStatus || {};
  const round1New = round1.filter((probe) => isNewFailure(probe.slug, probe.status, recorded));
  if (round1New.length === 0) {
    return { runUpptime: true, sleep: false, reason: "no-new-failure" };
  }
  if (!round2) {
    return { runUpptime: false, sleep: true, reason: "needs-confirmation" };
  }

  const failedFirst = new Set(round1New.map((probe) => probe.slug));
  const round2Status = new Map(round2.map((probe) => [probe.slug, probe.status]));
  const stillFailing = [...failedFirst].filter((slug) => round2Status.get(slug) !== "up");
  const failedOnlyOnSecondProbe = round2.filter(
    (probe) => isNewFailure(probe.slug, probe.status, recorded) && !failedFirst.has(probe.slug),
  );

  if (stillFailing.length === 0 && failedOnlyOnSecondProbe.length === 0) {
    return { runUpptime: true, sleep: false, reason: "recovered" };
  }
  if (stillFailing.length === 0) {
    return { runUpptime: false, sleep: false, reason: "unconfirmed-second-probe" };
  }
  return { runUpptime: true, sleep: false, reason: "confirmed" };
}

export async function resolveGate({ round1, recordedStatus, probeAgain, sleep }) {
  const first = planUpptime({ round1, round2: null, recordedStatus });
  if (!first.sleep) return first;
  await sleep(CONFIRM_GAP_MS);
  const round2 = await probeAgain();
  return planUpptime({ round1, round2, recordedStatus });
}

function runCurl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export async function probeSite(site) {
  const url = String(site.url || "");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`refusing non-http url for ${site.slug}`);
  }

  const bodyPath = join(
    tmpdir(),
    `outage-gate-${process.pid}-${site.slug}-${randomBytes(4).toString("hex")}`,
  );
  const args = [
    "--silent",
    "--show-error",
    "--output",
    bodyPath,
    "--write-out",
    "%{http_code} %{time_total}",
    "--connect-timeout",
    String(site.connectTimeout ?? 30),
    "--max-time",
    String(site.requestTimeout ?? 60),
    "--retry",
    "0",
    "-X",
    String(site.method || "GET"),
  ];
  const maxRedirects = Number.isInteger(site.maxRedirects) ? site.maxRedirects : 3;
  if (maxRedirects > 0) {
    args.push("--location", "--max-redirs", String(maxRedirects));
  }
  for (const header of site.headers || []) args.push("-H", String(header));
  args.push(url);

  try {
    const result = await runCurl(args);
    let body = "";
    try {
      const bytes = readFileSync(bodyPath);
      body =
        bytes.length > MAX_BODY_BYTES
          ? bytes.subarray(0, MAX_BODY_BYTES).toString("utf8")
          : bytes.toString("utf8");
    } catch {
      body = "";
    }

    const summary = result.stdout.trim();
    const match = summary.match(/^(\d{3})\s+([0-9.]+)$/);
    const httpCode = match ? Number(match[1]) : 0;
    const responseTimeMs = match ? Math.round(Number(match[2]) * 1000) : 0;
    if (!match && result.stderr) {
      console.log(
        `${site.slug}: curl exit ${result.code}: ${result.stderr.trim().slice(0, 300)}`,
      );
    }
    const status = classifyHttpResult(site, httpCode, body, responseTimeMs);
    return { slug: site.slug, status, httpCode, responseTimeMs };
  } finally {
    rmSync(bodyPath, { force: true });
  }
}

function loadRecordedStatus(sites) {
  const recordedStatus = {};
  for (const site of sites) {
    let yaml = "";
    try {
      yaml = readFileSync(join(ROOT, "history", `${site.slug}.yml`), "utf8");
    } catch {
      yaml = "";
    }
    recordedStatus[site.slug] = readRecordedStatus(yaml);
  }
  return recordedStatus;
}

function logRound(label, probes) {
  for (const probe of probes) {
    console.log(
      `${label} ${probe.slug}: ${probe.status} (HTTP ${probe.httpCode} in ${probe.responseTimeMs} ms)`,
    );
  }
}

function writeGitHubOutput(runUpptime) {
  if (!process.env.GITHUB_OUTPUT) return;
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    `run_upptime=${runUpptime ? "true" : "false"}\n`,
    { flag: "a" },
  );
}

async function main() {
  const sites = parseSites(readFileSync(join(ROOT, ".upptimerc.yml"), "utf8"));
  const recordedStatus = loadRecordedStatus(sites);
  const round1 = await Promise.all(sites.map((site) => probeSite(site)));
  logRound("first", round1);

  const decision = await resolveGate({
    round1,
    recordedStatus,
    probeAgain: async () => {
      const round2 = await Promise.all(sites.map((site) => probeSite(site)));
      logRound("second", round2);
      return round2;
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        console.log(`new failure; probing again in ${Math.round(ms / 1000)}s`);
        setTimeout(resolve, ms);
      }),
  });

  console.log(`outage gate: ${decision.reason}; run Upptime=${decision.runUpptime}`);
  writeGitHubOutput(decision.runUpptime);
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
