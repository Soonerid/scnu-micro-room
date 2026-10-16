'use strict';
require('node:fs').mkdirSync(require('node:path').join(__dirname,'..','work','tests'),{recursive:true});
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const {Notifications}=require('../notifications');
const record={id:1,date:'2026-10-13',start:'15:30',end:'16:20',room:'测试教室',building:'测试校区',review:2,reviewText:'审核通过'};
function setup(){const dir=fs.mkdtempSync(path.join(require('node:path').join(__dirname,'..','work','tests'),'notify-'));let launches=0;const launch=()=>{launches++;const child=new EventEmitter();child.unref=()=>{};return child};const n=new Notifications(dir,launch);return{dir,n,launch,count:()=>launches}}
test('confirmed records trigger one grouped popup; repeat observations and restarts do not duplicate successes',()=>{
 const s=setup();s.n.confirmed([record,{...record,id:2,start:'16:30',end:'17:20'}]);assert.equal(s.count(),1);assert.equal(s.n.publicState().active.records.length,2);
 s.n.confirmed([record]);assert.equal(s.count(),1);assert.equal(s.n.data.seen.length,2);
 const restored=new Notifications(s.dir,s.launch);restored.confirmed([record]);assert.equal(s.count(),1);assert.equal(restored.data.active.records.length,2);
});
test('acknowledgement persists, stale acknowledgements cannot dismiss a new real alert, tests do not replace real success',()=>{
 const s=setup();s.n.test();const testId=s.n.data.active.id;s.n.confirmed([record]);assert.throws(()=>s.n.acknowledge(testId),/更新/);assert.throws(()=>s.n.test(),/真实/);
 fs.writeFileSync(path.join(s.dir,'notification-health.json'),JSON.stringify({id:s.n.data.active.id,visible:true,time:new Date().toISOString()}));
 s.n.acknowledge(s.n.data.active.id);assert.equal(s.n.publicState().active,null);assert.equal(s.n.publicState().desktopVisible,false);assert.equal(new Notifications(s.dir,s.launch).publicState().active,null);
});
test('native acknowledgement is consumed; a concurrent partial file is tolerated; test alerts never enter confirmed history',()=>{
 const s=setup();s.n.test();assert.equal(s.n.data.seen.length,0);const ack=path.join(s.dir,'notification-ack.json');fs.writeFileSync(ack,'{');assert.doesNotThrow(()=>s.n.publicState());
 fs.writeFileSync(ack,JSON.stringify({id:s.n.data.active.id,time:new Date().toISOString()}));assert.equal(s.n.publicState().active,null);
});
test('pending approvals and unknown second submissions are labelled without claiming two approved slots',()=>{
 const s=setup();s.n.confirmed([{...record,review:0,reviewText:'待审核'}]);assert.match(s.n.data.active.title,/等待平台审核/);
 const s2=setup();s2.n.confirmed([record],true);assert.equal(s2.n.data.active.records.length,1);assert.match(s2.n.data.active.title,/部分/);
});
test('launch failure leaves the visible reminder and confirmed booking intact',()=>{
 const s=setup();const n=new Notifications(s.dir,()=>{throw Error('launcher unavailable')});n.confirmed([record]);assert(n.publicState().active);assert.match(n.publicState().error,/未能启动/);assert.deepEqual(n.data.seen,['1']);
});
