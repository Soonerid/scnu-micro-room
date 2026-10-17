'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Engine } = require('../engine');
const root = path.join(__dirname, '..', 'work', 'expiry-tests'); fs.mkdirSync(root, { recursive: true });
function cached(records, now) {
  const engine = new Engine(fs.mkdtempSync(path.join(root, 'case-')), { offset: 0, auth: {}, api() { throw Error('must not query school'); } });
  engine.now = () => Date.parse(now); engine.state.records = records; return engine;
}
test('paused dashboard excludes past reservations without deleting cached history', () => {
  const records = [{ id: 1, date: '2030-05-01', end: '21:50' },
    { id: 2, date: '2030-05-02', end: '14:00' }, { id: 3, date: '2030-05-03', end: '16:00' }];
  const engine = cached(records, '2030-05-02T13:00:00+08:00');
  assert.equal(engine.config.enabled, false);
  assert.deepEqual(engine.publicState().records.map(r => r.id), [2, 3]);
  assert.equal(engine.state.records.length, 3);
});
test('reservation expires at its end, using Beijing time across midnight', () => {
  const engine = cached([{ id: 1, date: '2030-05-01', end: '23:59' },
    { id: 2, date: '2030-05-02', end: '00:02' }], '2030-05-02T00:01:00+08:00');
  assert.deepEqual(engine.publicState().records.map(r => r.id), [2]);
  engine.now = () => Date.parse('2030-05-02T00:02:00+08:00');
  assert.deepEqual(engine.publicState().records, []);
});
