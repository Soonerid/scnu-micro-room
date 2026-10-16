'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Engine, chinaDate, addDays } = require('./engine');
const { Site } = require('./site');
const { Monitor } = require('./monitor');
const { Notifications } = require('./notifications');
const { Account } = require('./account');

function createApp({ dataDir = path.join(process.env.LOCALAPPDATA, 'SCNU-MicroRoom-Community'), port = 8912,
  siteFactory = dir => new Site(dir) } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const notifications = new Notifications(dataDir);
  const engine = new Engine(dataDir, siteFactory(dataDir), (records, uncertain) => notifications.confirmed(records, uncertain));
  if (!fs.existsSync(path.join(dataDir, 'config.json'))) engine.setConfig({ mode: 'date', date: addDays(chinaDate(engine.now()), 1) });
  const monitor = new Monitor(dataDir, path.join(dataDir, 'exports'), engine);
  monitor.useWorkdaySchedule();
  const account = new Account(dataDir, engine, siteFactory), token = crypto.randomBytes(24).toString('hex');
  const intervals = [];
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin))
      return send(403, { error: '仅限本机面板操作' });
    try {
      if (req.method === 'GET' && req.url === '/') return send(200, fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8').replace('__ACTION_TOKEN__', token), 'text/html; charset=utf-8');
      if (req.method === 'GET' && req.url === '/icon.svg') return send(200, fs.readFileSync(path.join(__dirname, 'icon.svg')), 'image/svg+xml');
      if (req.method === 'GET' && req.url === '/api/status') return send(200, { app: 'scnu-micro-room-community', ...engine.publicState(),
        notifications: notifications.publicState(), monitoring: monitor.publicState(), account: account.publicState(), actionToken: token });
      if (req.method === 'GET' && req.url === '/api/monitor') return send(200, monitor.publicState());
      if (req.method === 'GET' && req.url.startsWith('/api/monitor/export?')) {
        const type = new URL(req.url, origin).searchParams.get('type');
        const file = { history: '预约观察明细.csv', ranking: '预约观察统计.csv', daily: '单日占用统计.csv' }[type];
        if (!file || !fs.existsSync(path.join(monitor.exportDir, file))) throw new Error('本机暂无这份观察数据');
        return send(200, fs.readFileSync(path.join(monitor.exportDir, file)), 'text/csv; charset=utf-8');
      }
      if (req.method === 'GET' && req.url.startsWith('/api/overview?')) {
        if (!account.configured || account.busy) throw new Error('请先填写并验证自己的账号');
        const query = new URL(req.url, origin).searchParams;
        return send(200, await engine.overview(query.get('campusId'), query.get('date') || ''));
      }
      if (req.method !== 'POST' || req.headers['x-action-token'] !== token) return send(403, { error: '请从本机面板操作' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8000) throw new Error('输入内容过长'); }
      const input = raw ? JSON.parse(raw) : {};
      if (req.url === '/api/account') {
        const saved = await account.save(input);
        engine.check().catch(() => {});
        return send(200, { ok: true, account: saved });
      }
      if (!account.configured || account.busy) throw new Error('请先填写并验证自己的账号');
      if (req.url === '/api/config') { engine.setConfig(input); return send(200, { ok: true }); }
      if (req.url === '/api/monitor/config') {
        if (input.enabled && !monitor.plan.enabled && monitor.plan.attempts === 0) {
          const now = engine.now(); monitor.plan.startedAt = new Date(now).toISOString();
          monitor.plan.endsAt = new Date(now + 7 * 86400000).toISOString(); monitor.plan.workdaySince = new Date(now).toISOString();
        }
        monitor.setEnabled(input.enabled); return send(200, { ok: true });
      }
      if (req.url === '/api/test-alert') { notifications.test(); return send(200, { ok: true }); }
      if (req.url === '/api/ack-alert') { notifications.acknowledge(input.id); return send(200, { ok: true }); }
      if (req.url === '/api/check' || req.url === '/api/run') {
        if (engine.state.busy || engine.releasePriority()) throw new Error('当前任务仍在运行，请在首页查看进度');
        (req.url === '/api/check' ? engine.check() : engine.run(true)).catch(() => {});
        return send(202, { ok: true });
      }
      return send(404, { error: '没有这个操作' });
    } catch (error) { send(400, { error: error instanceof SyntaxError ? '输入格式不正确' : error.message }); }
  });
  return { server, engine, monitor, account,
    start() { return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        if (account.configured) engine.check().catch(() => {});
        else engine.state.phase = '请先填写自己的账号';
        intervals.push(setInterval(() => { if (account.configured && !account.busy) engine.tick(); }, 100));
        intervals.push(setInterval(() => { try { notifications.tick(); } catch {} }, 1000));
        intervals.push(setInterval(() => { if (account.configured && !account.busy) monitor.tick().catch(() => {}); }, 15000));
        resolve(server.address());
      });
    }); },
    stop() { intervals.forEach(clearInterval); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }
  };
}
if (require.main === module) createApp().start().catch(error => { if (error.code !== 'EADDRINUSE') console.error('助手启动失败，请重新运行安装并打开.cmd'); process.exit(error.code === 'EADDRINUSE' ? 0 : 1); });
module.exports = { createApp };
