import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'rally-demo-simulation-'));
process.env.DATABASE_PATH = join(directory, 'production.sqlite');
process.env.DEMO_DIR = join(directory, 'demos');
const { createDemoWorkspace, withDemo, resetDemoWorkspace } =
  await import('../src/lib/demo-workspaces.ts');
const { sqlite } = await import('../src/db/index.ts');
const {
  startDemoSimulation,
  advanceDemoSimulation,
  pauseDemoSimulation,
  demoSimulationState,
  stopDemoSimulation,
  triggerDemoReview,
  submitDemoPoint,
  DEMO_POWER_HOUR_PASSWORD,
  joinDemoParticipant,
} = await import('../src/lib/demo-simulation.ts');
const store = await import('../src/lib/store.ts');
const { PowerHourSubmissionTracker } = await import('../src/lib/power-hour-submissions.ts');
const originalNow = Date.now;
after(() => {
  Date.now = originalNow;
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});
function scores(id: string) {
  return withDemo(id, () => store.sessionScores(store.sessionState()!.id));
}

test('simulation is isolated, idempotent, safely scored, paused, reviewable and archived', () => {
  let now = originalNow();
  Date.now = () => now;
  const first = createDemoWorkspace();
  const other = createDemoWorkspace();
  startDemoSimulation(first.id);
  assert.equal(withDemo(other.id, store.activeSession), null);
  assert.equal(scores(first.id).length, 1);
  const start = now;
  for (let second = 1; second <= 80; second++) {
    now = start + second * 1000;
    advanceDemoSimulation(first.id);
  }
  assert.equal(scores(first.id).length, 8);
  assert.ok(scores(first.id).every((score) => !score.flagged));
  const before = scores(first.id);
  advanceDemoSimulation(first.id);
  assert.deepEqual(scores(first.id), before);
  pauseDemoSimulation(first.id, true);
  for (let second = 81; second <= 100; second++) {
    now = start + second * 1000;
    advanceDemoSimulation(first.id);
  }
  assert.deepEqual(scores(first.id), before);
  assert.deepEqual(demoSimulationState(first.id), { running: true, paused: true });
  pauseDemoSimulation(first.id, false);
  advanceDemoSimulation(first.id);
  assert.deepEqual(scores(first.id), before, 'resume must not replay paused points');
  now += 1000;
  triggerDemoReview(first.id);
  assert.equal(scores(first.id).find((score) => score.name === 'Alex Demo')!.flagged, true);
  now = start + 301000;
  withDemo(first.id, () =>
    sqlite
      .prepare("UPDATE power_hour_sessions SET ends_at = ? WHERE status = 'active'")
      .run(new Date(originalNow() - 1000).toISOString()),
  );
  advanceDemoSimulation(first.id);
  assert.equal(demoSimulationState(first.id).running, false);
  assert.equal(
    withDemo(first.id, store.getArchives).length,
    2,
    'sample archive and completed demo remain',
  );
  stopDemoSimulation(first.id);
  resetDemoWorkspace(first.id);
  assert.deepEqual(demoSimulationState(first.id), { running: false, paused: false });
});

test('long interruption discards overdue submissions instead of catch-up bursts', () => {
  let now = originalNow();
  Date.now = () => now;
  const workspace = createDemoWorkspace();
  startDemoSimulation(workspace.id);
  now += 120000;
  advanceDemoSimulation(workspace.id);
  assert.equal(scores(workspace.id).length, 8);
  assert.ok(scores(workspace.id).every((score) => score.clicks <= 1 && !score.flagged));
  stopDemoSimulation(workspace.id);
});

test('entire five-minute schedule stays below review threshold and has lead changes', () => {
  let now = originalNow();
  Date.now = () => now;
  const workspace = createDemoWorkspace();
  startDemoSimulation(workspace.id);
  const start = now;
  for (let second = 1; second < 300; second++) {
    now = start + second * 1000;
    advanceDemoSimulation(workspace.id);
    assert.ok(
      scores(workspace.id).every((score) => !score.flagged),
      `flag at ${second}`,
    );
    if (second === 60) assert.equal(scores(workspace.id)[0].name, 'Alex Demo');
  }
  assert.equal(scores(workspace.id)[0].name, 'Jordan Demo');
  assert.equal(scores(workspace.id).find((score) => score.name === 'Taylor Demo')!.clicks, 25);
  stopDemoSimulation(workspace.id);
});

test('real visitors use persisted shared rate limits and rolling review rules', () => {
  let now = originalNow();
  Date.now = () => now;
  const workspace = createDemoWorkspace();
  startDemoSimulation(workspace.id);
  const member = withDemo(workspace.id, () =>
    store.joinSession(store.activeSession()!.id, DEMO_POWER_HOUR_PASSWORD, 'Visitor'),
  );
  for (let index = 0; index < 10; index++) {
    now += 1100;
    submitDemoPoint(workspace.id, member.userId, member.sessionId);
  }
  assert.equal(scores(workspace.id).find((score) => score.name === 'Visitor')!.flagged, false);
  now += 1100;
  submitDemoPoint(workspace.id, member.userId, member.sessionId);
  assert.equal(scores(workspace.id).find((score) => score.name === 'Visitor')!.flagged, true);
  now += 1100;
  for (let index = 0; index < 15; index++)
    submitDemoPoint(workspace.id, member.userId, member.sessionId);
  assert.throws(() => submitDemoPoint(workspace.id, member.userId, member.sessionId), /Tap limit/);
  const tracker = new PowerHourSubmissionTracker();
  withDemo(workspace.id, () => {
    for (let index = 0; index < 15; index++) tracker.submit(member.userId, member.sessionId, now);
    assert.throws(() => tracker.submit(member.userId, member.sessionId, now), /Tap limit/);
  });
  stopDemoSimulation(workspace.id);
});

test('audience names and seats cannot block staggered simulated participants', () => {
  let now = originalNow();
  Date.now = () => now;
  const workspace = createDemoWorkspace();
  startDemoSimulation(workspace.id);
  const sessionId = withDemo(workspace.id, () => store.activeSession()!.id);
  assert.throws(() => joinDemoParticipant(workspace.id, sessionId, 'jOrDaN dEmO'), /reserved/);
  const members = Array.from({ length: 12 }, (_, index) =>
    joinDemoParticipant(workspace.id, sessionId, `Audience ${index}`),
  );
  assert.throws(
    () => joinDemoParticipant(workspace.id, sessionId, 'Extra audience'),
    /12 audience/,
  );
  assert.equal(
    joinDemoParticipant(workspace.id, sessionId, members[0].name, members[0].token).userId,
    members[0].userId,
  );
  now += 15000;
  advanceDemoSimulation(workspace.id);
  const participants = withDemo(workspace.id, () => store.sessionParticipants(sessionId));
  assert.equal(participants.length, 20);
  assert.equal(participants.filter((member) => member.name.endsWith(' Demo')).length, 8);
  stopDemoSimulation(workspace.id);
});

test('extended Power Hours continue safe simulated activity beyond five minutes', () => {
  let now = originalNow();
  Date.now = () => now;
  const workspace = createDemoWorkspace();
  startDemoSimulation(workspace.id);
  withDemo(workspace.id, () => store.extendSession({ duration_minutes: 1 }));
  const start = now;
  for (let second = 1; second <= 299; second++) {
    now = start + second * 1000;
    advanceDemoSimulation(workspace.id);
  }
  const previous = scores(workspace.id);
  for (let second = 300; second < 360; second++) {
    now = start + second * 1000;
    advanceDemoSimulation(workspace.id);
    assert.ok(scores(workspace.id).every((score) => !score.flagged));
  }
  for (const participant of previous) {
    assert.ok(
      scores(workspace.id).find((score) => score.userId === participant.userId)!.clicks >
        participant.clicks,
    );
  }
  assert.equal(demoSimulationState(workspace.id).running, true);
  withDemo(workspace.id, () =>
    sqlite
      .prepare("UPDATE power_hour_sessions SET ends_at = ? WHERE status = 'active'")
      .run(new Date(originalNow() - 1000).toISOString()),
  );
  advanceDemoSimulation(workspace.id);
  assert.equal(demoSimulationState(workspace.id).running, false);
  stopDemoSimulation(workspace.id);
});
