'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Account } = require('../account');
const { vault } = require('../site');
const { createApp } = require('../server');
const tempRoot = path.join(__dirname, '..', 'work', 'account-tests');
fs.mkdirSync(tempRoot, { recursive: true });
const makeDir = () => fs.mkdtempSync(path.join(tempRoot, 'case-'));
const fakeEngine = () => ({ state: { busy: false }, config: { enabled: false }, journal: {}, site: { auth: {} } });
const fakeSite = dir => ({ dataDir: dir, auth: {}, offset: 0, async login() {
  const input = vault('read', path.join(dir, 'credentials.dpapi'));
  if (input.password !== 'demo-pass-for-tests') throw new Error('Login rejected: ' + input.password);
  this.auth = { no: input.account, token: 'demo-session-for-tests' };
  vault('write', path.join(dir, 'session.dpapi'), this.auth);
  return { success: true, data: { name: '测试使用者' } };
}, async api() { return { success: false, message: '模拟环境不请求学校' }; } });

test('fresh installation starts paused, observes no names, and makes no school requests', async () => {
  let requests = 0;
  const app = createApp({ dataDir: makeDir(), port: 0, siteFactory: () => ({ auth: {}, offset: 0, api: async () => { requests++; throw Error('unexpected school request'); } }) });
  await app.start();
  try {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`), s = await r.json();
    assert.equal(s.account.configured, false); assert.equal(s.config.enabled, false); assert.equal(s.config.mode, 'date');
    assert.equal(s.monitoring.enabled, false); assert.equal(requests, 0);
    assert(!JSON.stringify(s).includes('password'));
  } finally { await app.stop(); }
});

test('invalid and empty account inputs are rejected before login', async () => {
  const a = new Account(makeDir(), fakeEngine(), () => { throw Error('must not connect'); });
  for (const input of [null, {}, { account: '../outside', password: 'x' }, { account: 'demo-student', password: '' }])
    await assert.rejects(() => a.save(input), /有效/);
  assert.equal(a.configured, false);
});

test('verified credentials use actual Windows DPAPI; raw passwords never appear in saved files or status', async () => {
  const dir = makeDir(), e = fakeEngine(), a = new Account(dir, e, fakeSite);
  await a.save({ account: 'demo-student', password: 'demo-pass-for-tests' });
  assert.equal(a.configured, true); assert.equal(e.config.enabled, false); assert.equal(e.site.dataDir, dir);
  assert.equal(vault('read', path.join(dir, 'credentials.dpapi')).account, 'demo-student');
  assert.equal(vault('read', path.join(dir, 'session.dpapi')).token, 'demo-session-for-tests');
  for (const file of fs.readdirSync(dir)) assert(!fs.readFileSync(path.join(dir, file)).includes(Buffer.from('demo-pass-for-tests')));
  assert(!JSON.stringify(a.publicState()).includes('demo-student')); assert(!fs.readdirSync(dir).some(f => f.startsWith('setup-')));
  const restored = new Account(dir, e, fakeSite); assert.equal(restored.account, 'demo-student');
  await assert.rejects(() => restored.save({ account: 'another-student', password: 'demo-pass-for-tests' }), /其他账号/);
});

test('failed login does not replace a saved account and never returns the entered password', async () => {
  const dir = makeDir(), a = new Account(dir, fakeEngine(), fakeSite);
  await a.save({ account: 'demo-student', password: 'demo-pass-for-tests' });
  const before = fs.readFileSync(path.join(dir, 'credentials.dpapi'));
  await assert.rejects(() => a.save({ account: 'demo-student', password: 'wrong-private-password' }), error => !error.message.includes('wrong-private-password'));
  assert(before.equals(fs.readFileSync(path.join(dir, 'credentials.dpapi'))));
  assert(!fs.readdirSync(dir).some(f => f.startsWith('setup-'))); assert.equal(a.busy, false);
});

test('cannot replace credentials while booking is enabled or a submission is pending', async () => {
  const e = fakeEngine(), a = new Account(makeDir(), e, fakeSite);
  e.config.enabled = true; await assert.rejects(() => a.save({}), /暂停/);
  e.config.enabled = false; e.journal.pending = { id: 'unknown' }; await assert.rejects(() => a.save({}), /待核对/);
});

test('HTTP setup enforces local host, origin and CSRF token, and blocks booking until configured', async () => {
  const app = createApp({ dataDir: makeDir(), port: 0, siteFactory: fakeSite }); await app.start();
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`, s = await (await fetch(base + '/api/status')).json();
    const body = JSON.stringify({ account: 'demo-student', password: 'demo-pass-for-tests' });
    assert.equal((await fetch(base + '/api/account', { method: 'POST', body })).status, 403);
    assert.equal((await fetch(base + '/api/account', { method: 'POST', body, headers: { 'x-action-token': s.actionToken, Origin: 'https://example.invalid' } })).status, 403);
    const foreignHost = await new Promise((resolve, reject) => require('node:http').get(base + '/api/status',
      { headers: { Host: 'example.invalid' } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject));
    assert.equal(foreignHost, 403);
    const blocked = await fetch(base + '/api/config', { method: 'POST', headers: { 'x-action-token': s.actionToken }, body: '{"enabled":true}' }); assert.equal(blocked.status, 400);
    const saved = await fetch(base + '/api/account', { method: 'POST', headers: { 'x-action-token': s.actionToken }, body });
    assert.equal(saved.status, 200); const publicData = await saved.json(); assert(!JSON.stringify(publicData).includes('demo-pass-for-tests'));
    const after = await (await fetch(base + '/api/status')).json(); assert.equal(after.config.enabled, false); assert.equal(after.account.configured, true);
  } finally { await app.stop(); }
});
