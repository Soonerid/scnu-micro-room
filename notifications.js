'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
class Notifications {
  constructor(dir, launch) {
    this.dir = dir; this.file = path.join(dir, 'notification.json'); this.child = null; this.lastLaunch = 0; this.error = null;
    this.launch = launch || (() => spawn('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'alert.ps1'), '-DataDirectory', dir], { windowsHide: true, stdio: 'ignore' }));
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { seen: [], active: null };
  }
  save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2)); fs.renameSync(this.file + '.tmp', this.file); }
  readAck() {
    const file = path.join(this.dir, 'notification-ack.json');
    if (!fs.existsSync(file)) return;
    let ack; try { ack = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    if (this.data.active?.id === ack.id && !this.data.active.acknowledgedAt) { this.data.active.acknowledgedAt = ack.time; this.save(); }
  }
  confirmed(records, uncertain = false) {
    const fresh = records.filter(r => !this.data.seen.includes(String(r.id)));
    if (!fresh.length) return;
    this.data.seen = [...this.data.seen, ...fresh.map(r => String(r.id))].slice(-100);
    const previous = this.data.active && !this.data.active.acknowledgedAt && !this.data.active.test ? this.data.active.records : [];
    const merged = [...new Map([...previous, ...fresh].map(r => [String(r.id), r])).values()];
    this.create(merged, uncertain, false);
  }
  create(records, uncertain, test) {
    this.data.active = { id: crypto.randomUUID(), title: test ? '静音提醒测试 · 没有实际预约' : uncertain ? '已确认部分预约 · 还有提交待核对'
      : records.some(r => Number(r.review) === 0) ? '预约已提交 · 等待平台审核' : '微格教室已确认预约',
      records: records.map(({ id, date, start, end, room, building, reviewText }) => ({ id, date, start, end, room, building, reviewText })),
      uncertain, test, createdAt: new Date().toISOString(), acknowledgedAt: null };
    this.save(); this.tick();
  }
  test() {
    this.readAck();
    if (this.data.active && !this.data.active.acknowledgedAt && !this.data.active.test) throw new Error('请先确认当前真实预约提醒');
    const date = new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
    this.create([{ date, start: '15:30', end: '16:20', room: '实训室 · 演示', building: '石牌校区', reviewText: '没有提交预约' },
      { date, start: '16:30', end: '17:20', room: '实训室 · 演示', building: '石牌校区', reviewText: '没有提交预约' }], false, true);
  }
  acknowledge(id) {
    if (this.data.active?.id !== id) throw new Error('提醒已经更新，请重新查看');
    this.data.active.acknowledgedAt = new Date().toISOString(); this.save();
  }
  tick() {
    this.readAck();
    if (!this.data.active || this.data.active.acknowledgedAt || this.child || Date.now() - this.lastLaunch < 10000) return;
    this.lastLaunch = Date.now();
    try {
      const child = this.launch(); this.child = child; this.error = null;
      child.on('error', () => { this.child = null; this.error = '桌面提醒未能启动，请在面板查看预约并重试提醒测试'; });
      child.on('exit', code => { this.child = null; if (code) this.error = '桌面提醒启动失败，请查看面板中的预约结果'; });
      child.unref();
    } catch { this.error = '桌面提醒未能启动，请在面板查看预约'; }
  }
  publicState() {
    this.readAck();
    const file = path.join(this.dir, 'notification-health.json');
    let health = null; try { health = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    return { active: this.data.active && !this.data.active.acknowledgedAt ? this.data.active : null, error: this.error,
      desktopVisible: Boolean(this.data.active && !this.data.active.acknowledgedAt && health?.visible && health.id === this.data.active.id && Date.now() - Date.parse(health.time) < 5000),
      desktopPlacement: this.data.active && !this.data.active.acknowledgedAt && health?.id === this.data.active.id ? { left: health.left, top: health.top, width: health.width, height: health.height, workRight: health.workRight, workBottom: health.workBottom, quiet: health.quiet, activated: health.activated } : null };
  }
}
module.exports = { Notifications };
