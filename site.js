'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const ORIGIN = 'https://tstc.scnu.edu.cn';

function vault(mode, file, value) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'vault.ps1'), mode], {
    input: mode === 'read' ? fs.readFileSync(file).toString('base64') : JSON.stringify(value), encoding: 'utf8', windowsHide: true
  });
  if (r.status !== 0) throw new Error('无法读取本机加密登录信息');
  if (mode === 'read') return JSON.parse(r.stdout);
  fs.writeFileSync(file, Buffer.from(r.stdout.trim(), 'base64'));
}

class Site {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.cookies = new Map();
    this.auth = {};
    const p = path.join(dataDir, 'session.dpapi');
    if (fs.existsSync(p)) this.auth = vault('read', p);
    this.offset = 0;
  }
  async networkRoute() {
    if (this.route && Date.now() - this.routeAt < 300000) return this.route;
    if (this.routeLoading) return this.routeLoading;
    this.routeLoading = new Promise(resolve => {
      const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'network-route.ps1')], { windowsHide: true, stdio: ['ignore','pipe','ignore'] });
      let output = '', settled = false;
      const finish = () => {
        if (settled) return; settled = true; clearTimeout(timer);
        let route = {}; try { route = JSON.parse(output); } catch {}
        if (net.isIPv4(route.localAddress) && route.hosts) {
          route.hosts = Object.fromEntries(Object.entries(route.hosts).filter(([host, ip]) =>
            ['tstc.scnu.edu.cn','sso.scnu.edu.cn'].includes(host) && net.isIPv4(ip) && !/^198\.(18|19)\./.test(ip)));
        } else route = {};
        this.route = route; this.routeAt = Date.now(); resolve(route);
      };
      const timer = setTimeout(() => { child.kill(); finish(); }, 6000);
      child.stdout.on('data', data => { output += data; if (output.length > 4000) { child.kill(); finish(); } });
      child.on('error', finish); child.on('close', finish);
    });
    try { return await this.routeLoading; } finally { this.routeLoading = null; }
  }
  async request(url, options = {}, timeoutMs = 15000) {
    url = new URL(url, ORIGIN);
    // The school's callback advertises HTTP; use the same callback over HTTPS.
    url.protocol = 'https:';
    if (!['tstc.scnu.edu.cn', 'sso.scnu.edu.cn'].includes(url.hostname)) throw new Error('登录跳转到了未配置的网站');
    const cookie = [...this.cookies.values()].filter(c => url.hostname === c.host && url.pathname.startsWith(c.path)).map(c => `${c.name}=${c.value}`).join('; ');
    const route = await this.networkRoute(), address = route.hosts?.[url.hostname];
    const transport = address ? 'wlan_https' : 'system_https';
    const started = Date.now();
    let r, body, headersMs;
    try {
      await new Promise((resolve, reject) => {
        const request = https.request(url, { method: options.method || 'GET', agent: false, family: 4,
          ...(address ? { localAddress: route.localAddress, lookup: (host, opts, callback) =>
            opts.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4) } : {}),
          signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity', Cookie: cookie, ...options.headers }
        }, response => {
          r = { status: response.statusCode, headers: { get: key => response.headers[key] ?? null,
            getSetCookie: () => response.headers['set-cookie'] || [] } };
          headersMs = Date.now() - started;
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => { body = Buffer.concat(chunks).toString('utf8'); resolve(); });
          response.on('error', reject);
        });
        request.on('error', reject);
        request.end(options.body);
      });
    } catch (error) {
      this.route = null;
      throw Object.assign(error, { requestStage: r ? 'response_body' : 'response_headers', headersMs, status: r?.status, transport });
    }
    for (const line of r.headers.getSetCookie()) {
      const parts = line.split(';'); const pos = parts[0].indexOf('=');
      const name = parts[0].slice(0, pos); const value = parts[0].slice(pos + 1);
      const cp = parts.find(s => /^\s*path=/i.test(s));
      const c = { name, value, host: url.hostname, path: cp ? cp.trim().slice(5) : '/' };
      this.cookies.set(`${c.host}|${c.path}|${name}`, c);
    }
    if (url.hostname === 'tstc.scnu.edu.cn' && url.pathname === '/AVAthirdparty/ava/sso') {
      const payload = body.match(/JSON\.stringify\((\{[^\n]*?\})\)/)?.[1];
      if (payload) {
        const data = JSON.parse(payload);
        if (data.no && data.token) this.auth = { no: data.no, token: data.token };
      }
    }
    const retryAfter = r.headers.get('retry-after');
    const retryAfterMs = retryAfter === null ? 1000 : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(1000, Date.parse(retryAfter) - Date.now());
    return { status: r.status, body, headersMs, bodyMs: Date.now() - started - headersMs, transport,
      url: url.href, location: r.headers.get('location'), retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(1000, retryAfterMs) : 1000 };
  }
  async follow(url, options) {
    let r;
    for (let n = 0; n < 15; n++) {
      r = await this.request(url, options);
      options = undefined;
      if (r.location) { url = new URL(r.location, r.url).href; continue; }
      if (r.body.includes('login-form-password') || /function\s+gotoApp/.test(r.body)) return r;
      const redirect = r.body.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/);
      if (redirect) { url = new URL(redirect[1].replace(/&amp;/g, '&'), r.url).href; continue; }
      return r;
    }
    throw new Error('登录跳转次数异常');
  }
  async login() {
    const credentials = vault('read', path.join(this.dataDir, 'credentials.dpapi'));
    this.auth = {};
    let r = await this.follow('/AVAthirdparty/default/login.html');
    if (r.body.includes('login-form-password')) {
      const fail = Number(r.body.match(/login_failure_num\s*=\s*(\d+)/)?.[1] || 0);
      if (fail >= 3) throw new Error('学校登录需要验证码，请手动登录后再试');
      r = await this.follow('https://sso.scnu.edu.cn/AccountService/user/login.html', {
        method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({ account: credentials.account, password: credentials.password, rancode: '' }).toString()
      });
    }
    if (r.body.includes('login-form-password')) throw new Error('统一身份认证未通过；已停止自动重试');
    const goto = r.body.match(/function\s+gotoApp\s*\([^)]*\)\s*\{([\s\S]*?)\}/)?.[1];
    let target = goto?.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/)?.[1];
    if (!target && goto?.includes('location.href=targetUrl')) {
      target = goto.match(/targetUrl\s*=\s*['"]([^'"]+)['"]/)?.[1];
      for (const m of goto.matchAll(/targetUrl\s*=\s*targetUrl\s*\+\s*['"]([^'"]+)['"]/g)) target += m[1];
    }
    if (target) r = await this.follow(new URL(target.replace(/&amp;/g, '&'), r.url).href);
    const token = [...this.cookies.values()].find(c => c.host === 'tstc.scnu.edu.cn' && c.name === 'AVA_CLASSROOM_APPOINTMENT_SYSTEM_TOKEN')?.value;
    const no = [...this.cookies.values()].find(c => c.name === 'AVA_CLASSROOM_APPOINTMENT_SYSTEM_USER_NO')?.value;
    if (!token) {
      // Third-party sign-in may put the token in a redirect query rather than a cookie.
      const u = new URL(r.url); const q = u.searchParams;
      if (q.get('token')) this.auth = { token: q.get('token'), no: q.get('no') || credentials.account };
      else if (!this.auth.token) throw new Error('统一身份认证已连接，尚未取得预约平台登录凭证');
    } else this.auth = { token: decodeURIComponent(token), no: no ? decodeURIComponent(no) : credentials.account };
    vault('write', path.join(this.dataDir, 'session.dpapi'), this.auth);
    return this.api('usrEmployeeItem', {}, 'POST', false);
  }
  async api(name, params = {}, method = 'GET', reauth = true, timeoutMs = 15000) {
    const data = { ...params, no: this.auth.no, token: this.auth.token, nocache: 1 };
    Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) v.forEach(x => form.append(k, String(x)));
      else if (v !== null) form.append(k, String(v));
    }
    const start = Date.now();
    const url = `/webservice/${name}.action` + (method === 'GET' ? '?' + form : '');
    const detail = { endpoint: name, method, timeoutMs };
    let r;
    try { r = await this.request(url, method === 'GET' ? {} : {
      method, headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: form.toString()
    }, timeoutMs); }
    catch (error) {
      const code = ['TimeoutError','AbortError'].includes(error.name) ? 'REQUEST_TIMEOUT' : error.cause?.code || error.code || 'NETWORK_ERROR';
      this.lastRequest = { ...detail, elapsedMs: Date.now() - start, code, requestStage: error.requestStage,
        headersMs: error.headersMs, status: error.status, transport: error.transport, time: new Date().toISOString() };
      throw Object.assign(new Error(error.message, { cause: error }), this.lastRequest, { retryable: true });
    }
    this.lastRequest = { ...detail, elapsedMs: Date.now() - start, status: r.status, headersMs: r.headersMs, bodyMs: r.bodyMs, transport: r.transport, time: new Date().toISOString() };
    if (r.status === 429 || r.status >= 500) {
      const e = new Error(r.status === 429 ? '学校服务器限流，正在等待后重试' : '学校服务器繁忙，正在重试');
      e.code = r.status === 429 ? 'RATE_LIMITED' : 'SCHOOL_UNAVAILABLE'; e.retryable = true; e.retryAfterMs = r.retryAfterMs || 1000;
      throw Object.assign(e, this.lastRequest);
    }
    let result;
    try { result = JSON.parse(r.body); } catch { throw new Error('学校服务器未返回有效数据'); }
    if (result.systemTime?.time) this.offset = result.systemTime.time - (start + Date.now()) / 2;
    if (['-10000','18000'].includes(String(result.errorCode)) && reauth && (method === 'GET' || name === 'usrEmployeeItem')) {
      await this.login(); return this.api(name, params, method, false, timeoutMs);
    }
    if (result.data === null && Array.isArray(result.list)) result.data = result.list;
    return result;
  }
}
module.exports = { Site, vault, ORIGIN };
