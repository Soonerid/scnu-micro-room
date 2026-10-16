'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Site } = require('./site');
const RELEASE_WINDOW = 1200000, HOT_WINDOW = 120000;
const DAY_INTERVAL = 600000, EVENING_INTERVAL = 300000;
const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const chinaDate = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const stamp = (date, time) => Date.parse(`${date}T${time}:00+08:00`);
const addDays = (date, n) => chinaDate(stamp(date, '00:00') + n * 86400000);
const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(stamp(date, '00:00')) && chinaDate(stamp(date, '00:00')) === date;
function requireSuccess(r) { if (!r.success) throw new Error(r.message || '学校服务器拒绝了请求'); return r.data; }
function readableError(e) {
  if (/^(?:ENOENT|EACCES):/.test(e.message)) return '登录配置未就绪，请重新打开桌面助手';
  const message = e.code === 'REQUEST_TIMEOUT' ? '学校响应超时' : /fetch failed|timed out|aborted/i.test(e.message) ? '学校服务器连接中断，请检查网络后重试' : e.message;
  const labels = { sysSettingItem: '预约规则', getDictionaryValueByKey: '放号时间', usrEmployeeItem: '登录身份', bizCampusList: '校区', bizLiveList: '本人预约记录', pubAllRecordEquipmentList: '教室列表', bizLiveListTimeTable: '教室课表', pubRecordEquipmentExamList: '考试占用', bizLiveItemEdit: '提交预约', bizLiveItem: '单条预约核验' };
  return message + (e.endpoint ? `（${labels[e.endpoint] || '平台请求'}${e.room ? '：' + e.room : ''}，耗时${(e.elapsedMs / 1000).toFixed(1)}秒）` : '');
}
const transient = e => e.retryable || /fetch failed|timed?\s*out|timeout|aborted/i.test(e.message);
function minimalRecord(x) {
  return { id: x.id, date: x.liveDateTip, start: x.startTimeTip, end: x.endTimeTip,
    roomId: x.recordEquipmentId, room: x.recordEquipmentName, building: x.teachBuildingName,
    slotId: x.recordEquipmentTimeId, review: x.reviewStatus, reviewText: x.reviewStatusTip, status: x.status };
}
const periodOf = start => minute(start) < 720 ? 'morning' : minute(start) < 1080 ? 'afternoon' : 'evening';
function scheduleSlots(table, room, date, now, exams = [], opened = true) {
  const day = table.list?.find(x => x.timeTip === date);
  if (!day || !Array.isArray(table.data?.listRecordEquipmentTimeDTO) || !Array.isArray(day.listData)) throw new Error('课表结构发生变化，已停止预约');
  return table.data.listRecordEquipmentTimeDTO.map((s, i) => {
    if (s.id == null || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.startTimeTip) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.endTimeTip) || minute(s.endTimeTip) <= minute(s.startTimeTip)) throw new Error('课表时间结构发生变化，已停止预约');
    const entries = day.listData.find(x => String(x.recordEquipmentTimeId) === String(s.id))?.listLive;
    if (!Array.isArray(entries)) throw new Error('课表结构发生变化，已停止预约');
    const start = stamp(date, s.startTimeTip), end = stamp(date, s.endTimeTip);
    const active = entries.filter(x => Number(x.liveStatus) !== 1 && !(Number(x.liveStatus) === 0 && Number(x.reviewStatus) === 1));
    const occupied = active.length > 0;
    const exam = exams.some(x => x.startTime?.time <= end && x.endTime?.time >= start);
    const booked = active.filter(x => Number(x.liveStatus) === 0);
    const bookers = [...new Set(booked.map(x => typeof x.employeeName === 'string' ? x.employeeName.trim().slice(0, 80) : '').filter(Boolean))];
    let status = 'free';
    if (Number(room.isAvailable) !== 0) status = 'closed';
    else if (booked.length) status = 'booked';
    else if (exam) status = 'exam';
    else if (active.some(x => Number(x.liveStatus) === 2)) status = 'arranged';
    else if (active.some(x => Number(x.liveStatus) === 4)) status = 'holiday';
    else if (occupied || !opened) status = 'unopened';
    else if (start <= now) status = 'expired';
    return { id: s.id, name: s.name, start: s.startTimeTip, end: s.endTimeTip, index: i,
      period: periodOf(s.startTimeTip), status, bookers, pending: booked.some(x => Number(x.reviewStatus) === 0),
      free: status === 'free', availableOnOpen: !occupied && !exam && Number(room.isAvailable) === 0 && start > now };
  });
}
function slotsFrom(table, room, date, now, exams = []) {
  if (Number(room.isAvailable) !== 0) return [];
  return scheduleSlots(table, room, date, now, exams);
}
function candidates(rooms, fallback, periods = ['afternoon']) {
  const pairs = [], singles = [];
  for (const room of rooms) {
    const selected = room.slots.filter(s => periods.includes(periodOf(s.start)));
    for (const s of selected.filter(x => x.free)) {
      const next = selected.find(x => x.index === s.index + 1 && x.free && periodOf(x.start) === periodOf(s.start));
      const preference = periodOf(s.start) === 'afternoon' ? (minute(s.start) >= 900 ? 0 : 1) : periodOf(s.start) === 'evening' ? 2 : 3;
      if (next && minute(next.start) >= minute(s.end) && minute(next.start) - minute(s.end) <= 30) {
        pairs.push({ room, slots: [s, next], rank: preference });
      }
      singles.push({ room, slots: [s], rank: 4 + preference });
    }
  }
  const result = fallback === 'pair_only' ? pairs : [...pairs, ...singles];
  return result.sort((a, b) => a.rank - b.rank || minute(a.slots[0].start) - minute(b.slots[0].start) || a.room.id - b.room.id);
}
class Engine {
  constructor(dataDir, site, notify = () => {}) {
    this.dir = dataDir; fs.mkdirSync(dataDir, { recursive: true });
    this.site = site || new Site(dataDir);
    this.notify = notify;
    this.roomCache = new Map();
    this.config = { enabled: false, campusId: 1, mode: 'newest', date: '', fallback: 'allow_single', releaseTime: '20:00:00',
      periods: ['afternoon'], ...this.load('config.json', {}) };
    if (['afternoon', 'after15'].includes(this.config.fallback)) this.config.fallback = 'allow_single';
    this.journal = this.load('journal.json', { days: {}, pending: null });
    const previous = this.load('last-result.json', null);
    this.state = { phase: '等待检查', busy: false, checkedAt: null, records: [], previews: [], lastResult: previous,
      lastReleaseResult: this.load('release-result.json', previous?.kind === 'surplus' ? null : previous),
      surplus: this.load('surplus-result.json', null), logs: this.load('events.json', []).slice(-80).map(e => ({ ...e, message: readableError(e) })) };
    if (this.state.lastReleaseResult && !fs.existsSync(path.join(this.dir, 'release-result.json'))) this.save('release-result.json', this.state.lastReleaseResult);
  }
  load(name, fallback) { const p = path.join(this.dir, name); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback; }
  save(name, value) { const p = path.join(this.dir, name); fs.writeFileSync(p + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(p + '.tmp', p); }
  log(message, kind = 'info') {
    this.state.logs.push({ time: new Date().toISOString(), message, kind });
    this.state.logs = this.state.logs.slice(-80); this.save('events.json', this.state.logs);
  }
  now() { return Date.now() + this.site.offset; }
  wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  target() {
    const today = chinaDate(this.now());
    return this.config.mode === 'date' ? this.config.date : addDays(today, this.config.mode === 'newest' ? 2 : 1);
  }
  nextRun() {
    let day = chinaDate(this.now());
    let t = Date.parse(`${day}T${this.config.releaseTime}+08:00`);
    if (t <= this.now() && (this.journal.days[day] || this.now() - t >= RELEASE_WINDOW)) {
      day = addDays(day, 1); t = Date.parse(`${day}T${this.config.releaseTime}+08:00`);
    }
    return t;
  }
  surplusWindow(now = this.now()) {
    const day = chinaDate(now), end = stamp(addDays(day, 1), '00:00');
    if (now >= stamp(day, '09:00') && now < stamp(day, '18:00')) return { label: '白天余位检查', end: stamp(day, '18:00'), interval: DAY_INTERVAL };
    const release = Date.parse(`${day}T${this.config.releaseTime}+08:00`);
    if (now >= release + RELEASE_WINDOW && now < end) return { label: '晚间余位检查', end, interval: EVENING_INTERVAL };
    return null;
  }
  nextSurplusAt() {
    const now = this.now(), today = chinaDate(now);
    for (let i = 0; i < 2; i++) {
      const day = addDays(today, i);
      const windows = [[stamp(day, '09:00'), stamp(day, '18:00')],
        [Date.parse(`${day}T${this.config.releaseTime}+08:00`) + RELEASE_WINDOW, stamp(addDays(day, 1), '00:00')]];
      for (const [start, end] of windows) {
        const time = Math.max(now, start, this.journal.nextSurplusAt || 0);
        if (time < end) return time;
      }
    }
    return this.journal.nextSurplusAt || null;
  }
  async checkSurplus() {
    const window = this.surplusWindow();
    if (!window || !this.config.enabled || this.state.busy || this.surplusRunning || this.releasePriority() || this.now() < (this.journal.cooldownAt || 0)) return;
    this.surplusRunning = true;
    this.state.busy = true;
    this.journal.nextSurplusAt = this.now() + window.interval;
    this.save('journal.json', this.journal);
    const checkedDates = [];
    try {
      if (!this.state.rules || !this.metadataAt || Date.now() - this.metadataAt > 300000) await this.metadata(10000, () => this.config.enabled && this.now() < window.end);
      const today = chinaDate(this.now()), after = this.now() >= stamp(today, String(this.state.rules.releaseHour).padStart(2, '0') + ':00');
      const dates = this.config.mode === 'date' ? [this.config.date] : Array.from({ length: this.state.rules.maxDays + Number(after) }, (_, i) => addDays(today, i));
      for (const date of dates) {
        if (!this.config.enabled || this.now() >= window.end || this.releasePriority()) break;
        if (!this.inHorizon(date)) continue;
        checkedDates.push(date);
        this.state.busy = false;
        await this.run(false, { kind: 'surplus', date, endsAt: window.end });
        if (this.state.error || this.journal.pending || this.state.lastResult.count || this.state.burst.retryAfterMs || this.state.burst.stopReason === 'quota') break;
      }
    } catch (error) { this.state.error = readableError(error); this.log(this.state.error, 'warning'); }
    finally {
      this.journal.nextSurplusAt = Math.max(this.journal.nextSurplusAt, this.journal.cooldownAt || 0);
      this.state.surplus = { time: new Date(this.now()).toISOString(), dates: checkedDates, label: window.label,
        nextAt: this.nextSurplusAt(), error: this.state.error || null, count: this.state.lastResult?.kind === 'surplus' ? this.state.lastResult.count : 0 };
      if (!this.state.error && !this.state.surplus.count && this.state.burst?.stopReason !== 'quota' && this.config.enabled) this.state.phase = '等待下一次余位检查';
      this.save('journal.json', this.journal); this.save('surplus-result.json', this.state.surplus); this.surplusRunning = false; this.state.busy = false;
    }
  }
  tick() {
    if (!this.config.enabled || this.state.busy || this.surplusRunning || this.now() < (this.journal.cooldownAt || 0)) return;
    const today = chinaDate(this.now());
    const release = Date.parse(`${today}T${this.config.releaseTime}+08:00`);
    const delta = this.now() - release;
    if (delta >= -90000 && delta < 0 && this.state.preparedDay !== today) {
      this.state.preparedDay = today; this.prepare(release).catch(() => {});
    }
    if (delta >= 0 && delta < RELEASE_WINDOW && !this.journal.days[today]) this.run();
    if (!this.state.busy && this.surplusWindow() && this.now() >= (this.journal.nextSurplusAt || 0)) this.checkSurplus().catch(() => {});
  }
  releasePriority() {
    const today = chinaDate(this.now()), delta = this.now() - Date.parse(`${today}T${this.config.releaseTime}+08:00`);
    return this.config.enabled && delta >= -90000 && delta < RELEASE_WINDOW && !this.journal.days[today];
  }
  publicState() {
    const nextRelease = this.nextRun(), nextSurplus = this.nextSurplusAt();
    return { ...this.state, busy: this.state.busy || Boolean(this.surplusRunning), config: this.config, serverNow: this.now(), nextRun: nextRelease,
      nextAction: { time: Math.min(nextRelease, nextSurplus ?? Infinity), label: nextSurplus != null && nextSurplus < nextRelease ? '余位检查' : '放号预约' },
      schedule: { releaseMinutes: RELEASE_WINDOW / 60000, daytime: '09:00—18:00', daytimeIntervalMinutes: 10, evening: '20:20—24:00', eveningIntervalMinutes: 5, leadMinutes: 30,
        surplusDates: this.config.mode === 'date' ? [this.config.date] : this.state.rules?.maxDays ? Array.from({ length: this.state.rules.maxDays + Number(this.now() >= stamp(chinaDate(this.now()), String(this.state.rules.releaseHour).padStart(2, '0') + ':00')) }, (_, i) => addDays(chinaDate(this.now()), i)) : [] },
      targetDate: this.state.burst?.active ? this.state.burst.date : this.target(), releasePriority: this.releasePriority(), lastRequest: this.site.lastRequest || null,
      pending: this.journal.pending ? { date: this.journal.pending.date, room: this.journal.pending.room, start: this.journal.pending.start } : null };
  }
  setConfig(c) {
    const merged = { ...this.config, ...c };
    if (![1, 2].includes(Number(merged.campusId)) || !['tomorrow', 'newest', 'date'].includes(merged.mode)
      || !['allow_single', 'pair_only'].includes(merged.fallback)
      || !Array.isArray(merged.periods) || !merged.periods.length || merged.periods.some(x => !['morning', 'afternoon', 'evening'].includes(x))
      || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(merged.releaseTime)
      || (merged.mode === 'date' && !validDate(merged.date))) throw new Error('请检查预约设置，至少选择一个时段并填写有效日期');
    if (this.state.busy && !(c.enabled === false && Object.keys(c).length === 1)) throw new Error('正在处理预约，请等待本轮结束后修改设置');
    merged.campusId = Number(merged.campusId); merged.enabled = Boolean(merged.enabled);
    merged.periods = [...new Set(merged.periods)];
    this.preparation = null;
    this.config = merged; this.save('config.json', merged); this.log(merged.enabled ? '自动预约已启用' : '自动预约已暂停');
    if (Object.keys(c).some(k => k !== 'enabled')) { this.roomCache.clear(); this.state.previews = []; this.state.scanNote = '偏好已保存，可检查新的空闲时段'; this.state.scanAt = null; }
    if (!this.state.busy) this.state.phase = merged.enabled ? '等待放号' : '自动预约已暂停';
  }
  async metadata(timeoutMs = 15000, shouldContinue = () => true) {
    if (!shouldContinue()) throw new Error('本轮检查时段已结束');
    const setting = requireSuccess(await this.site.api('sysSettingItem', {}, 'GET', true, timeoutMs));
    if (!shouldContinue()) throw new Error('本轮检查时段已结束');
    const release = requireSuccess(await this.site.api('getDictionaryValueByKey', { dictKey: 'endTimeOfDay' }, 'GET', true, timeoutMs));
    if (!shouldContinue()) throw new Error('本轮检查时段已结束');
    const user = requireSuccess(await this.site.api('usrEmployeeItem', {}, 'POST', true, timeoutMs));
    if (!shouldContinue()) throw new Error('本轮检查时段已结束');
    const campuses = requireSuccess(await this.site.api('bizCampusList', {}, 'GET', true, timeoutMs));
    this.state.user = { name: user.name, account: this.site.auth.no };
    this.user = user;
    this.state.rules = { releaseHour: Number(release.data || 24), maxDays: setting.maxAppointDay, maxSlots: setting.maxAppointNum };
    this.state.rules.autoBlacklist = typeof setting.autoBlacklist === 'boolean' ? setting.autoBlacklist : null;
    this.state.campuses = campuses.map(x => ({ id: x.id, name: x.name }));
    this.state.connected = true;
    this.metadataAt = Date.now();
  }
  async records(timeoutMs = 15000) {
    const r = await this.site.api('bizLiveList', { PageIndex: 1, PageSize: 100, OrderType: 2,
      parentEmployee: this.site.auth.no, filterUserVideoAndRecordVideo: true,
      startTimeBegin: chinaDate(this.now()) + ' 00:00:00' }, 'GET', true, timeoutMs);
    const data = requireSuccess(r);
    if (!Array.isArray(data) || Number(r.query?.recordCount || 0) > 100) throw new Error('预约记录不完整，暂不提交新预约');
    if (data.some(x => x.employeeNo !== this.site.auth.no && !x.listLiveEmployee?.some(y => y.employeeNo === this.site.auth.no))) throw new Error('预约记录归属校验失败');
    const records = data.filter(x => Number(x.status) === 1 && Number(x.reviewStatus) !== 1 && x.endTime?.time > this.now()).map(minimalRecord);
    this.state.records = records;
    this.recordsAt = this.now();
    return records;
  }
  inHorizon(date) {
    const today = chinaDate(this.now()), rules = this.state.rules;
    const afterRelease = this.now() >= stamp(today, String(rules.releaseHour).padStart(2, '0') + ':00');
    return date >= today && date <= addDays(today, rules.maxDays - 1 + Number(afterRelease));
  }
  async readRooms(campusId, date, stopAtPreferredPair = false, shouldContinue = () => true, timeoutMs = 15000) {
    const key = `${campusId}|${date}`, saved = this.roomCache.get(key);
    const cached = stopAtPreferredPair && saved && this.now() - saved.at < 300000;
    const list = cached ? saved.list : requireSuccess(await this.site.api('pubAllRecordEquipmentList', { campusId }, 'GET', true, timeoutMs));
    if (!Array.isArray(list)) throw new Error('教室列表结构发生变化');
    const cache = cached ? saved : { at: this.now(), list, exams: new Map() }, rooms = [];
    let lastFailure = null; this.state.scanFailures = [];
    // At most two rooms in flight; release checks start no faster than one batch per 500ms.
    for (let i = 0; i < list.length; i += 2) {
      if (!shouldContinue()) { const error = new Error('采样让位给自动预约'); error.code = 'MONITOR_DEFERRED'; throw error; }
      const started = this.now();
      const outcomes = await Promise.allSettled(list.slice(i, i + 2).map(async room => {
        if (!shouldContinue()) { const error = new Error('本轮读取时段已结束'); error.code = 'MONITOR_DEFERRED'; throw error; }
        if (stopAtPreferredPair && Number(room.isAvailable) !== 0) return null;
        if (!room.recordEquipmentScheduleId) return { id: room.id, name: room.name, building: room.teachBuildingName, closed: true, slots: [] };
        let table;
        try { table = await this.site.api('bizLiveListTimeTable', { parentRecordEquipmentId: room.id, selectDate: date }, 'GET', true, timeoutMs); }
        catch (e) { e.room = room.name; throw e; }
        requireSuccess(table);
        if (!shouldContinue()) { const error = new Error('本轮读取时段已结束'); error.code = 'MONITOR_DEFERRED'; throw error; }
        const exams = cached && cache.exams.has(room.id) ? cache.exams.get(room.id) : requireSuccess(await this.site.api('pubRecordEquipmentExamList', {
          recordEquipmentId: room.id, startTime: date + ' 00:00:00', endTime: date + ' 23:59:59' }, 'GET', true, timeoutMs));
        if (!Array.isArray(exams)) throw new Error('考试占用信息结构发生变化，已停止预约');
        cache.exams.set(room.id, exams);
        return { id: room.id, name: room.name, building: room.teachBuildingName, defaultAi: room.defaultAi,
          closed: Number(room.isAvailable) !== 0,
          slots: scheduleSlots(table, room, date, this.now(), exams, this.inHorizon(date)) };
      }));
      const failures = outcomes.filter(r => r.status === 'rejected');
      const fatal = failures.find(r => !transient(r.reason) || r.reason.retryAfterMs > 0);
      if (fatal || (failures.length && !(stopAtPreferredPair && this.state.burst?.active))) throw (fatal || failures[0]).reason;
      for (const failure of failures) {
        lastFailure = failure.reason;
        this.state.scanFailures.push({ room: lastFailure.room || '', endpoint: lastFailure.endpoint || 'bizLiveListTimeTable', elapsedMs: lastFailure.elapsedMs ?? null, code: lastFailure.code || lastFailure.name });
        this.log(`这间教室暂未读到，继续检查其他教室：${readableError(lastFailure)}`, 'warning');
      }
      rooms.push(...outcomes.filter(r => r.status === 'fulfilled').map(r => r.value).filter(Boolean));
      if (stopAtPreferredPair && candidates(rooms, this.config.fallback, this.config.periods).some(p => p.rank === 0)) break;
      if (this.state.burst?.active && i + 2 < list.length) await this.wait(Math.max(0, 500 - (this.now() - started)));
    }
    this.roomCache.set(key, cache);
    if (lastFailure && !candidates(rooms, this.config.fallback, this.config.periods).length) throw lastFailure;
    return rooms;
  }
  async scan(date, stopAtPreferredPair = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('请选择预约日期');
    if (!this.inHorizon(date)) { this.state.previews = []; this.state.scanNote = '目标日期尚未开放预约'; return []; }
    const rooms = await this.readRooms(this.config.campusId, date, stopAtPreferredPair,
      () => this.state.burst?.active ? this.now() < this.state.burst.endsAt && (this.state.burst.manual || this.config.enabled) : !this.releasePriority(), this.state.burst?.active ? this.state.burst.readTimeoutMs || 6000 : 15000);
    const selectable = this.state.burst?.kind === 'surplus' ? rooms.map(room => ({ ...room,
      slots: room.slots.map(slot => ({ ...slot, free: slot.free && stamp(date, slot.start) >= this.state.burst.minStartAt })) })) : rooms;
    const plans = candidates(selectable, this.config.fallback, this.config.periods);
    this.state.previews = plans.slice(0, 12).map(p => ({ room: p.room.name, building: p.room.building, roomId: p.room.id,
      times: p.slots.map(s => `${s.start}—${s.end}`), count: p.slots.length, preferred: p.rank === 0 }));
    this.state.scanNote = (plans.length ? `找到${plans.filter(p => p.slots.length === 2).length}组连续时段 · 本轮已检查${rooms.length}间` : '本轮没有符合偏好的空闲教室') + (this.state.scanFailures?.length ? ` · ${this.state.scanFailures.length}间暂未读到，未计为空闲` : '');
    this.state.scanAt = new Date().toISOString();
    return plans;
  }
  async overview(campusId, date, shouldContinue = () => true) {
    if (![1, 2].includes(Number(campusId)) || !validDate(date)) throw new Error('请选择有效的校区和日期');
    if (this.state.busy) throw new Error('平台正在检查或预约，请稍后刷新课表');
    if (this.releasePriority()) throw new Error('已进入放号准备时间，优先处理自动预约，请等本轮结束后刷新课表');
    if (this.now() < (this.journal.cooldownAt || 0)) throw new Error('平台要求等待后再读取课表，请稍后刷新');
    const phase = this.state.phase;
    this.state.busy = true;
    try {
      if (!this.state.connected || !this.metadataAt || Date.now() - this.metadataAt > 90000) await this.metadata();
      const rooms = await this.readRooms(Number(campusId), date, false, () => shouldContinue() && !this.releasePriority());
      return { campusId: Number(campusId), date, opened: this.inHorizon(date), fetchedAt: new Date().toISOString(),
        rooms: rooms.map(({ id, name, building, closed, slots }) => ({ id, name, building, closed,
          slots: slots.map(({ start, end, period, status, bookers, pending }) => ({ start, end, period, status, bookers, pending })) })) };
    } finally { this.state.busy = false; this.state.phase = ['等待放号', '自动预约已暂停'].includes(phase) ? (this.config.enabled ? '等待放号' : '自动预约已暂停') : phase; }
  }
  async check() {
    if (this.state.busy) throw new Error('上一轮仍在运行');
    if (this.releasePriority()) throw new Error('已进入放号准备时间，自动预约将优先执行');
    this.state.busy = true; this.state.phase = '检查登录与课表';
    try {
      await this.metadata();
      if (this.releasePriority()) { this.state.phase = '等待放号'; return; }
      await this.records();
      if (this.releasePriority()) { this.state.phase = '等待放号'; return; }
      await this.readAttendance();
      await this.reconcile(); await this.scan(this.target());
      this.state.checkedAt = new Date().toISOString(); this.state.phase = this.config.enabled ? '等待放号' : '自动预约已暂停';
      this.state.error = null; this.log('登录、个人预约记录与课表检查完成');
    } catch (e) {
      if (e.code === 'MONITOR_DEFERRED' && this.releasePriority()) { this.state.phase = '等待放号'; return; }
      this.state.phase = '需要处理'; this.state.error = readableError(e); this.state.connected = false; this.log(this.state.error, 'error'); throw e;
    }
    finally { this.state.busy = false; }
  }
  async prepare(release) {
    if (this.state.busy) return;
    this.preparation = null;
    this.state.busy = true; this.state.phase = '放号前准备';
    try {
      await this.metadata(6000); await this.records(6000); await this.reconcile();
      const rooms = await this.readRooms(this.config.campusId, this.target(), false,
        () => this.config.enabled && this.now() < release - 10000, 6000);
      this.preparation = { date: this.target(), account: this.site.auth.no, recordsAt: this.recordsAt,
        key: JSON.stringify(this.config), own: structuredClone(this.state.records), rooms };
      this.state.preparedRooms = rooms.length; this.state.preparedAt = new Date().toISOString();
      this.log(`放号准备完成：${rooms.length}间教室；放号首轮直接申请已匹配时段，平台确认后再约第二段`);
    } catch (e) {
      if (e.code !== 'MONITOR_DEFERRED') this.log(`放号准备未完成：${readableError(e)}；开抢时继续核对`, 'warning');
    } finally { this.state.busy = false; this.state.phase = this.config.enabled ? '等待放号' : '自动预约已暂停'; }
  }
  async readAttendance() {
    try {
      const working = await this.site.api('bizCheckBlackWorking');
      const stats = await this.site.api('bizUserUseStatics');
      requireSuccess(working); const data = requireSuccess(stats);
      this.state.attendance = { checkedAt: new Date().toISOString(), ruleWorking: typeof working.data === 'boolean' ? working.data : null,
        liveCount: data.liveCount, signCount: data.signCount, absentCount: data.absentCount };
    } catch { this.state.attendance = { error: '当前签到统计暂时未能读取，请在官网核对' }; }
  }
  alertConfirmed(records, uncertain = false) {
    if (!records.length) return;
    try { this.notify(records, uncertain); }
    catch { this.log('预约已经确认，但强提醒未能启动，请查看自己的预约记录', 'warning'); }
  }
  async reconcile() {
    const p = this.journal.pending;
    if (!p) return;
    const found = this.state.records.find(x => x.date === p.date && x.roomId === p.roomId && x.slotId === p.slotId);
    if (found) { this.journal.pending = null; this.save('journal.json', this.journal); this.log('已从平台记录确认此前提交成功', 'success'); this.alertConfirmed([found]); }
    else throw new Error('上次提交结果尚未确认，已停止再次提交；请在官网核对预约记录');
  }
  async bookSlot(room, slot, date) {
    this.journal.pending = { date, roomId: room.id, room: room.name, slotId: slot.id, start: slot.start, submittedAt: new Date().toISOString() };
    this.save('journal.json', this.journal);
    const form = { title: `${this.site.auth.no}${this.user.name}${date.replaceAll('-', '')} ${slot.start}-${slot.end}`,
      parentRecordEquipment: room.id, startTime: `${date} ${slot.start}`, endTime: `${date} ${slot.end}`,
      liveDate: date, speaker: this.user.name, parentEmployee: this.site.auth.no, liveStatus: 0,
      chapter: slot.name, recordEquipmentTimeId: slot.id, startNow: false, majorClass: '', personNumber: '', nameList: '',
      telephone: this.user.telephone || '', remark: '', enableAi: Boolean(room.defaultAi),
      trainingMode: 1, liveEmployeeNo: [this.site.auth.no], teachingDocFileName: '', teachingDocFileSize: 0, sessionId: '' };
    let response, error;
    try { response = await this.site.api('bizLiveItemEdit', form, 'POST', false, 10000); } catch (e) { error = e; }
    if (error?.code === 'RATE_LIMITED') {
      this.journal.pending = null; this.save('journal.json', this.journal);
      this.state.burst.delayMs = Math.max(1000, error.retryAfterMs || 1000); this.state.burst.retries++;
      this.state.burst.retryAfterMs = this.state.burst.delayMs;
      this.journal.cooldownAt = this.now() + this.state.burst.delayMs; this.save('journal.json', this.journal);
      this.log(`提交被明确限流；${(this.state.burst.delayMs / 1000).toFixed(1)}秒内不再申请`, 'warning'); return null;
    }
    if (response && !response.success && !['18000','-10000'].includes(String(response.errorCode))) {
      this.journal.pending = null; this.save('journal.json', this.journal);
      this.log(`未预约成功：${response.message || '时段已被占用'}`, 'warning'); return null;
    }
    let found;
    if (response?.success && Number.isSafeInteger(Number(response.data?.id)) && Number(response.data.id) > 0) {
      const item = requireSuccess(await this.site.api('bizLiveItem', { id: response.data.id }, 'GET', true, 10000));
      if (!item || String(item.id) !== String(response.data.id) || item.employeeNo !== this.site.auth.no
        || item.liveDateTip !== date || String(item.recordEquipmentId) !== String(room.id)
        || String(item.recordEquipmentTimeId) !== String(slot.id) || item.startTimeTip !== slot.start || item.endTimeTip !== slot.end
        || Number(item.status) !== 1 || Number(item.reviewStatus) === 1 || !(item.endTime?.time > this.now())) {
        throw new Error('预约详情未通过归属、时段或状态核验，已保留待核对记录');
      }
      found = minimalRecord(item);
      this.state.records = [...this.state.records.filter(x => x.id !== found.id), found];
    } else {
      const records = await this.records(10000);
      found = records.find(x => x.date === date && x.roomId === room.id && x.slotId === slot.id);
    }
    if (found) {
      this.journal.pending = null; this.save('journal.json', this.journal);
      this.log(`已确认预约：${date} ${room.name} ${slot.start}—${slot.end}（${found.reviewText}）`, 'success');
      return found;
    }
    throw new Error(error ? '提交连接中断，已停止重试并保留待核对记录' : '提交后未能在个人记录中确认，已停止重试');
  }
  async run(manual = false, options = {}) {
    if (this.state.busy) throw new Error('上一轮仍在运行');
    if (!manual && !this.config.enabled) return;
    this.state.busy = true; this.state.phase = '正在匹配教室'; this.state.attempts = 0; this.state.lastResult = null; this.state.error = null; this.state.scanFailures = [];
    const runDay = chinaDate(this.now()), release = Date.parse(`${runDay}T${this.config.releaseTime}+08:00`);
    const surplus = options.kind === 'surplus', date = options.date || this.target(), kind = surplus ? 'surplus' : manual ? 'manual' : 'release';
    const deadline = surplus ? Math.min(this.now() + 90000, options.endsAt) : manual ? this.now() + HOT_WINDOW : release + RELEASE_WINDOW;
    this.state.burst = { active: true, manual, kind, date, minStartAt: this.now() + (surplus ? 1800000 : 0), startsAt: this.now(), endsAt: deadline, hotEndsAt: release + HOT_WINDOW, rounds: 0, retries: 0, delayMs: 500, readTimeoutMs: 6000, failures: [], lastRoundMs: null };
    const confirmedIds = [];
    try {
      const prepared = this.preparation;
      const usePrepared = !manual && !surplus && !this.journal.pending && prepared?.date === date && prepared.account === this.site.auth.no
        && prepared.key === JSON.stringify(this.config) && this.now() >= release && this.now() - release < 10000
        && this.now() - prepared.recordsAt >= 0 && this.now() - prepared.recordsAt <= 120000;
      this.preparation = null;
      let preparedPlans = usePrepared ? candidates(prepared.rooms.map(room => ({ ...room,
        slots: room.slots.map(slot => ({ ...slot, free: slot.availableOnOpen && stamp(date, slot.start) > this.now() })) })), this.config.fallback, this.config.periods) : null;
      let own = null, activeSlots = 0, booked = [], consecutiveErrors = 0;
      const endTime = new Date(deadline).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
      this.log(`${surplus ? '余位检查' : manual ? '即时预约检查' : '放号集中检查'}开始：目标${date}${manual || surplus ? '' : `，前2分钟集中检查，随后限速跟进至${endTime}`}；并行最多2间教室`);
      for (let round = 0; this.now() < deadline; round++) {
        if (!manual && !this.config.enabled) break;
        const roundStart = this.now(); this.state.burst.rounds++; this.state.burst.delayMs = !manual && this.now() >= release + HOT_WINDOW ? 5000 : 500;
        this.state.burst.readTimeoutMs = consecutiveErrors ? 10000 : 6000;
        try {
          if (!own) {
            this.state.burst.stage = '登录与预约规则';
            if (!this.metadataAt || !this.state.rules || Date.now() - this.metadataAt > 300000) await this.metadata(10000);
            this.state.burst.stage = '本人预约记录';
            own = usePrepared ? prepared.own : await this.records(10000); await this.reconcile();
            if (!this.inHorizon(date)) throw new Error('目标日期尚未开放预约，本轮未提交');
            if (own.some(x => x.date === date)) { this.state.phase = '已有目标日期的预约'; this.log('目标日期已有预约，本轮跳过'); return; }
            activeSlots = own.reduce((sum, x) => sum + Math.max(1, String(x.slotId || '').split(',').length), 0);
            if (activeSlots >= this.state.rules.maxSlots) {
              if (surplus) { this.state.burst.stopReason = 'quota'; this.state.phase = '已达预约上限 · 等待已有时段结束'; return; }
              throw new Error('已有预约达到学校课时上限，本轮未提交');
            }
          }
          this.state.phase = surplus ? '正在检查余位' : manual ? '正在匹配教室' : this.now() < release + HOT_WINDOW ? '放号集中检查' : '放号恢复检查';
          this.state.burst.stage = '教室课表';
          const plans = preparedPlans?.length ? preparedPlans : await this.scan(date, true);
          if (preparedPlans?.length) this.log('放号首轮使用两分钟内核验的本人记录与课表候选，直接提交；占用冲突由平台判定');
          preparedPlans = null;
          consecutiveErrors = 0; this.state.connected = true; this.state.error = null;
          for (const plan of plans.slice(0, 3)) {
            if (this.now() >= deadline || activeSlots + plan.slots.length > this.state.rules.maxSlots) continue;
            if (!manual && !this.config.enabled) break;
            this.state.burst.stage = '提交与结果核验'; this.state.attempts++; const first = await this.bookSlot(plan.room, plan.slots[0], date);
            if (!first) { if (this.state.burst.delayMs > 500) break; continue; }
            confirmedIds.push(first.id); booked.push(first);
            if (plan.slots.length === 2 && (manual || this.config.enabled)) {
              let second = null;
              if (this.now() < deadline) { this.state.attempts++; second = await this.bookSlot(plan.room, plan.slots[1], date); }
              if (second) { booked.push(second); confirmedIds.push(second.id); }
              else if (this.config.fallback === 'pair_only') {
                if (this.state.burst.delayMs > 30000) throw new Error('第二段被限流，第一段尚未取消，请在官网处理已确认的单段预约');
                if (this.state.burst.delayMs > 500) await this.wait(this.state.burst.delayMs);
                const cancel = await this.site.api('bizLiveListDelete', { id: first.id }, 'POST', false, 5000);
                const after = await this.records(5000);
                if (!cancel.success || after.some(x => x.id === first.id)) throw new Error('连续两段未能同时预约，第一段取消结果需要在官网核对');
                booked = []; this.log('第二段未成功，已按仅接受连续两段的设置取消本轮第一段', 'warning');
              }
            }
            if (booked.length) break;
          }
        } catch (e) {
          this.state.burst.failures.push({ step: e.endpoint || this.state.burst.stage, room: e.room || null, elapsedMs: e.elapsedMs ?? null, timeoutMs: e.timeoutMs ?? null, code: e.code || e.name,
            requestStage: e.requestStage || null, status: e.status ?? null, headersMs: e.headersMs ?? null, transport: e.transport || null });
          this.state.burst.failures = this.state.burst.failures.slice(-20);
          if (this.journal.pending) throw e;
          if ((!manual && !this.config.enabled) || (e.code === 'MONITOR_DEFERRED' && this.now() >= deadline)) break;
          this.state.burst.retryAfterMs = Math.max(this.state.burst.retryAfterMs || 0, e.retryAfterMs || 0);
          if (e.retryAfterMs) { this.journal.cooldownAt = this.now() + e.retryAfterMs; this.save('journal.json', this.journal); }
          if (manual || surplus || !transient(e)) throw e;
          consecutiveErrors++; this.state.connected = false; this.state.burst.retries++;
          this.state.burst.delayMs = Math.max(this.state.burst.delayMs, Math.min(4000, consecutiveErrors * 1000), e.retryAfterMs || 0);
          this.state.phase = '放号集中检查 · 等待重试'; this.state.error = readableError(e);
          this.log(`${this.state.error}；${(this.state.burst.delayMs / 1000).toFixed(1)}秒后继续`, 'warning');
        }
        this.state.burst.lastRoundMs = this.now() - roundStart;
        if (booked.length || manual || surplus) break;
        if (this.now() < deadline) await this.wait(Math.min(this.state.burst.delayMs, deadline - this.now()));
      }
      this.state.phase = booked.length === 2 ? '连续两段预约成功' : booked.length === 1 ? '已预约一段' : !manual && !this.config.enabled ? '自动预约已暂停' : this.state.error ? '放号窗口结束 · 连接异常' : '本轮未抢到';
      this.state.lastResult = { date, count: booked.length, records: booked, time: new Date().toISOString() };
      this.log(`${this.state.phase}；检查${this.state.burst.rounds}轮，提交${this.state.attempts}次，退避重试${this.state.burst.retries}次`, booked.length ? 'success' : 'warning');
      if (this.config.mode === 'date' && booked.length) { this.config.enabled = false; this.save('config.json', this.config); }
    } catch (e) { this.state.phase = '需要处理'; if (transient(e)) this.state.connected = false; this.state.error = readableError(e); this.log(this.state.error, 'error'); }
    finally {
      const confirmed = this.state.records.filter(r => confirmedIds.includes(r.id));
      this.state.lastResult = { date, count: confirmed.length, records: confirmed, ...this.state.lastResult, kind, phase: this.state.phase, error: this.state.error || null,
        time: new Date().toISOString(), rounds: this.state.burst.rounds, attempts: this.state.attempts, retries: this.state.burst.retries, failures: this.state.burst.failures, roomFailures: this.state.scanFailures || [] };
      if (!manual && !surplus) { this.journal.days[runDay] = this.state.phase; this.state.lastReleaseResult = this.state.lastResult; this.save('release-result.json', this.state.lastResult); }
      this.save('journal.json', this.journal); this.state.busy = false; this.state.burst.active = false;
      this.save('last-result.json', this.state.lastResult || { phase: this.state.phase, error: this.state.error });
      this.alertConfirmed(this.state.records.filter(r => confirmedIds.includes(r.id)), Boolean(this.journal.pending));
    }
  }
}
module.exports = { Engine, candidates, slotsFrom, scheduleSlots, periodOf, chinaDate, addDays, stamp, RELEASE_WINDOW };
