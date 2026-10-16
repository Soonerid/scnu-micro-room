'use strict';
require('node:fs').mkdirSync(require('node:path').join(__dirname,'..','work','tests'),{recursive:true});
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Engine,candidates,slotsFrom,scheduleSlots,stamp}=require('../engine');
const DATE='2026-10-13',NOW=Date.parse('2026-10-12T20:00:02+08:00');
const times=[{id:1,name:'上午',startTimeTip:'10:30',endTimeTip:'11:20'},{id:2,name:'4',startTimeTip:'14:30',endTimeTip:'15:20'},{id:3,name:'5',startTimeTip:'15:30',endTimeTip:'16:20'},{id:4,name:'6',startTimeTip:'16:30',endTimeTip:'17:20'}];
const table={success:true,data:{listRecordEquipmentTimeDTO:times},list:[{timeTip:DATE,listData:times.map(s=>({recordEquipmentTimeId:s.id,listLive:[]}))}]};
const room={id:36,name:'302C',teachBuildingName:'石牌校区实训中心',isAvailable:0,recordEquipmentScheduleId:4};
class MockSite{
 constructor(mode='ok'){this.auth={no:'demo-student'};this.offset=0;this.mode=mode;this.posts=[];this.own=[];this.tables=0}
 async api(name,p={},method='GET'){
  if(name==='sysSettingItem')return{success:true,data:{maxAppointDay:2,maxAppointNum:4}};
  if(name==='getDictionaryValueByKey')return{success:true,data:{data:'20'}};
  if(name==='usrEmployeeItem')return{success:true,data:{name:'测试用户',telephone:''}};
  if(name==='bizCampusList')return{success:true,data:[{id:1,name:'石牌校区'}]};
  if(name==='bizLiveList')return{success:true,data:this.own,query:{recordCount:this.own.length}};
  if(name==='bizLiveItem')return{success:true,data:this.own.find(x=>x.id===p.id)};
  if(name==='pubAllRecordEquipmentList')return{success:true,data:[room]};
  if(name==='pubRecordEquipmentExamList')return{success:true,data:[]};
  if(name==='bizLiveListTimeTable'){this.tables++;const result=structuredClone(table);result.list[0].timeTip=p.selectDate;return result};
  if(name==='bizLiveItemEdit'){
   this.posts.push(structuredClone(p));
   if(this.mode==='rejectSecond'&&this.posts.length%2===0)return{success:false,message:'时段已占用'};
   if(this.mode!=='lost')this.own.push({id:100+this.posts.length,employeeNo:this.auth.no,liveDateTip:p.liveDate,startTimeTip:p.startTime.slice(-5),endTimeTip:p.endTime.slice(-5),endTime:{time:stamp(p.liveDate,p.endTime.slice(-5))},recordEquipmentId:p.parentRecordEquipment,recordEquipmentName:'302C',teachBuildingName:'石牌校区实训中心',recordEquipmentTimeId:p.recordEquipmentTimeId,status:1,reviewStatus:2,reviewStatusTip:'审核通过'});
   if(this.mode==='acceptedTimeout'||this.mode==='lost')throw Error('network timeout');
   return{success:true,data:{id:100+this.posts.length}};
  }
  if(name==='bizLiveListDelete'){this.own=this.own.filter(x=>x.id!==p.id);return{success:true}};
  throw Error('unexpected endpoint '+name);
 }
}
let id=0;
function engine(mode){const dir=fs.mkdtempSync(path.join(require('node:path').join(__dirname,'..','work','tests'),'case-'));const e=new Engine(dir,new MockSite(mode));e.now=()=>NOW;return e}
test('prefer same-room afternoon pair after 15:00, allow short lesson breaks',()=>{
 const slots=slotsFrom(table,room,DATE,NOW);const p=candidates([{id:36,slots}], 'afternoon');assert.deepEqual(p[0].slots.map(x=>x.id),[3,4]);assert(p.every(x=>x.slots.every(s=>s.start>='12:00')));
 assert.equal(candidates([{id:36,slots:slots.filter(x=>x.id===3)},{id:35,slots:slots.filter(x=>x.id===4)}],'pair_only').length,0);
});
test('school occupancy, exams, closed rooms and malformed rows prevent submission',()=>{
 let t=structuredClone(table);t.list[0].listData[2].listLive=[{liveStatus:3,reviewStatus:2}];assert.equal(slotsFrom(t,room,DATE,NOW)[2].free,false);
 assert.equal(slotsFrom(table,{...room,isAvailable:1},DATE,NOW).length,0);
 assert.equal(slotsFrom(table,room,DATE,NOW,[{startTime:{time:stamp(DATE,'15:00')},endTime:{time:stamp(DATE,'17:30')}}])[2].free,false);
 t.list[0].listData.splice(2,1);assert.throws(()=>slotsFrom(t,room,DATE,NOW),/结构/);
});
test('successful two-slot submission is confirmed and repeat runs make no extra bookings',async()=>{
 const e=engine();await e.run(true);assert.equal(e.state.lastResult.count,2);assert.deepEqual(e.site.posts.map(p=>p.recordEquipmentTimeId),[3,4]);assert(e.site.posts.every(p=>p.parentRecordEquipment===36));assert.equal(e.journal.pending,null);await e.run(true);assert.equal(e.site.posts.length,2);
});
test('a response lost after server accepted is reconciled without duplicate submission',async()=>{
 const e=engine('acceptedTimeout');await e.run(true);assert.equal(e.state.lastResult.count,2);assert.equal(e.site.posts.length,2);assert.equal(e.journal.pending,null);
});
test('unknown submission result blocks later retries even after restart',async()=>{
 const e=engine('lost');await e.run(true);assert(e.journal.pending);assert.equal(e.site.posts.length,1);await e.run(true);assert.equal(e.site.posts.length,1);const restored=new Engine(e.dir,e.site);restored.now=()=>NOW;await restored.run(true);assert.equal(e.site.posts.length,1);assert(restored.journal.pending);
});
test('pair-only mode removes only this run first slot when second is rejected',async()=>{
 const e=engine('rejectSecond');e.config.fallback='pair_only';await e.run(true);assert.equal(e.state.lastResult.count,0);assert.equal(e.site.own.length,0);assert.equal(e.site.posts.length,4);
});
test('fallback mode keeps the confirmed first slot when second is rejected',async()=>{
 const e=engine('rejectSecond');await e.run(true);assert.equal(e.state.lastResult.count,1);assert.equal(e.site.own.length,1);
});
test('school four-slot quota and unopened target date stop new submissions',async()=>{
 const e=engine();e.config.mode='tomorrow';e.site.own=Array.from({length:4},(_,i)=>({id:i,employeeNo:e.site.auth.no,liveDateTip:'2026-10-14',endTime:{time:stamp('2026-10-14','17:20')},status:1,reviewStatus:2}));await e.run(true);assert.equal(e.site.posts.length,0);assert.match(e.state.error,/上限/);
 const e2=engine();e2.config.mode='date';e2.config.date='2026-10-15';await e2.run(true);assert.equal(e2.site.posts.length,0);assert.match(e2.state.error,/尚未开放/);
});
test('timer prepares once before release, runs once at release, stays paused, skips stale releases',()=>{
 const e=engine();e.config.enabled=true;let now=NOW-30000;e.now=()=>now;let prep=0,runs=0;e.prepare=async()=>{prep++};e.run=()=>{runs++;e.journal.days['2026-10-12']='done'};
 e.checkSurplus=async()=>{};
 e.tick();e.tick();assert.equal(prep,1);assert.equal(runs,0);now=NOW;e.tick();e.tick();assert.equal(runs,1);
 e.journal.days={};e.config.enabled=false;e.tick();assert.equal(runs,1);e.config.enabled=true;now=NOW+1260000;e.tick();assert.equal(runs,1);
});
test('selected periods constrain bookings; afternoon after 15 wins; pairs never cross periods',()=>{
 const slots=[['09:00','09:50'],['10:00','10:50'],['14:30','15:20'],['15:30','16:20'],['16:30','17:20'],['17:30','18:20'],['18:30','19:20'],['19:30','20:20']].map(([start,end],index)=>({id:index,start,end,index,free:true}));
 const rooms=[{id:1,slots}];assert.equal(candidates(rooms,'allow_single',['morning','afternoon','evening'])[0].slots[0].start,'15:30');
 assert(candidates(rooms,'pair_only',['morning']).every(p=>p.slots.length===2&&p.slots[0].start<'12:00'));
 assert.equal(candidates(rooms,'pair_only',['evening'])[0].slots[0].start,'18:30');
 assert(candidates(rooms,'pair_only',['afternoon','evening']).every(p=>!(p.slots[0].start==='17:30'&&p.slots[1].start==='18:30')));
});
test('overview projects only names; rejected records release slots; unopen and expired are not free',()=>{
 const t=structuredClone(table);t.list[0].listData[1].listLive=[{liveStatus:0,reviewStatus:2,employeeName:'姓名测试',employeeNo:'private-id',telephone:'private-phone',title:'private-title'}];
 t.list[0].listData[2].listLive=[{liveStatus:0,reviewStatus:1,employeeName:'被拒记录'}];
 const s=scheduleSlots(t,room,DATE,NOW);assert.deepEqual(s[1].bookers,['姓名测试']);assert.equal(s[1].status,'booked');assert.equal(s[2].free,true);
 const encoded=JSON.stringify(s);for(const secret of ['private-id','private-phone','private-title','被拒记录'])assert(!encoded.includes(secret));
 assert.equal(scheduleSlots(table,room,DATE,NOW,[],false)[0].status,'unopened');assert.equal(scheduleSlots(table,room,DATE,stamp(DATE,'15:30'))[2].status,'expired');
 assert.equal(scheduleSlots(table,{...room,isAvailable:1},DATE,NOW)[0].status,'closed');
 t.list[0].listData[1].listLive=[{liveStatus:0,reviewStatus:2,speaker:'仅有主讲人'}];assert.deepEqual(scheduleSlots(t,room,DATE,NOW)[1].bookers,[]);
});
test('configuration rejects empty or unknown periods and invalid calendar dates, preserves pause while busy',()=>{
 const e=engine();for(const periods of [[],['unknown']])assert.throws(()=>e.setConfig({periods}),/设置/);
 for(const date of ['2026-02-30','2026-13-01'])assert.throws(()=>e.setConfig({mode:'date',date}),/设置/);
 e.state.previews=[{old:true}];e.setConfig({periods:['evening']});assert.deepEqual(e.state.previews,[]);
 e.state.busy=true;assert.throws(()=>e.setConfig({periods:['morning']}),/正在/);e.setConfig({enabled:false});assert.equal(e.config.enabled,false);
});
test('overview is read-only, rejects overlapping work, returns real room times without personal identifiers',async()=>{
 const e=engine();e.state.busy=true;await assert.rejects(()=>e.overview(1,DATE),/稍后/);e.state.busy=false;
 const d=await e.overview(1,DATE);assert.equal(d.rooms[0].slots[2].start,'15:30');assert(!JSON.stringify(d).includes('employeeNo'));assert.equal(e.site.posts.length,0);assert.equal(e.state.busy,false);assert.equal(e.config.enabled,false);
});
test('legacy narrow settings migrate to afternoon categories without enabling morning or evening',()=>{
 const dir=fs.mkdtempSync(path.join(require('node:path').join(__dirname,'..','work','tests'),'case-'));fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({enabled:false,campusId:1,mode:'tomorrow',date:'',fallback:'after15',releaseTime:'20:00:02'}));
 const e=new Engine(dir,new MockSite());assert.deepEqual(e.config.periods,['afternoon']);assert.equal(e.config.fallback,'allow_single');
});
test('malformed times or exam payloads fail closed rather than inventing availability',async()=>{
 const t=structuredClone(table);t.data.listRecordEquipmentTimeDTO[0].endTimeTip='invalid';assert.throws(()=>scheduleSlots(t,room,DATE,NOW),/时间结构/);
 const e=engine(),original=e.site.api.bind(e.site);e.site.api=async(name,...args)=>name==='pubRecordEquipmentExamList'?{success:true,data:{changed:true}}:original(name,...args);await e.run(true);assert.equal(e.site.posts.length,0);assert.match(e.state.error,/考试占用/);
});
test('visualization cannot delay the release window; pausing during a read remains paused',async()=>{
 const e=engine();e.config.enabled=true;await assert.rejects(()=>e.overview(1,DATE),/放号准备/);assert.equal(e.site.tables,0);
 e.now=()=>NOW-120000;e.state.phase='等待放号';const original=e.readRooms.bind(e);e.readRooms=async(...args)=>{e.setConfig({enabled:false});return original(...args)};
 await e.overview(1,DATE);assert.equal(e.config.enabled,false);assert.equal(e.state.phase,'自动预约已暂停');assert.equal(e.site.posts.length,0);
});
test('strong success reminder follows confirmed records, excludes cancelled strict pairs and unconfirmed requests',async()=>{
 const cases=[['ok',false,2],['rejectSecond',true,0],['rejectSecond',false,1],['lost',false,0],['acceptedTimeout',false,2]];
 for(const [mode,strict,count] of cases){const e=engine(mode),alerts=[];e.notify=(records,uncertain)=>alerts.push({records,uncertain});if(strict)e.config.fallback='pair_only';await e.run(true);assert.equal(alerts.flatMap(x=>x.records).length,count);const before=alerts.length;await e.run(true);assert.equal(alerts.length,before)}
});
test('notification failure does not undo the successfully confirmed reservation',async()=>{
 const e=engine();e.notify=()=>{throw Error('alert process failed')};await e.run(true);assert.equal(e.state.lastResult.count,2);assert(e.state.logs.some(x=>/强提醒未能启动/.test(x.message)));
});
function rapidEngine(){const e=engine();e.config.enabled=true;e.config.releaseTime='20:00:02';let clock=NOW;const waits=[];e.now=()=>clock;e.wait=async ms=>{assert(ms>=0);waits.push(ms);clock+=ms};return{e,waits,time:t=>clock=t,elapsed:()=>clock-NOW}}
test('a timeout before any submission is retried within the same release window',async()=>{
 const {e,waits}=rapidEngine(),original=e.site.api.bind(e.site);let reads=0;e.site.api=async(name,...args)=>{if(name==='bizLiveList'&&!reads++)throw Error('fetch failed');return original(name,...args)};await e.run();assert.equal(e.state.lastResult.count,2);assert.equal(e.state.burst.rounds,2);assert.equal(e.state.burst.retries,1);assert.equal(waits[0],1000);assert.equal(e.state.attempts,2);assert.equal(e.state.error,null);
});
test('release checks continue past three empty scans and submit as soon as a pair appears',async()=>{
 const {e,waits}=rapidEngine(),original=e.site.api.bind(e.site);let scans=0;e.site.api=async(name,...args)=>{const r=await original(name,...args);if(name==='bizLiveListTimeTable'&&++scans<=4)for(const s of r.list[0].listData)s.listLive=[{liveStatus:0,reviewStatus:2,employeeName:'已占用'}];return r};await e.run();assert.equal(e.state.burst.rounds,5);assert.equal(e.state.lastResult.count,2);assert.equal(e.site.posts.length,2);assert.deepEqual(waits,[500,500,500,500]);
});
test('an empty release window stops at twenty minutes, while unknown submissions are never replayed',async()=>{
 const {e,elapsed,waits}=rapidEngine(),original=e.site.api.bind(e.site);e.checkSurplus=async()=>{};e.site.api=async(name,...args)=>{const r=await original(name,...args);if(name==='bizLiveListTimeTable')for(const s of r.list[0].listData)s.listLive=[{liveStatus:0,reviewStatus:2,employeeName:'已占用'}];return r};await e.run();assert.equal(elapsed(),1200000);assert(waits.includes(5000));assert.equal(e.state.burst.active,false);assert.equal(e.site.posts.length,0);const rounds=e.state.burst.rounds;e.tick();assert.equal(e.state.burst.rounds,rounds);
 const lost=rapidEngine();lost.e.site.mode='lost';await lost.e.run();assert.equal(lost.e.site.posts.length,1);assert.equal(lost.e.state.attempts,1);assert(lost.e.journal.pending);assert.equal(lost.e.state.burst.retries,0);
});
test('preparation caches room and exam metadata for the newly released date, including exact 20:00',async()=>{
 const {e,time}=rapidEngine();e.config.mode='newest';e.config.releaseTime='20:00:00';const release=Date.parse('2026-10-12T20:00:00+08:00'),original=e.site.api.bind(e.site),calls={};e.site.api=async(name,...args)=>{calls[name]=(calls[name]||0)+1;return original(name,...args)};time(release-60000);await e.prepare(release);assert.equal(e.site.posts.length,0);assert.equal(e.state.preparedRooms,1);assert.equal(e.inHorizon('2026-10-14'),false);time(release);assert.equal(e.inHorizon('2026-10-14'),true);await e.run();assert.equal(e.state.lastResult.date,'2026-10-14');assert.equal(e.site.posts.length,2);assert.equal(calls.pubAllRecordEquipmentList,1);assert.equal(calls.pubRecordEquipmentExamList,1);assert.equal(calls.bizLiveListTimeTable,1);
});
test('429 read backoff follows Retry-After and explicit write rejection does not create an unknown pending record',async()=>{
 const first=rapidEngine(),orig=first.e.site.api.bind(first.e.site);let once=true;first.e.site.api=async(name,...args)=>{if(name==='bizLiveListTimeTable'&&once){once=false;const e=Error('学校服务器限流');e.retryable=true;e.code='RATE_LIMITED';e.retryAfterMs=3000;throw e}return orig(name,...args)};await first.e.run();assert.equal(first.waits[0],3000);assert.equal(first.e.state.lastResult.count,2);
 const second=rapidEngine(),original=second.e.site.api.bind(second.e.site);let limited=true;second.e.site.api=async(name,p,...args)=>{if(name==='bizLiveItemEdit'&&limited){limited=false;second.e.site.posts.push(p);const e=Error('学校服务器限流');e.code='RATE_LIMITED';e.retryAfterMs=2500;throw e}return original(name,p,...args)};await second.e.run();assert.equal(second.waits[0],2500);assert.equal(second.e.state.lastResult.count,2);assert.equal(second.e.journal.pending,null);assert.equal(second.e.state.attempts,3);
});
test('room reads are limited to two in flight and wait for a failed batch to settle before retry',async()=>{
 const {e,waits}=rapidEngine(),original=e.site.api.bind(e.site);let active=0,max=0,roomQueries=0;e.site.api=async(name,p,...args)=>{if(name==='pubAllRecordEquipmentList')return{success:true,data:Array.from({length:5},(_,i)=>({...room,id:i+1}))};if(name==='bizLiveListTimeTable'){active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;roomQueries++;}return original(name,p,...args)};await e.metadata();e.state.burst={active:true,manual:false,endsAt:NOW+120000};await e.readRooms(1,DATE,false,()=>true,2500);assert.equal(max,2);assert.equal(roomQueries,5);assert.deepEqual(waits,[500,500]);
 let resolved=false;e.site.api=async(name,p,...args)=>{if(name==='pubAllRecordEquipmentList')return{success:true,data:[{...room,id:1},{...room,id:2}]};if(name==='bizLiveListTimeTable'){if(p.parentRecordEquipmentId===1)throw Error('fetch failed');await new Promise(r=>setTimeout(r,2));resolved=true;}return original(name,p,...args)};await assert.rejects(()=>e.readRooms(1,DATE,false),/fetch failed/);assert.equal(resolved,true);
});
test('pausing during a release read prevents submission and school quota or malformed data still stop retries',async()=>{
 const {e}=rapidEngine(),original=e.site.api.bind(e.site);e.site.api=async(name,...args)=>{const r=await original(name,...args);if(name==='bizLiveListTimeTable')e.config.enabled=false;return r};await e.run();assert.equal(e.site.posts.length,0);assert.equal(e.state.phase,'自动预约已暂停');
 const bad=rapidEngine(),api=bad.e.site.api.bind(bad.e.site);bad.e.site.api=async(name,...args)=>name==='pubRecordEquipmentExamList'?{success:true,data:{changed:true}}:api(name,...args);await bad.e.run();assert.equal(bad.e.state.burst.rounds,1);assert.equal(bad.e.state.burst.retries,0);assert.equal(bad.e.site.posts.length,0);
});
test('regular reads yield before the release window and foreground checks cannot occupy the burst',async()=>{
 const {e,time}=rapidEngine();time(NOW-80000);assert(e.releasePriority());await assert.rejects(()=>e.check(),/放号准备/);assert.equal(e.site.tables,0);
 time(NOW-100000);const original=e.site.api.bind(e.site);e.site.api=async(name,p,...args)=>{if(name==='pubAllRecordEquipmentList')return{success:true,data:Array.from({length:4},(_,i)=>({...room,id:i+1}))};const r=await original(name,p,...args);if(name==='bizLiveListTimeTable')time(NOW-80000);return r};await assert.rejects(()=>e.overview(1,DATE),e=>e.code==='MONITOR_DEFERRED');assert.equal(e.site.tables,2);assert.equal(e.state.busy,false);
});
test('a rate-limited second slot in strict pair mode waits, cancels this first slot, and does not falsely report it as a pair',async()=>{
 const {e,waits}=rapidEngine();e.config.fallback='pair_only';const original=e.site.api.bind(e.site);let posts=0;e.site.api=async(name,p,...args)=>{if(name==='bizLiveItemEdit'&&++posts===2){e.site.posts.push(p);const err=Error('limited');err.code='RATE_LIMITED';err.retryAfterMs=2000;throw err}return original(name,p,...args)};await e.run();assert(waits.includes(2000));assert(!e.site.own.some(r=>r.id===101));assert.equal(e.state.lastResult.count,2);assert.equal(e.site.own.length,2);assert.equal(e.journal.pending,null);
});
test('school responses taking 3.5 seconds still reach submission instead of timing out on every round',async()=>{
 const {e,time}=rapidEngine(),original=e.site.api.bind(e.site);
 e.site.api=async(name,p,method,reauth,timeoutMs=15000)=>{const elapsed=Math.min(3500,timeoutMs);time(e.now()+elapsed);if(timeoutMs<3500){const err=Error('operation aborted due to timeout');err.name='TimeoutError';throw err}return original(name,p,method)};
 await e.run();assert.equal(e.state.lastResult.count,2);assert.equal(e.site.posts.length,2);assert.equal(e.journal.pending,null);
});
test('one slow room does not discard another room with a verified preferred pair',async()=>{
 const {e,time}=rapidEngine(),original=e.site.api.bind(e.site);
 e.site.api=async(name,p,...args)=>{if(name==='pubAllRecordEquipmentList')return{success:true,data:[{...room,id:1},{...room,id:2}]};if(name==='bizLiveListTimeTable'&&p.parentRecordEquipmentId===1){time(e.now()+6000);const err=Error('operation aborted due to timeout');err.name='TimeoutError';throw err}return original(name,p,...args)};
 await e.run();assert.equal(e.state.lastResult.count,2);assert(e.site.posts.every(p=>p.parentRecordEquipment===2));assert.equal(e.state.burst.rounds,1);
});
test('an available pair appearing after the first two minutes is still attempted during the recovery period',async()=>{
 const {e,elapsed}=rapidEngine(),original=e.site.api.bind(e.site);
 e.site.api=async(name,...args)=>{const r=await original(name,...args);if(name==='bizLiveListTimeTable'&&elapsed()<125000)for(const s of r.list[0].listData)s.listLive=[{liveStatus:0,reviewStatus:2,employeeName:'已占用'}];return r};
 await e.run();assert.equal(e.state.lastResult.count,2);assert(elapsed()>=125000);assert.equal(e.site.posts.length,2);
});
test('prepared rules remain reusable after ninety seconds while current personal bookings are still checked',async()=>{
 const {e}=rapidEngine();await e.metadata();e.metadataAt=Date.now()-100000;const original=e.site.api.bind(e.site);let ownReads=0;
 e.site.api=async(name,...args)=>{if(name==='sysSettingItem')throw Error('unexpected redundant metadata read');if(name==='bizLiveList')ownReads++;return original(name,...args)};
 await e.run();assert.equal(e.state.lastResult.count,2);assert.equal(ownReads,1);assert.equal(e.journal.pending,null);
});
test('malformed data from a second room is fatal even when the first room only timed out',async()=>{
 const {e}=rapidEngine(),original=e.site.api.bind(e.site);
 e.site.api=async(name,p,...args)=>{if(name==='pubAllRecordEquipmentList')return{success:true,data:[{...room,id:1},{...room,id:2}]};if(name==='bizLiveListTimeTable'&&p.parentRecordEquipmentId===1)throw Error('network timeout');const r=await original(name,p,...args);if(name==='bizLiveListTimeTable')r.data.listRecordEquipmentTimeDTO[0].endTimeTip='invalid';return r};
 await e.run();assert.equal(e.site.posts.length,0);assert.match(e.state.error,/时间结构/);assert.equal(e.state.burst.rounds,1);
});
test('a confirmed first slot at the end of the recovery window does not start a late second submission',async()=>{
 const {e,time}=rapidEngine(),original=e.site.api.bind(e.site);time(NOW+1190000);
 e.site.api=async(name,...args)=>{if(name==='bizLiveItemEdit')time(e.now()+8000);else if(name==='bizLiveItem'&&e.site.posts.length)time(e.now()+4000);return original(name,...args)};
 await e.run();assert.equal(e.site.posts.length,1);assert.equal(e.state.lastResult.count,1);assert.equal(e.journal.pending,null);assert.equal(e.state.burst.active,false);
});
test('result summaries survive restart and a later skipped run cannot report the previous successful count',async()=>{
 const {e}=rapidEngine();await e.run();const restored=new Engine(e.dir,e.site);restored.now=()=>NOW;
 assert.equal(restored.publicState().lastResult.count,2);assert.equal(restored.publicState().lastResult.attempts,2);
 await restored.run(true);assert.equal(restored.state.lastResult.count,0);assert.equal(restored.state.lastResult.phase,'已有目标日期的预约');assert.equal(e.site.posts.length,2);
});

test('release submits from verified preparation before a congested personal list can block every request',async()=>{
 const {e,time}=rapidEngine();e.config.mode='newest';const release=NOW,original=e.site.api.bind(e.site);time(release-60000);await e.prepare(release);
 const calls=[];e.site.api=async(name,...args)=>{calls.push(name);if(name==='bizLiveList')throw Object.assign(Error('list timeout'),{retryable:true,code:'REQUEST_TIMEOUT'});return original(name,...args)};
 time(release);await e.run();assert.equal(calls[0],'bizLiveItemEdit');assert.equal(e.site.posts.length,2);assert.equal(e.state.lastResult.count,2);assert(!calls.includes('bizLiveList'));assert.equal(e.journal.pending,null);
});
test('stale preparation is discarded and fresh personal records remain mandatory',async()=>{
 const {e,time}=rapidEngine();e.config.mode='newest';const original=e.site.api.bind(e.site);time(NOW-130000);await e.prepare(NOW);let reads=0;
 e.site.api=async(name,...args)=>{if(name==='bizLiveList')reads++;return original(name,...args)};time(NOW);await e.run();assert(reads>=1);assert.equal(e.state.lastResult.count,2);
});
test('changing preferences invalidates preparation and a prepared full quota still prevents submission',async()=>{
 const {e,time}=rapidEngine();e.config.mode='newest';time(NOW-60000);await e.prepare(NOW);e.setConfig({periods:['evening']});time(NOW);await e.run();assert.equal(e.site.posts.length,0);
 const second=rapidEngine();second.e.config.mode='newest';second.time(NOW-60000);second.e.site.own=Array.from({length:4},(_,i)=>({id:i,employeeNo:second.e.site.auth.no,liveDateTip:'2026-10-13',endTime:{time:stamp('2026-10-13','17:20')},recordEquipmentTimeId:i+1,status:1,reviewStatus:2}));await second.e.prepare(NOW);second.time(NOW);await second.e.run();assert.equal(second.e.site.posts.length,0);assert.match(second.e.state.error,/上限/);
});
test('a returned booking id is checked by its own detail without reading the entire personal list again',async()=>{
 const e=engine(),original=e.site.api.bind(e.site);let lists=0,details=0;
 e.site.api=async(name,...args)=>{if(name==='bizLiveList'&&++lists>1)throw Error('list timeout');if(name==='bizLiveItem')details++;return original(name,...args)};
 await e.run(true);assert.equal(e.state.lastResult.count,2);assert.equal(lists,1);assert.equal(details,2);
});
test('an id detail for another account or a mismatched room never confirms success or enables a second write',async()=>{
 for(const mismatch of ['owner','room','time','rejected']){const e=engine(),original=e.site.api.bind(e.site);e.site.api=async(name,...args)=>{const r=await original(name,...args);if(name==='bizLiveItem'){r.data={...r.data};if(mismatch==='owner')r.data.employeeNo='other-user';if(mismatch==='room')r.data.recordEquipmentId=100;if(mismatch==='time')r.data.startTimeTip='11:00';if(mismatch==='rejected')r.data.reviewStatus=1}return r};await e.run(true);assert.equal(e.site.posts.length,1);assert(e.journal.pending);assert.equal(e.state.lastResult.count,0);}
});
test('a stale candidate explicitly rejected by the school does not wait on the congested personal list',async()=>{
 const {e,time}=rapidEngine();e.config.mode='newest';const original=e.site.api.bind(e.site);time(NOW-60000);await e.prepare(NOW);let rejected=false;
 e.site.api=async(name,p,...args)=>{if(name==='bizLiveList')throw Error('list timeout');if(name==='bizLiveItemEdit'&&!rejected){rejected=true;return{success:false,message:'时段已被占用'}}return original(name,p,...args)};time(NOW);await e.run();assert(rejected);assert.equal(e.state.lastResult.count,2);assert.equal(e.state.attempts,3);assert.equal(e.journal.pending,null);
});
test('detail timeout leaves a pending submission and a later fresh read confirms it without replay',async()=>{
 const e=engine(),original=e.site.api.bind(e.site);e.site.api=async(name,...args)=>{if(name==='bizLiveItem')throw Object.assign(Error('request timeout'),{retryable:true,code:'REQUEST_TIMEOUT'});return original(name,...args)};
 await e.run(true);assert.equal(e.site.posts.length,1);assert.equal(e.state.lastResult.count,0);assert(e.journal.pending);assert.equal(e.state.connected,false);
 const restored=new Engine(e.dir,e.site);restored.now=()=>NOW;await restored.run(true);assert.equal(e.site.posts.length,1);assert.equal(restored.journal.pending,null);assert.equal(restored.state.records.length,1);
});
test('preparation preserves exam and administrative occupancy instead of treating unopened cells as free',async()=>{
 const {e,time}=rapidEngine();e.config.mode='newest';const original=e.site.api.bind(e.site);e.site.api=async(name,p,...args)=>{const r=await original(name,p,...args);if(name==='bizLiveListTimeTable')for(const s of r.list[0].listData)s.listLive=[{liveStatus:4,reviewStatus:2}];return r};time(NOW-60000);await e.prepare(NOW);time(NOW);await e.run();assert.equal(e.site.posts.length,0);
});
test('surplus windows open at nine, close at eighteen, resume after the burst, and stay quiet after midnight',()=>{
 const {e,time}=rapidEngine();e.config.releaseTime='20:00:00';
 for(const [clock,active] of [['08:59',false],['09:00',true],['17:59',true],['18:00',false],['19:58',false],['20:19',false],['20:20',true],['23:59',true],['00:01',false]]){time(stamp('2026-10-12',clock));assert.equal(!!e.surplusWindow(),active,clock)}
 time(stamp('2026-10-12','00:01'));assert.equal(e.nextSurplusAt(),stamp('2026-10-12','09:00'));time(stamp('2026-10-12','18:00'));assert.equal(e.nextSurplusAt(),stamp('2026-10-12','20:20'));
});
test('daytime surplus checks already-open dates instead of repeatedly targeting the unopened newest date',async()=>{
 const {e,time}=rapidEngine();e.config.mode='newest';const original=e.site.api.bind(e.site);e.site.api=async(name,p,...args)=>{const r=await original(name,p,...args);if(name==='bizLiveListTimeTable'&&p.selectDate==='2026-10-12')for(const s of r.list[0].listData)s.listLive=[{liveStatus:0,reviewStatus:2}];return r};time(stamp('2026-10-12','09:00'));await e.checkSurplus();assert.deepEqual(e.state.surplus.dates,['2026-10-12','2026-10-13']);assert(e.site.posts.every(p=>p.liveDate==='2026-10-13'));assert.equal(e.state.lastResult.count,2);assert.equal(e.journal.days['2026-10-12'],undefined);assert.equal(e.journal.nextSurplusAt,stamp('2026-10-12','09:10'));
});
test('surplus leaves thirty minutes to arrive and never starts a new write after its daytime boundary',async()=>{
 const {e,time}=rapidEngine();time(stamp('2026-10-12','15:10'));await e.run(false,{kind:'surplus',date:'2026-10-12',endsAt:stamp('2026-10-12','18:00')});assert.equal(e.site.posts.length,1);assert(e.site.posts[0].startTime.endsWith('16:30'));
 const second=rapidEngine(),original=second.e.site.api.bind(second.e.site);second.time(stamp('2026-10-12','17:59'));second.e.site.api=async(name,...args)=>{const r=await original(name,...args);if(name==='bizLiveListTimeTable')second.time(stamp('2026-10-12','18:00'));return r};await second.e.run(false,{kind:'surplus',date:DATE,endsAt:stamp('2026-10-12','18:00')});assert.equal(second.e.site.posts.length,0);
});
test('night surplus persists its five-minute spacing and never overwrites the release diagnosis',async()=>{
 const {e,time}=rapidEngine();e.setConfig({enabled:true});e.state.lastReleaseResult={date:DATE,count:0,attempts:0,rounds:39};e.save('release-result.json',e.state.lastReleaseResult);time(stamp('2026-10-12','21:00'));await e.checkSurplus();assert.equal(e.journal.nextSurplusAt,stamp('2026-10-12','21:05'));assert.equal(e.state.lastReleaseResult.rounds,39);const restored=new Engine(e.dir,e.site);restored.now=()=>stamp('2026-10-12','21:01');let calls=0;restored.checkSurplus=async()=>calls++;restored.tick();assert.equal(calls,0);assert.equal(restored.state.lastReleaseResult.rounds,39);
});
test('a surplus rate limit stops the date loop and its cooldown survives restart',async()=>{
 const {e,time}=rapidEngine();e.setConfig({enabled:true});time(stamp('2026-10-12','21:00'));const original=e.site.api.bind(e.site);let reads=0;e.site.api=async(name,...args)=>{if(name==='bizLiveList'){reads++;throw Object.assign(Error('rate limit'),{retryable:true,code:'RATE_LIMITED',retryAfterMs:1200000})}return original(name,...args)};await e.checkSurplus();assert.equal(reads,1);assert.equal(e.site.posts.length,0);assert.equal(e.journal.nextSurplusAt,stamp('2026-10-12','21:20'));const restored=new Engine(e.dir,e.site);restored.now=()=>stamp('2026-10-12','21:10');restored.tick();assert.equal(reads,1);
});
test('reaching quota during surplus is a normal waiting state and stops before scanning any date',async()=>{
 const {e,time}=rapidEngine();time(stamp('2026-10-12','09:00'));e.site.own=Array.from({length:4},(_,i)=>({id:i,employeeNo:e.site.auth.no,liveDateTip:DATE,endTime:{time:stamp(DATE,'17:20')},recordEquipmentTimeId:i+1,status:1,reviewStatus:2}));await e.checkSurplus();assert.equal(e.site.posts.length,0);assert.equal(e.site.tables,0);assert.equal(e.state.error,null);assert.match(e.state.phase,/上限/);assert.equal(e.state.surplus.dates.length,1);
});
test('a late room response at midnight stops before exam reads or reservation writes',async()=>{
 const {e,time}=rapidEngine(),original=e.site.api.bind(e.site);time(stamp('2026-10-12','23:59'));let exams=0;e.site.api=async(name,...args)=>{if(name==='pubRecordEquipmentExamList')exams++;const r=await original(name,...args);if(name==='bizLiveListTimeTable')time(stamp('2026-10-13','00:00'));return r};await e.run(false,{kind:'surplus',date:DATE,endsAt:stamp('2026-10-13','00:00')});assert.equal(e.site.posts.length,0);assert.equal(exams,0);assert.equal(e.state.error,null);
});
