import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmChecks, incidentChange, INCIDENT_MARKER, needsConfirmation } from './project-monitor.mjs';

const probes = (health, news = health, stats = news) => [health, news, stats].map((status, i) => ({
  slug: ['health', 'news', 'stats'][i], status, httpCode: status === 'down' ? 503 : 200, responseTimeMs: 100,
}));
const now = Date.parse('2026-10-26T00:00:00Z');
const incident = (state = 'open', age = 0) => ({
  number: 77, state, body: INCIDENT_MARKER, closed_at: new Date(now - age).toISOString(),
});

test('a single healthy round never closes previously recorded failures or a live incident', () => {
  assert.equal(needsConfirmation(probes('down'), probes('up'), []), true);
  assert.equal(needsConfirmation(probes('up'), probes('up'), [incident()]), true);
  assert.equal(needsConfirmation(probes('up'), probes('down'), []), true);
  assert.equal(needsConfirmation(probes('up'), probes('up'), []), false);
});

test('each endpoint confirms its own failure; a second-only failure cannot ride along', () => {
  const result = confirmChecks(probes('up'), probes('down', 'up', 'up'), probes('down', 'down', 'up'));
  assert.deepEqual(result.map(p => p.status), ['down', 'up', 'up']);
});

test('recovery needs two good readings; flapping keeps the original condition', () => {
  for (const rounds of [[probes('up'), probes('down')], [probes('down'), probes('up')]]) {
    assert.deepEqual(confirmChecks(probes('down'), ...rounds).map(p => p.status), ['down', 'down', 'down']);
  }
  assert.deepEqual(confirmChecks(probes('down'), probes('up'), probes('up')).map(p => p.status), ['up', 'up', 'up']);
  assert.throws(() => confirmChecks(probes('down'), probes('up'), []), /incomplete/);
});

test('all correlated endpoint failures create one incident without assignment or recovery comments', () => {
  const change = incidentChange(probes('down'), [], now);
  assert.equal(change.method, 'POST');
  assert.equal(change.path, '/issues');
  assert.ok(change.body.body.includes(INCIDENT_MARKER));
  for (const slug of ['health', 'news', 'stats']) assert.ok(change.body.body.includes(slug));
  assert.equal(change.body.assignees, undefined);
  assert.equal(incidentChange(probes('up'), [], now), null);
});

test('changes to affected endpoints update one open issue, never open another', () => {
  const issue = incident();
  const change = incidentChange(probes('down', 'up', 'degraded'), [issue], now);
  assert.equal(change.method, 'PATCH');
  assert.equal(change.path, '/issues/77');
  assert.equal(change.body.state, 'open');
  assert.ok(!change.path.endsWith('/comments'));
});

test('two confirmed recoveries close with one update; a brief recurrence reopens the same issue', () => {
  const change = incidentChange(probes('up'), [incident()], now, { recoveryConfirmed: true });
  assert.equal(change.path, '/issues/77');
  assert.equal(change.body.state, 'closed');
  assert.equal(incidentChange(probes('down'), [incident('closed', 20 * 60_000)], now).path, '/issues/77');
  assert.equal(incidentChange(probes('down'), [incident('closed', 31 * 60_000)], now).method, 'POST');
});

test('an open incident cannot close on mixed rounds even if its saved metadata was still all-up', () => {
  for (const pair of [[probes('down'), probes('up')], [probes('up'), probes('down')]]) {
    const confirmed = confirmChecks(probes('up'), ...pair);
    assert.equal(incidentChange(confirmed, [incident()], now, { recoveryConfirmed: false }), null);
  }
});

test('does not edit unrelated issues and refuses duplicate managed incidents', () => {
  const human = { ...incident(), body: 'a human status report' };
  assert.equal(incidentChange(probes('up'), [human], now), null);
  assert.throws(() => incidentChange(probes('down'), [incident(), {...incident(), number: 78}], now), /multiple/);
});
