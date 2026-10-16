'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Site, vault } = require('./site');

class Account {
  constructor(dir, engine, siteFactory = dir => new Site(dir), protect = vault) {
    this.dir = dir; this.engine = engine; this.siteFactory = siteFactory; this.protect = protect; this.busy = false;
    this.configured = fs.existsSync(path.join(dir, 'credentials.dpapi'));
    this.account = engine.site.auth.no || '';
    if (this.configured && !this.account) this.account = protect('read', path.join(dir, 'credentials.dpapi')).account;
  }
  publicState() {
    return { configured: this.configured, busy: this.busy,
      maskedAccount: this.account ? this.account.slice(0, 2) + '••••' + this.account.slice(-2) : '' };
  }
  async save(input) {
    input = input && typeof input === 'object' ? input : {};
    if (this.busy || this.engine.state.busy || this.engine.config.enabled || this.engine.journal.pending)
      throw new Error('请先暂停自动预约，等待当前任务与待核对提交处理完成');
    const account = typeof input.account === 'string' ? input.account.trim() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(account) || !password || password.length > 256)
      throw new Error('请填写有效的学校统一认证账号和密码');
    if (this.account && account !== this.account) throw new Error('这台电脑已绑定其他账号；请使用自己的Windows用户安装，不要共用预约账号');
    this.busy = true;
    let stage;
    try {
      stage = fs.mkdtempSync(path.join(this.dir, 'setup-'));
      this.protect('write', path.join(stage, 'credentials.dpapi'), { account, password });
      const candidate = this.siteFactory(stage), result = await candidate.login();
      if (!result.success || !result.data || String(candidate.auth.no) !== account)
        throw new Error('学校统一认证未通过');
      for (const file of ['credentials.dpapi', 'session.dpapi']) {
        fs.copyFileSync(path.join(stage, file), path.join(this.dir, file + '.tmp'));
        fs.renameSync(path.join(this.dir, file + '.tmp'), path.join(this.dir, file));
      }
      candidate.dataDir = this.dir; this.engine.site = candidate; this.engine.preparation = null; this.engine.metadataAt = 0;
      this.engine.state.connected = false; this.engine.state.error = null;
      this.account = account; this.configured = true;
      return this.publicState();
    } catch (error) {
      if (String(error.message).includes('验证码')) throw new Error('学校登录要求验证码，请先在官网完成验证，再重试');
      throw new Error('登录验证未完成，请核对账号密码及网络后重试；未保存本次输入');
    } finally {
      if (stage && path.dirname(path.resolve(stage)) === path.resolve(this.dir)) fs.rmSync(stage, { recursive: true, force: true });
      this.busy = false;
    }
  }
}
module.exports = { Account };
