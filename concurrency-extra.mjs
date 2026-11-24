// Run with node --test /path/to/concurrency-extra.mjs from the repository root.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { openDb } = await import(pathToFileURL(resolve('src/db.js')).href);
const workerPath = resolve('tests/server-worker.js');
const rounds = 20;

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'assignment2-extra-race-'));
  const databasePath = join(directory, 'shared.sqlite');
  const secret = randomBytes(48).toString('hex');
  const db = openDb(databasePath);
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      if (child.connected) child.send('stop');
      else child.kill();
      await exited;
    }));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function worker() {
    const child = fork(workerPath, [databasePath, secret], { silent: true });
    children.push(child);
    const [{ port }] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => {
        throw new Error(`Worker exited before listening (code ${code})`);
      }),
    ]);
    return `http://127.0.0.1:${port}`;
  }

  const servers = await Promise.all([worker(), worker()]);
  async function post(server, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(servers[server] + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }

  const tokens = Object.fromEntries(await Promise.all(
    ['alice', 'bob', 'charlie', 'manager2'].map(async username => {
      const result = await post(0, '/api/auth/login', { username, password: 'Classroom123!' });
      assert.equal(result.status, 200);
      return [username, result.data.accessToken];
    }),
  ));

  return {
    clear() {
      db.exec('BEGIN; DELETE FROM application_history; DELETE FROM applications; COMMIT');
    },
    async apply(student) {
      const result = await post(0, '/api/events/2/applications', {}, tokens[student]);
      assert.equal(result.status, 201);
      assert.equal(result.data.status, 'PENDING');
      return result.data.id;
    },
    change(server, user, id, action, body = {}) {
      return post(server, `/api/applications/${id}/${action}`, body, tokens[user]);
    },
    applications() {
      return db.prepare('SELECT id, status FROM applications ORDER BY id').all()
        .map(row => [row.id, row.status]);
    },
    history() {
      return db.prepare('SELECT * FROM application_history ORDER BY id').all();
    },
  };
}

async function concurrent(round, first, second) {
  if (round % 2 === 0) return Promise.all([first(), second()]);
  const [secondResult, firstResult] = await Promise.all([second(), first()]);
  return [firstResult, secondResult];
}

test('같은 신청의 직접 승인과 대기 취소를 동시에 요청', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  let approvedRounds = 0;

  for (let round = 0; round < rounds; round++) {
    f.clear();
    const id = await f.apply('alice');
    const [approval, cancellation] = await concurrent(round,
      () => f.change(0, 'manager2', id, 'approve'),
      () => f.change(1, 'alice', id, 'cancel'),
    );

    assert.deepEqual([approval.status, cancellation.status].sort(), [200, 409]);
    const approved = approval.status === 200;
    if (approved) approvedRounds++;
    const [success, failure] = approved ? [approval, cancellation] : [cancellation, approval];
    const finalStatus = approved ? 'APPROVED' : 'CANCELLED';
    assert.equal(success.data.status, finalStatus);
    assert.equal(failure.data.code, 'INVALID_STATE');
    assert.deepEqual(f.applications(), [[id, finalStatus]]);
    const history = f.history();
    assert.deepEqual(history.map(row => [row.application_id, row.action]), [
      [id, 'APPLY'],
      [id, approved ? 'APPROVE' : 'CANCEL'],
    ]);
    assert.equal(history[1].from_status, 'PENDING');
    assert.equal(history[1].to_status, finalStatus);
  }

  t.diagnostic(`20회 검증 완료. 직접 승인 성공 ${approvedRounds}회, 대기 취소 성공 ${rounds - approvedRounds}회.`);
});

test('정원이 찬 행사에서 첫 대기자의 직접 승인과 기존 승인 취소를 동시에 요청', {
  timeout: 60000,
}, async t => {
  const f = await fixture(t);
  let capacityFullRounds = 0;

  for (let round = 0; round < rounds; round++) {
    f.clear();
    const aliceId = await f.apply('alice');
    assert.equal((await f.change(0, 'manager2', aliceId, 'approve')).status, 200);
    const bobId = await f.apply('bob');
    const charlieId = await f.apply('charlie');

    const [approval, revocation] = await concurrent(round,
      () => f.change(0, 'manager2', bobId, 'approve'),
      () => f.change(1, 'manager2', aliceId, 'revoke', { reason: '행사 운영 사정으로 승인 취소' }),
    );

    assert.equal(approval.status, 409);
    assert.ok(['CAPACITY_FULL', 'INVALID_STATE'].includes(approval.data.code));
    if (approval.data.code === 'CAPACITY_FULL') capacityFullRounds++;
    assert.equal(revocation.status, 200);
    assert.equal(revocation.data.revoked.status, 'REVOKED');
    assert.equal(revocation.data.promoted.id, bobId);
    assert.equal(revocation.data.promoted.status, 'APPROVED');
    assert.deepEqual(f.applications(), [
      [aliceId, 'REVOKED'],
      [bobId, 'APPROVED'],
      [charlieId, 'PENDING'],
    ]);
    const history = f.history();
    assert.deepEqual(history.map(row => [row.application_id, row.action]), [
      [aliceId, 'APPLY'], [aliceId, 'APPROVE'], [bobId, 'APPLY'],
      [charlieId, 'APPLY'], [aliceId, 'REVOKE'], [bobId, 'AUTO_APPROVE'],
    ]);
    assert.equal(history[5].cause_history_id, history[4].id);
  }

  t.diagnostic(`20회 검증 완료. 직접 승인 응답 CAPACITY_FULL ${capacityFullRounds}회, INVALID_STATE ${rounds - capacityFullRounds}회.`);
});
