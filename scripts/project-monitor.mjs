// Three independent public probes, one incident per outage window. No paid service.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { CONFIRM_GAP_MS, parseSites, probeSite, readRecordedStatus } from './outage-gate.mjs';

export const INCIDENT_MARKER = '<!-- news-project-incident:v1 -->';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLUGS = ['health', 'news', 'stats'];

export function needsConfirmation(previous, first, active) {
  complete(previous); complete(first);
  return first.some(p => p.status !== 'up') || previous.some(p => p.status !== 'up') ||
    active.some(i => i.body?.includes(INCIDENT_MARKER));
}

function complete(checks) {
  if (!Array.isArray(checks) || checks.length !== SLUGS.length ||
      SLUGS.some(slug => checks.filter(p => p.slug === slug && ['up', 'down', 'degraded'].includes(p.status)).length !== 1)) {
    throw new Error('incomplete public check results; preserving incident');
  }
  return new Map(checks.map(p => [p.slug, p]));
}

export function confirmChecks(previous, first, second) {
  const before = complete(previous), one = complete(first), two = complete(second);
  return SLUGS.map(slug => {
    const a = one.get(slug), b = two.get(slug);
    // Two failures confirm a fault; two successes confirm recovery. A mixed
    // pair retains this endpoint's last confirmed status, never another's.
    const status = a.status === 'up' && b.status === 'up' ? 'up' :
      a.status !== 'up' && b.status !== 'up' ? b.status : before.get(slug).status;
    return { ...b, status, observedStatus: b.status };
  });
}

export function incidentChange(checks, issues, now, { recoveryConfirmed = false } = {}) {
  complete(checks);
  const managed = issues.filter(i => typeof i.body === 'string' && i.body.includes(INCIDENT_MARKER));
  const open = managed.filter(i => i.state === 'open');
  if (open.length > 1) throw new Error('multiple managed incidents; operator review required');
  const failed = checks.some(p => p.status !== 'up');
  const recent = managed.filter(i => i.state === 'closed' &&
    now - Date.parse(i.closed_at) >= 0 && now - Date.parse(i.closed_at) < 30 * 60_000)
    .sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at))[0];
  const issue = open[0] || (failed ? recent : undefined);
  if (!failed && !issue) return null;
  // The Issue update and Git push are separate operations. Saved all-up JSON
  // may predate an open incident; only this run's two good rounds can close it.
  if (!failed && open.length && recoveryConfirmed !== true) return null;
  const body = `${INCIDENT_MARKER}\n\n${failed ? '站点部分接口异常，已分别复探确认。' : '所有接口已连续两次恢复正常。'}\n\n` +
    '| 接口 | 已确认状态 | 最近 HTTP | 最近耗时 ms |\n| --- | --- | --- | --- |\n' +
    checks.map(p => `| ${p.slug} | ${p.status} | ${p.httpCode} | ${p.responseTimeMs} |`).join('\n') +
    '\n\n同一窗口合并为此事件；恢复需间隔 120 秒的两次正常探测，30 分钟内复发重开原事件。' +
    '\n仅为离散外部样本，不表示持续停机；各次执行时间与原始状态见 Actions 日志。';
  if (issue && issue.body === body && issue.state === (failed ? 'open' : 'closed')) return null;
  return {
    method: issue ? 'PATCH' : 'POST', path: issue ? `/issues/${issue.number}` : '/issues',
    body: { title: failed ? '⚠️ 讯流站点接口异常（合并事件）' : '✅ 讯流站点接口已恢复（合并事件）',
      body, state: failed ? 'open' : 'closed', ...(issue ? {} : { labels: ['status', 'project-monitor'] }) },
  };
}

async function github(path, method = 'GET', body, accepted = [200, 201]) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo !== 'bazz1111/news-openx-status' || !process.env.GH_TOKEN) throw new Error('monitor repository/token missing');
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method, signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
  });
  if (!accepted.includes(response.status)) throw new Error(`GitHub incident request failed: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const sites = parseSites(readFileSync(join(ROOT, '.upptimerc.yml'), 'utf8'));
  if (sites.length !== SLUGS.length || SLUGS.some(slug => !sites.some(s => s.slug === slug))) throw new Error('unexpected monitor sites');
  const statePath = join(ROOT, 'history/project.json');
  const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const previous = saved ? saved.checks : sites.map(site => {
    const path = join(ROOT, 'history', `${site.slug}.yml`);
    return { slug: site.slug, status: readRecordedStatus(existsSync(path) ? readFileSync(path, 'utf8') : '') };
  });
  complete(previous);
  // Query open incidents separately: a burst of unrelated closed issues must
  // never make an active incident disappear from a finite history page.
  const active = await github('/issues?state=open&labels=project-monitor&per_page=100');
  const closed = await github('/issues?state=closed&labels=project-monitor&sort=updated&direction=desc&per_page=30');
  const first = await Promise.all(sites.map(probeSite));
  console.log('first', JSON.stringify(first));
  const needsSecond = needsConfirmation(previous, first, active);
  let checks = first;
  let recoveryConfirmed = false;
  if (needsSecond) {
    console.log(`Confirming each endpoint after ${CONFIRM_GAP_MS / 1000}s`);
    await sleep(CONFIRM_GAP_MS);
    const second = await Promise.all(sites.map(probeSite));
    console.log('second', JSON.stringify(second));
    checks = confirmChecks(previous, first, second);
    recoveryConfirmed = first.every(p => p.status === 'up') && second.every(p => p.status === 'up');
  }
  for (const p of checks) console.log(`${p.slug}: confirmed=${p.status}, observed=${p.observedStatus || p.status}, HTTP=${p.httpCode}, ms=${p.responseTimeMs}`);
  const change = incidentChange(checks, [...active, ...closed], Date.now(), { recoveryConfirmed });
  if (change) {
    if (change.method === 'POST') await github('/labels', 'POST', {
      name: 'project-monitor', color: 'd97706', description: 'One confirmed incident for the news project',
    }, [201, 422]); // An existing label is harmless; the issue request still must succeed.
    await github(change.path, change.method, change.body);
  }
  const incidentOpen = checks.some(p => p.status !== 'up') ||
    (active.some(i => i.body?.includes(INCIDENT_MARKER)) && !recoveryConfirmed);
  const changed = saved?.incident_open !== incidentOpen || checks.some(p => previous.find(old => old.slug === p.slug).status !== p.status);
  if (!existsSync(statePath) || changed || process.env.RECORD_SAMPLE === 'true') {
    writeFileSync(statePath, JSON.stringify({ schema: 1, checked_at: new Date().toISOString(), incident_open: incidentOpen, checks }, null, 2) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
