'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chinaDate, addDays, stamp, RELEASE_WINDOW } = require('./engine');
const INTERVAL = 8 * 3600000;
const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const slotKey = s => [s.date, s.roomId, s.start, s.end].join('|');
const csvCell = value => {
  let s = String(value ?? '');
  if (/^\s*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
function rowsFrom(views) {
  return views.flatMap(v => v.rooms.flatMap(r => r.slots.map(s => ({ date: v.date, roomId: r.id, room: r.name,
    start: s.start, end: s.end, period: s.period, status: s.status, names: [...new Set(s.bookers)], pending: Boolean(s.pending) }))));
}
function summarize(samples) {
  const latest = new Map(), seen = new Set();
  const ordered = [...samples].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  for (const sample of ordered) for (const row of sample.rows) {
    latest.set(slotKey(row), row);
    if (row.status === 'booked') for (const name of row.names) seen.add(slotKey(row) + '|' + name);
  }
  const people = new Map(), daily = new Map(), namedSlots = new Set(); let unnamedSlots = 0;
  for (const [key, row] of latest) {
    if (row.status !== 'booked') continue;
    if (!row.names.length) { unnamedSlots++; continue; }
    namedSlots.add(key);
    for (const name of row.names) {
      if (!people.has(name)) people.set(name, { name, slots: 0, minutes: 0, lateAfternoon: 0, perDate: {} });
      const p = people.get(name); p.slots++; p.minutes += minutes(row.end) - minutes(row.start);
      if (row.period === 'afternoon' && row.start >= '15:00') p.lateAfternoon++;
      p.perDate[row.date] = (p.perDate[row.date] || 0) + 1;
      const dayKey = JSON.stringify([row.date, name]);
      if (!daily.has(dayKey)) daily.set(dayKey, { name, date: row.date, slots: 0, minutes: 0, rooms: new Set(), lateAfternoon: 0, pendingSlots: 0 });
      const d = daily.get(dayKey); d.slots++; d.minutes += minutes(row.end) - minutes(row.start); d.rooms.add(String(row.roomId));
      if (row.period === 'afternoon' && row.start >= '15:00') d.lateAfternoon++;
      if (row.pending) d.pendingSlots++;
    }
  }
  const ranking = [...people.values()].map(p => ({ ...p, dates: Object.keys(p.perDate).length,
    maxDay: Math.max(...Object.values(p.perDate)), share: namedSlots.size ? Math.round(p.slots / namedSlots.size * 1000) / 10 : 0 }))
    .sort((a, b) => b.slots - a.slots || b.minutes - a.minutes || a.name.localeCompare(b.name, 'zh-CN'));
  const top = new Set(ranking.slice(0, 5).map(p => p.name));
  const topSlots = [...latest.values()].filter(r => r.status === 'booked' && r.names.some(n => top.has(n))).length;
  const dailyConcentration = [...daily.values()].filter(d => d.slots >= 5)
    .map(({ rooms, ...d }) => ({ ...d, roomCount: rooms.size }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.slots - a.slots || b.minutes - a.minutes || a.name.localeCompare(b.name, 'zh-CN'));
  return { samples: ordered.length, releaseSamples: ordered.filter(s => s.source === 'release').length, complete: ordered.filter(s => s.status === 'complete').length,
    partial: ordered.filter(s => s.status === 'partial').length,
    observationDays: new Set(ordered.map(s => chinaDate(Date.parse(s.finishedAt)))).size,
    useDates: [...new Set([...latest.values()].map(r => r.date))].sort(), namedSlots: namedSlots.size, unnamedSlots,
    distinctObservedAssignments: seen.size,
    topFiveShare: namedSlots.size ? Math.round(topSlots / namedSlots.size * 1000) / 10 : 0, ranking, dailyThreshold: 5, dailyConcentration };
}
class Monitor {
  constructor(dataDir, exportDir, engine) {
    this.engine = engine; this.dir = path.join(dataDir, 'observations'); this.exportDir = exportDir; this.busy = false;
    fs.mkdirSync(this.dir, { recursive: true }); fs.mkdirSync(exportDir, { recursive: true });
    this.planFile = path.join(this.dir, 'plan.json');
    const now = engine.now();
    this.plan = fs.existsSync(this.planFile) ? JSON.parse(fs.readFileSync(this.planFile, 'utf8'))
      : { enabled: false, campusId: 1, startedAt: new Date(now).toISOString(), endsAt: new Date(now + 7 * 86400000).toISOString(),
        lastWindow: -1, attempts: 0, failed: 0, skippedWindows: 0, lastAttempt: null, lastSuccess: null };
    this.plan.releaseDays ||= {};
    this.plan.workdaySlots ||= {};
    this.samples = fs.readdirSync(this.dir).filter(f => /^(sample-\d+|release-\d{4}-\d{2}-\d{2}-\d+|workday-\d{4}-\d{2}-\d{2}-(09|17)-\d+)\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')));
    const savedWindows = fs.readdirSync(this.dir).filter(f => /^sample-\d+\.json$/.test(f)).map(f => Number(f.match(/\d+/)[0]));
    if (savedWindows.length) this.plan.lastWindow = Math.max(this.plan.lastWindow, ...savedWindows);
    for (const sample of this.samples.filter(s => s.source === 'release' && s.status === 'complete')) {
      const saved = this.plan.releaseDays[sample.releaseDay];
      if (!saved || saved.status !== 'complete') this.plan.releaseDays[sample.releaseDay] = { status: 'complete', attempts: sample.releaseAttempt, time: sample.finishedAt, date: sample.observedDates[0] };
    }
    for (const sample of this.samples.filter(s => s.source === 'workday' && s.status === 'complete')) {
      this.plan.workdaySlots[sample.workdayKey] = { status: 'complete', attempts: sample.workdayAttempt, time: sample.finishedAt };
    }
    if (this.samples.length) this.plan.lastSuccess = [...this.samples].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)).at(-1).finishedAt;
    this.summary = summarize(this.samples);
    if (this.samples.length) this.refreshExports();
    this.savePlan();
  }
  savePlan() { fs.writeFileSync(this.planFile + '.tmp', JSON.stringify(this.plan, null, 2)); fs.renameSync(this.planFile + '.tmp', this.planFile); }
  useWorkdaySchedule() {
    if (!this.plan.workdaySince) { this.plan.workdaySince = new Date(this.engine.now()).toISOString(); this.savePlan(); }
  }
  workdayWindows() {
    const since = Date.parse(this.plan.workdaySince), ends = Date.parse(this.plan.endsAt), result = [];
    for (let day = chinaDate(since); stamp(day, '00:00') < ends; day = addDays(day, 1)) {
      for (const hour of ['09', '17']) {
        const time = stamp(day, hour + ':00'), key = day + '-' + hour;
        if (time > since && time < ends) result.push({ key, time });
      }
    }
    return result;
  }
  workdaySlot() {
    return this.workdayWindows().filter(slot => slot.time <= this.engine.now() && !['complete','missed'].includes(this.plan.workdaySlots[slot.key]?.status)).at(-1);
  }
  nextAt() {
    if (!this.plan.workdaySince) return Date.parse(this.plan.startedAt) + (this.plan.lastWindow + 1) * INTERVAL;
    const now = this.engine.now(), today = chinaDate(now), working = now >= stamp(today, '09:00') && now < stamp(today, '18:00');
    const due = working ? this.workdaySlot() : null;
    const future = this.workdayWindows().find(slot => slot.time > now)?.time ?? Date.parse(this.plan.endsAt);
    if (!due) return future;
    const retry = Math.max(due.time, this.plan.workdaySlots[due.key]?.retryAt || 0);
    return Math.min(retry < stamp(today, '18:00') ? retry : stamp(addDays(today, 1), '09:00'), future);
  }
  allowed() {
    if (this.engine.now() < (this.engine.journal.cooldownAt || 0) || this.engine.now() < (this.plan.serverRetryAt || 0)) return false;
    if (!this.engine.config.enabled) return true;
    const today = chinaDate(this.engine.now());
    const delta = this.engine.now() - Date.parse(`${today}T${this.engine.config.releaseTime}+08:00`);
    return Boolean(this.engine.journal.days[today]) || delta < -120000 || delta >= RELEASE_WINDOW + 60000;
  }
  async tick() {
    const now = this.engine.now();
    if (!this.plan.enabled || this.busy) return;
    if (now >= Date.parse(this.plan.endsAt)) {
      if (this.plan.workdaySince) for (const slot of this.workdayWindows()) {
        const saved = this.plan.workdaySlots[slot.key];
        if (!['complete','missed'].includes(saved?.status)) {
          if (!saved?.attempts) this.plan.skippedWindows++;
          this.plan.workdaySlots[slot.key] = { ...saved, status: 'missed' };
        }
      }
      this.plan.enabled = false; this.savePlan(); return;
    }
    if (this.engine.state.busy || !this.allowed()) return;
    const today = chinaDate(now), working = !this.plan.workdaySince || (now >= stamp(today, '09:00') && now < stamp(today, '18:00'));
    if (working && now >= this.nextAt()) { await this.capture(); return; }
    const rules = this.engine.state.rules, day = chinaDate(now);
    if (!rules?.maxDays) return;
    const openedAt = stamp(day, String(rules.releaseHour).padStart(2, '0') + ':00'), saved = this.plan.releaseDays[day];
    if (now < openedAt + RELEASE_WINDOW || saved?.status === 'complete' || now < (saved?.retryAt || 0)) return;
    await this.capture({ day, date: addDays(day, rules.maxDays), attempt: (saved?.attempts || 0) + 1 });
  }
  async capture(release = null) {
    if (this.busy) return;
    this.busy = true;
    const now = this.engine.now(), window = Math.floor((now - Date.parse(this.plan.startedAt)) / INTERVAL);
    const regular = !release && this.plan.workdaySince ? this.workdaySlot() : null;
    const regularAttempt = regular ? (this.plan.workdaySlots[regular.key]?.attempts || 0) + 1 : null;
    const today = chinaDate(now), dates = [release ? release.date : today];
    const views = []; let error = null, retryDelay = 0;
    try {
      for (const date of dates) {
        if (!this.allowed()) { const e = new Error('采样让位给自动预约'); e.code = 'MONITOR_DEFERRED'; throw e; }
        views.push(await this.engine.overview(1, date, () => this.allowed() && (!regular || this.engine.now() < stamp(today, '18:00'))));
        if (!release && dates.length === 1) {
          const rules = this.engine.state.rules;
          const after = now >= stamp(today, String(rules.releaseHour).padStart(2, '0') + ':00');
          for (let i = 1; i < rules.maxDays + Number(after); i++) dates.push(addDays(today, i));
        }
      }
    } catch (e) {
      if (e.code === 'MONITOR_DEFERRED') { this.busy = false; return; }
      retryDelay = e.retryAfterMs || 0;
      error = /fetch failed|timed out|aborted/i.test(e.message) ? '学校课表连接失败' : e.message.slice(0, 160);
    }
    try {
      const finishedAt = new Date(this.engine.now()).toISOString();
      if (!release && !regular) {
        this.plan.skippedWindows += Math.max(0, window - this.plan.lastWindow - 1);
        this.plan.lastWindow = window;
      }
      this.plan.attempts++;
      this.plan.lastAttempt = { time: finishedAt, status: !error ? 'complete' : views.length ? 'partial' : 'failed', source: release ? 'release' : regular ? 'workday' : 'interval', error };
      if (views.length) {
        const sample = { capturedAt: new Date(now).toISOString(), finishedAt, campusId: 1, source: release ? 'release' : regular ? 'workday' : 'interval',
          ...(release ? { releaseDay: release.day, releaseAttempt: release.attempt } : {}), requestedDates: dates,
          ...(regular ? { workdayKey: regular.key, workdayAttempt: regularAttempt, plannedAt: new Date(regular.time).toISOString() } : {}),
          observedDates: views.map(v => v.date), status: error ? 'partial' : 'complete', error, rows: rowsFrom(views) };
        const file = path.join(this.dir, release ? `release-${release.day}-${release.attempt}.json` : regular ? `workday-${regular.key}-${regularAttempt}.json` : `sample-${window}.json`);
        fs.writeFileSync(file + '.tmp', JSON.stringify(sample)); fs.renameSync(file + '.tmp', file);
        this.samples.push(sample); this.plan.lastSuccess = finishedAt; this.summary = summarize(this.samples); this.refreshExports();
      }
      if (error && !views.length) this.plan.failed++;
      if (retryDelay) {
        this.plan.serverRetryAt = this.engine.now() + retryDelay;
        this.engine.journal.cooldownAt = Math.max(this.engine.journal.cooldownAt || 0, this.plan.serverRetryAt);
        this.engine.save?.('journal.json', this.engine.journal);
      }
      if (regular) {
        for (const slot of this.workdayWindows().filter(s => s.time < regular.time)) {
          if (!['complete','missed'].includes(this.plan.workdaySlots[slot.key]?.status)) {
            if (!this.plan.workdaySlots[slot.key]?.attempts) this.plan.skippedWindows++;
            this.plan.workdaySlots[slot.key] = { ...this.plan.workdaySlots[slot.key], status: 'missed' };
          }
        }
        this.plan.workdaySlots[regular.key] = { status: error ? 'failed' : 'complete', attempts: regularAttempt, time: finishedAt,
          retryAt: error ? this.engine.now() + Math.max(retryDelay, 600000) : null };
      }
      if (release) this.plan.releaseDays[release.day] = { ...this.plan.releaseDays[release.day], date: release.date, attempts: release.attempt, status: error ? 'failed' : 'complete', time: finishedAt, error,
        retryAt: error ? this.engine.now() + Math.max(retryDelay, release.attempt === 1 ? 60000 : release.attempt === 2 ? 300000 : 600000) : null };
      else {
        const rules = this.engine.state.rules;
        if (rules?.maxDays && now >= stamp(today, String(rules.releaseHour).padStart(2, '0') + ':00')) {
          const date = addDays(today, rules.maxDays);
          if (views.some(v => v.date === date)) this.plan.releaseDays[today] = { ...this.plan.releaseDays[today], date, status: 'complete', time: finishedAt, via: 'interval', error: null, retryAt: null };
        }
      }
      this.savePlan();
    } finally { this.busy = false; }
  }
  export() {
    const statuses = { free: '空闲', booked: '已预约', arranged: '统一安排', exam: '考试', holiday: '假期', unopened: '未开放', expired: '已过时', closed: '停用' };
    const periods = { morning: '上午', afternoon: '下午', evening: '晚上' };
    const localTime = t => new Date(Date.parse(t) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    const history = [['采样开始时间', '采样结束时间', '采样完整性', '使用日期', '课室编号', '课室', '开始', '结束', '时段类别', '状态', '课表预约姓名', '含待审核预约', '采样类型']];
    for (const s of this.samples) for (const r of s.rows) history.push([localTime(s.capturedAt), localTime(s.finishedAt), s.status === 'complete' ? '完整' : '部分', r.date, r.roomId, r.room, r.start, r.end, periods[r.period] || r.period, statuses[r.status] || r.status, r.names.join('、'), r.pending ? '是' : '否', s.source === 'release' ? '放号后更新' : s.source === 'workday' ? '白天名单复查' : '8小时复查（旧规则）']);
    const ranking = [['课表姓名标签', '去重占用节次', '占用分钟', '使用日期数', '下午15点后节次', '同日最多节次', '具名占用节次比例(%)']];
    for (const p of this.summary.ranking) ranking.push([p.name, p.slots, p.minutes, p.dates, p.lateAfternoon, p.maxDay, p.share]);
    const daily = [['使用日期', '课表姓名标签', '同日去重占用节次', '占用分钟', '教室数', '下午15点后节次', '含待审核节次', '筛查口径']];
    for (const d of this.summary.dailyConcentration) daily.push([d.date, d.name, d.slots, d.minutes, d.roomCount, d.lateAfternoon, d.pendingSlots, '同名同日5节及以上，仅供核验']);
    for (const [file, rows] of [['预约观察明细.csv', history], ['预约观察统计.csv', ranking], ['单日占用统计.csv', daily]]) {
      const target = path.join(this.exportDir, file);
      fs.writeFileSync(target + '.tmp', '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')); fs.renameSync(target + '.tmp', target);
    }
  }
  refreshExports() {
    try { this.export(); this.plan.exportError = null; }
    catch { this.plan.exportError = '导出文件暂时无法更新，请关闭正在打开的CSV；原始快照已保存在本机，下次采样会再更新导出。'; }
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('请选择开启或暂停观察');
    if (enabled && this.engine.now() >= Date.parse(this.plan.endsAt)) throw new Error('这轮7天观察已结束，记录仍保留');
    this.plan.enabled = Boolean(enabled); this.savePlan();
  }
  publicState() {
    const now = this.engine.now(), rules = this.engine.state.rules, today = chinaDate(now);
    const expectedDates = rules?.maxDays ? Array.from({ length: rules.maxDays + Number(now >= stamp(today, String(rules.releaseHour).padStart(2, '0') + ':00')) }, (_, i) => addDays(today, i)) : [];
    return { ...this.plan, intervalHours: 8, regularTimes: this.plan.workdaySince ? ['09:00','17:00'] : null,
      releaseSampling: true, releaseSample: this.plan.releaseDays[today] || null, busy: this.busy, nextAt: this.nextAt(), completed: this.engine.now() >= Date.parse(this.plan.endsAt),
      coverage: { expectedDates, missingDates: expectedDates.filter(date => !this.summary.useDates.includes(date)) },
      summary: { ...this.summary, ranking: this.summary.ranking.slice(0, 20), dailyCount: this.summary.dailyConcentration.length, dailyConcentration: this.summary.dailyConcentration.slice(0, 20) } };
  }
}
module.exports = { Monitor, summarize, rowsFrom, csvCell };
