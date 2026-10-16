'use strict';
require('node:fs').mkdirSync(require('node:path').join(__dirname,'..','work','tests'),{recursive:true});
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Monitor,summarize,rowsFrom,csvCell}=require('../monitor');
const NOW=Date.parse('2026-10-12T11:00:00+08:00');
function view(date,name='姓名甲'){return{date,rooms:[{id:1,name:'实训室1',slots:[{start:'15:30',end:'16:20',period:'afternoon',status:'booked',bookers:[name],pending:false},{start:'16:30',end:'17:20',period:'afternoon',status:'free',bookers:[],pending:false}]}]}}
function setup(){const dir=fs.mkdtempSync(path.join(require('node:path').join(__dirname,'..','work','tests'),'monitor-'));let now=NOW,calls=0;const engine={now:()=>now,config:{enabled:true,releaseTime:'20:00:02'},journal:{days:{}},state:{connected:true,busy:false,rules:{maxDays:2,releaseHour:20}},overview:async(campus,date)=>{assert.equal(campus,1);calls++;return view(date)}};return{dir,engine,m:(()=>{const m=new Monitor(dir,path.join(dir,'exports'),engine);m.setEnabled(true);return m})(),time:t=>now=t,calls:()=>calls}}
test('samples only Shipa every eight hours, survives restart, ends after seven days',async()=>{
 const s=setup();await s.m.tick();assert.equal(s.m.samples.length,1);assert.equal(s.calls(),2);await s.m.tick();assert.equal(s.calls(),2);
 s.time(NOW+8*3600000-1);await s.m.tick();assert.equal(s.calls(),2);s.time(NOW+8*3600000);await s.m.tick();assert.equal(s.m.samples.length,2);
 const restored=new Monitor(s.dir,path.join(s.dir,'exports'),s.engine);await restored.tick();assert.equal(s.calls(),4);assert.equal(restored.publicState().intervalHours,8);
 s.time(NOW+7*86400000);await restored.tick();assert.equal(restored.plan.enabled,false);assert.equal(s.calls(),4);assert.throws(()=>restored.setEnabled(true),/结束/);
});
test('repeat snapshots are deduplicated; owner changes and cancellations replace latest occupancy',()=>{
 const a={finishedAt:new Date(NOW).toISOString(),status:'complete',rows:rowsFrom([view('2026-10-13')])};const b={...a,finishedAt:new Date(NOW+1000).toISOString()};
 let r=summarize([a,b]);assert.equal(r.ranking[0].slots,1);assert.equal(r.ranking[0].minutes,50);assert.equal(r.distinctObservedAssignments,1);assert.equal(r.observationDays,1);
 const c={...a,finishedAt:new Date(NOW+2000).toISOString(),rows:rowsFrom([view('2026-10-13','姓名乙')])};r=summarize([a,b,c]);assert.deepEqual(r.ranking.map(x=>x.name),['姓名乙']);assert.equal(r.distinctObservedAssignments,2);
 c.rows[0].status='free';c.rows[0].names=[];assert.equal(summarize([a,c]).ranking.length,0);
});
test('API failures remain failed samples rather than invented empty or successful observations',async()=>{
 const s=setup();s.engine.overview=async()=>{throw Error('fetch failed')};await s.m.tick();assert.equal(s.m.samples.length,0);assert.equal(s.m.plan.failed,1);assert.equal(s.m.plan.lastAttempt.status,'failed');assert.equal(s.m.summary.namedSlots,0);await s.m.tick();assert.equal(s.m.plan.attempts,1);
 const s2=setup();let n=0;s2.engine.overview=async(c,date)=>{if(n++)throw Error('network unavailable');return view(date)};await s2.m.tick();assert.equal(s2.m.samples[0].status,'partial');assert.equal(s2.m.samples[0].observedDates.length,1);assert.equal(s2.m.summary.complete,0);assert.equal(s2.m.plan.failed,0);
});
test('booking release and other active operations have priority; deferred windows are not counted as failures',async()=>{
 const s=setup();s.time(Date.parse('2026-10-12T19:59:00+08:00'));await s.m.tick();assert.equal(s.calls(),0);assert.equal(s.m.plan.attempts,0);
 s.time(NOW);s.engine.state.busy=true;await s.m.tick();assert.equal(s.calls(),0);s.engine.state.busy=false;s.engine.overview=async()=>{const e=Error('deferred');e.code='MONITOR_DEFERRED';throw e};await s.m.tick();assert.equal(s.m.plan.lastWindow,-1);assert.equal(s.m.plan.failed,0);assert.equal(s.m.busy,false);
});
test('sleep gaps are recorded without fabricating missed snapshots and atomic-snapshot recovery prevents double capture',async()=>{
 const s=setup();await s.m.tick();s.time(NOW+24*3600000);await s.m.tick();assert.equal(s.m.plan.skippedWindows,2);assert.equal(s.m.samples.length,2);
 const p=JSON.parse(fs.readFileSync(s.m.planFile));p.lastWindow=-1;fs.writeFileSync(s.m.planFile,JSON.stringify(p));const restored=new Monitor(s.dir,path.join(s.dir,'exports'),s.engine);const before=s.calls();await restored.tick();assert.equal(s.calls(),before);
});
test('stored snapshots omit personal identifiers; UTF-8 CSV preserves names safely against spreadsheet formula injection',async()=>{
 const raw=view('2026-10-13','=HYPERLINK("bad")');raw.rooms[0].employeeNo='private-id';raw.rooms[0].slots[0].telephone='private-phone';const rows=rowsFrom([raw]);assert(!JSON.stringify(rows).includes('private-'));
 const s=setup();s.engine.overview=async(c,date)=>view(date,'=姓名');await s.m.tick();const csv=fs.readFileSync(path.join(s.dir,'exports','预约观察明细.csv'),'utf8');assert(csv.startsWith('\ufeff'));assert(csv.includes("'=姓名"));assert.equal(csvCell('正常姓名'),'"正常姓名"');
});
test('CSV export failures preserve successful samples and do not prevent restarting the booking service',async()=>{
 const s=setup(),original=s.m.export;s.m.export=()=>{throw Error('EBUSY')};await s.m.tick();assert.equal(s.m.samples.length,1);assert.equal(s.m.plan.lastAttempt.status,'complete');assert.match(s.m.plan.exportError,/原始快照/);assert.equal(s.m.plan.lastWindow,0);
 fs.mkdirSync(path.join(s.dir,'exports','预约观察明细.csv'));const restored=new Monitor(s.dir,path.join(s.dir,'exports'),s.engine);assert.equal(restored.summary.samples,1);assert.match(restored.plan.exportError,/原始快照/);
 fs.rmdirSync(path.join(s.dir,'exports','预约观察明细.csv'));s.m.export=original;s.time(NOW+8*3600000);await s.m.tick();assert.equal(s.m.plan.exportError,null);assert.equal(s.m.samples.length,2);
});
test('observation pause accepts only booleans and leaves booking preferences untouched',()=>{
 const s=setup();assert.throws(()=>s.m.setEnabled('false'),/开启或暂停/);assert.equal(s.m.plan.enabled,true);s.m.setEnabled(false);assert.equal(s.m.plan.enabled,false);assert.equal(s.engine.config.enabled,true);s.m.setEnabled(true);assert.equal(s.m.plan.enabled,true);
});
test('an offline startup records a failed attempt and can recover at the next eight-hour window',async()=>{
 const s=setup();s.engine.state.connected=false;s.engine.state.rules=null;s.engine.overview=async()=>{throw Error('fetch failed')};await s.m.tick();assert.equal(s.m.plan.failed,1);assert.equal(s.m.plan.lastWindow,0);assert.equal(s.m.busy,false);await s.m.tick();assert.equal(s.m.plan.attempts,1);
 s.time(NOW+8*3600000);s.engine.overview=async(c,date)=>{s.engine.state.rules={maxDays:2,releaseHour:20};s.engine.state.connected=true;return view(date)};await s.m.tick();assert.equal(s.m.samples.length,1);assert.deepEqual(s.m.samples[0].observedDates,['2026-10-12','2026-10-13']);assert.equal(s.m.plan.lastAttempt.status,'complete');
});
test('multiple name labels share one resource denominator and missing names remain separate',()=>{
 const rows=rowsFrom([view('2026-10-13')]);rows[0].names=['姓名甲','姓名乙'];rows[1].status='booked';rows[1].names=[];const r=summarize([{finishedAt:new Date(NOW).toISOString(),status:'complete',rows}]);assert.equal(r.namedSlots,1);assert.equal(r.unnamedSlots,1);assert.equal(r.ranking.length,2);assert.equal(r.topFiveShare,100);assert.deepEqual(r.ranking.map(x=>x.share),[100,100]);
});
function concentratedRows(name='姓名目标',date='2026-10-15'){
 const times=[[5,'08:10','09:00','morning'],[7,'09:10','10:00','morning'],[3,'11:10','12:00','morning'],[7,'14:10','15:00','afternoon'],[7,'16:10','17:30','afternoon'],[8,'18:30','19:20','evening'],[5,'19:30','20:20','evening']];
 return times.map(([roomId,start,end,period])=>({date,roomId,room:'教室'+roomId,start,end,period,status:'booked',names:[name],pending:false}));
}
const snapshot=(rows,offset=0)=>({capturedAt:new Date(NOW+offset).toISOString(),finishedAt:new Date(NOW+offset).toISOString(),status:'complete',rows});
test('daily concentration counts seven distinct slots, four rooms and 380 minutes without snapshot inflation',()=>{
 const rows=concentratedRows();rows[0].pending=true;
 const r=summarize([snapshot(rows),snapshot(rows,1000)]);
 assert.equal(r.dailyThreshold,5);assert.deepEqual(r.dailyConcentration,[{name:'姓名目标',date:'2026-10-15',slots:7,minutes:380,lateAfternoon:1,pendingSlots:1,roomCount:4}]);assert.equal(r.ranking[0].slots,7);
});
test('daily flags disappear below the screening threshold after cancellations or name changes',()=>{
 const rows=concentratedRows(),changed=rows.map((r,i)=>i<3?{...r,status:'free',names:[]}:r);
 let r=summarize([snapshot(rows),snapshot(changed,1000)]);assert.equal(r.dailyConcentration.length,0);assert.equal(r.ranking[0].slots,4);
 const reassigned=rows.map((r,i)=>i<3?{...r,names:['姓名乙']}:r);
 r=summarize([snapshot(rows),snapshot(reassigned,1000)]);assert.equal(r.dailyConcentration.length,0);assert.deepEqual(r.ranking.map(p=>[p.name,p.slots]),[['姓名目标',4],['姓名乙',3]]);
});
test('a daily concentration remains visible when its name is below the cumulative top twenty',()=>{
 const s=setup(),rows=concentratedRows();
 for(let person=0;person<21;person++)for(let day=10;day<15;day++)for(let slot=0;slot<2;slot++)rows.push({...rows[0],date:'2026-10-'+day,roomId:100+person,start:slot?'10:10':'08:10',end:slot?'11:00':'09:00',names:['累计姓名'+person]});
 s.m.summary=summarize([snapshot(rows)]);const state=s.m.publicState();
 assert.equal(state.summary.ranking.length,20);assert(!state.summary.ranking.some(p=>p.name==='姓名目标'));assert.equal(state.summary.dailyCount,1);assert.equal(state.summary.dailyConcentration[0].name,'姓名目标');
});
test('coverage marks the newly opened date as uncollected without making requests or changing the eight-hour plan',async()=>{
 const s=setup();await s.m.tick();const attempts=s.m.plan.attempts,next=s.m.nextAt(),ends=s.m.plan.endsAt,calls=s.calls();
 assert.deepEqual(s.m.publicState().coverage,{expectedDates:['2026-10-12','2026-10-13'],missingDates:[]});
 s.time(Date.parse('2026-10-12T20:00:00+08:00'));assert.deepEqual(s.m.publicState().coverage,{expectedDates:['2026-10-12','2026-10-13','2026-10-14'],missingDates:['2026-10-14']});
 assert.equal(s.calls(),calls);assert.equal(s.m.plan.attempts,attempts);assert.equal(s.m.nextAt(),next);assert.equal(s.m.plan.endsAt,ends);
 s.engine.config.enabled=false;await s.m.tick();assert.deepEqual(s.m.samples.at(-1).observedDates,['2026-10-12','2026-10-13','2026-10-14']);assert.deepEqual(s.m.publicState().coverage.missingDates,[]);
});
test('daily CSV uses the same complete statistics and formula-safe UTF-8 name labels',async()=>{
 const s=setup();s.engine.overview=async(c,date)=>{const rows=concentratedRows('=姓名目标',date);return{date,rooms:[3,5,7,8].map(id=>({id,name:'教室'+id,slots:rows.filter(r=>r.roomId===id).map(r=>({...r,bookers:r.names}))}))}};
 await s.m.tick();const csv=fs.readFileSync(path.join(s.dir,'exports','单日占用统计.csv'),'utf8');assert(csv.startsWith('\ufeff'));assert(csv.includes("'=姓名目标"));assert.equal(csv.split('\r\n').length,3);assert(csv.includes('"7","380","4","1","0"'));assert(csv.includes('仅供核验'));
});
async function releaseSetup(){
 const s=setup(),start=Date.parse('2026-10-12T18:33:00+08:00');s.time(start);s.m.plan.startedAt=new Date(start).toISOString();s.m.plan.endsAt=new Date(start+7*86400000).toISOString();s.m.savePlan();await s.m.tick();return s;
}
test('newly released date is collected after booking ends without moving the eight-hour schedule or overwriting snapshots',async()=>{
 const s=await releaseSetup(),next=s.m.nextAt(),config=JSON.stringify(s.engine.config);
 s.time(Date.parse('2026-10-12T20:00:00+08:00'));s.engine.state.busy=true;await s.m.tick();assert.equal(s.calls(),2);
 s.engine.state.busy=false;await s.m.tick();assert.equal(s.calls(),2);
 s.time(Date.parse('2026-10-12T20:00:30+08:00'));s.engine.journal.days['2026-10-12']='预约成功';await s.m.tick();assert.equal(s.calls(),2);s.time(Date.parse('2026-10-12T20:20:30+08:00'));await s.m.tick();assert.equal(s.calls(),3);
 assert.deepEqual(s.m.samples.at(-1).observedDates,['2026-10-14']);assert.equal(s.m.samples.at(-1).source,'release');assert.equal(s.m.plan.lastWindow,0);assert.equal(s.m.nextAt(),next);assert.equal(s.m.summary.releaseSamples,1);assert.equal(s.m.plan.skippedWindows,0);
 assert(fs.existsSync(path.join(s.m.dir,'sample-0.json')));assert(fs.existsSync(path.join(s.m.dir,'release-2026-10-12-1.json')));await s.m.tick();assert.equal(s.calls(),3);assert.equal(JSON.stringify(s.engine.config),config);
 const restored=new Monitor(s.dir,path.join(s.dir,'exports'),s.engine);await restored.tick();assert.equal(s.calls(),3);assert.equal(restored.summary.samples,2);assert.equal(restored.nextAt(),next);
});
test('release capture waits until the rush is over even when automatic booking is disabled',async()=>{
 const s=await releaseSetup();s.engine.config.enabled=false;
 s.time(Date.parse('2026-10-12T20:19:59+08:00'));await s.m.tick();assert.equal(s.calls(),2);
 s.time(Date.parse('2026-10-12T20:20:00+08:00'));await s.m.tick();assert.equal(s.calls(),3);assert.equal(s.m.summary.releaseSamples,1);
});
test('a late startup catches the current released date once instead of inventing past release snapshots',async()=>{
 const s=await releaseSetup();s.time(Date.parse('2026-10-12T22:00:00+08:00'));
 const restored=new Monitor(s.dir,path.join(s.dir,'exports'),s.engine);await restored.tick();assert.equal(s.calls(),3);assert.deepEqual(restored.samples.at(-1).observedDates,['2026-10-14']);assert.deepEqual(Object.keys(restored.plan.releaseDays),['2026-10-12']);
 await restored.tick();assert.equal(s.calls(),3);assert.equal(restored.summary.samples,2);
});
test('regular sampling covering the new date satisfies the release update without a duplicate request',async()=>{
 const s=setup();await s.m.tick();s.time(Date.parse('2026-10-12T20:22:00+08:00'));await s.m.tick();const count=s.calls();await s.m.tick();
 assert.equal(count,5);assert.equal(s.calls(),count);assert.equal(s.m.summary.releaseSamples,0);assert.equal(s.m.plan.releaseDays['2026-10-12'].via,'interval');
});
test('release retries survive restart, back off, and record failed reads without fake successful samples',async()=>{
 const s=await releaseSetup();s.time(Date.parse('2026-10-12T20:21:00+08:00'));s.engine.journal.days['2026-10-12']='抢课已结束';let calls=0;
 s.engine.overview=async(c,date)=>{calls++;if(calls===1)throw Error('fetch failed');assert.equal(c,1);return view(date)};
 await s.m.tick();assert.equal(calls,1);assert.equal(s.m.plan.failed,1);assert.equal(s.m.summary.samples,1);assert.equal(s.m.plan.lastWindow,0);assert.equal(s.m.plan.releaseDays['2026-10-12'].status,'failed');
 const restored=new Monitor(s.dir,path.join(s.dir,'exports'),s.engine);await restored.tick();assert.equal(calls,1);
 s.time(Date.parse('2026-10-12T20:22:00+08:00'));await restored.tick();assert.equal(calls,2);assert.equal(restored.plan.releaseDays['2026-10-12'].attempts,2);assert.equal(restored.summary.releaseSamples,1);assert.equal(restored.plan.failed,1);
 assert(fs.existsSync(path.join(restored.dir,'release-2026-10-12-2.json')));assert.deepEqual(restored.publicState().coverage.missingDates,[]);
});
test('release recovery continues beyond three attempts but pauses and the seven-day cutoff stop collection',async()=>{
 const s=await releaseSetup();s.m.useWorkdaySchedule();s.time(Date.parse('2026-10-12T20:21:00+08:00'));s.engine.journal.days['2026-10-12']='抢课已结束';let calls=0;s.engine.overview=async()=>{calls++;throw Error('fetch failed')};
 await s.m.tick();s.time(Date.parse('2026-10-12T20:22:00+08:00'));await s.m.tick();s.time(Date.parse('2026-10-12T20:27:00+08:00'));await s.m.tick();s.time(Date.parse('2026-10-12T21:00:00+08:00'));await s.m.tick();assert.equal(calls,4);assert.equal(s.m.plan.failed,4);
 s.time(Date.parse('2026-10-13T02:33:00+08:00'));await s.m.tick();assert.equal(calls,4);
 s.m.setEnabled(false);s.time(Date.parse('2026-10-13T20:21:00+08:00'));await s.m.tick();assert.equal(calls,4);
 s.m.setEnabled(true);s.time(Date.parse(s.m.plan.endsAt));await s.m.tick();assert.equal(calls,4);assert.equal(s.m.plan.enabled,false);
});
test('a completed atomic release snapshot prevents duplicate capture when the plan file was not yet updated',async()=>{
 const s=await releaseSetup();s.time(Date.parse('2026-10-12T22:00:00+08:00'));await s.m.tick();const plan=JSON.parse(fs.readFileSync(s.m.planFile,'utf8'));plan.releaseDays={};fs.writeFileSync(s.m.planFile,JSON.stringify(plan));
 const restored=new Monitor(s.dir,path.join(s.dir,'exports'),s.engine),count=s.calls();await restored.tick();assert.equal(s.calls(),count);assert.equal(restored.plan.releaseDays['2026-10-12'].status,'complete');assert.equal(restored.summary.releaseSamples,1);
});
test('a later eight-hour read replaces release occupancy and changes the ranking instead of adding duplicate slots',async()=>{
 const s=await releaseSetup();s.time(Date.parse('2026-10-12T22:00:00+08:00'));let changed=false;
 s.engine.overview=async(c,date)=>{const rows=concentratedRows(changed?'新姓名':'原姓名',date);if(changed)for(let i=0;i<3;i++){rows[i].status='free';rows[i].names=[]}return{date,rooms:[3,5,7,8].map(id=>({id,name:'教室'+id,slots:rows.filter(r=>r.roomId===id).map(r=>({...r,bookers:r.names}))}))}};
 await s.m.tick();assert.equal(s.m.summary.ranking[0].name,'原姓名');assert.equal(s.m.summary.ranking[0].slots,7);
 changed=true;s.time(s.m.nextAt());await s.m.tick();assert(!s.m.summary.ranking.some(p=>p.name==='原姓名'));assert.equal(s.m.summary.ranking[0].name,'新姓名');assert.equal(s.m.summary.ranking[0].slots,8);assert.equal(s.m.summary.namedSlots,10);assert.equal(s.m.summary.releaseSamples,1);assert.equal(s.m.summary.dailyConcentration.length,0);
 const csv=fs.readFileSync(path.join(s.dir,'exports','预约观察明细.csv'),'utf8');assert(csv.includes('"采样类型"'));assert(csv.includes('"放号后更新"'));assert(csv.includes('"8小时复查（旧规则）"'));
});
test('release retry waits for the server rate-limit delay when it is longer than the normal backoff',async()=>{
 const s=await releaseSetup();s.time(Date.parse('2026-10-12T20:21:00+08:00'));s.engine.journal.days['2026-10-12']='抢课已结束';let calls=0;s.engine.overview=async()=>{calls++;const error=Error('HTTP 429');error.retryAfterMs=600000;throw error};
 await s.m.tick();s.time(Date.parse('2026-10-12T20:30:59+08:00'));await s.m.tick();assert.equal(calls,1);
 s.time(Date.parse('2026-10-12T20:31:00+08:00'));await s.m.tick();assert.equal(calls,2);assert.equal(s.m.plan.failed,2);
});
test('observation still gives way during the recovery period after the first two release minutes',async()=>{
 const s=await releaseSetup();s.time(Date.parse('2026-10-12T20:05:00+08:00'));await s.m.tick();assert.equal(s.calls(),2);assert.equal(s.m.summary.releaseSamples,0);
 s.engine.journal.days['2026-10-12']='抢课已结束';await s.m.tick();assert.equal(s.calls(),2);s.time(Date.parse('2026-10-12T20:20:00+08:00'));await s.m.tick();assert.equal(s.calls(),3);assert.equal(s.m.summary.releaseSamples,1);
});
test('working-hour migration preserves old snapshots and the seven-day end while removing overnight reads',async()=>{
 const s=await releaseSetup(),ends=s.m.plan.endsAt,old=fs.readFileSync(path.join(s.m.dir,'sample-0.json'),'utf8');s.m.useWorkdaySchedule();assert.equal(s.m.nextAt(),Date.parse('2026-10-13T09:00:00+08:00'));
 s.time(Date.parse('2026-10-13T02:33:00+08:00'));await s.m.tick();assert.equal(s.calls(),2);s.time(Date.parse('2026-10-13T09:00:00+08:00'));await s.m.tick();assert.equal(s.calls(),4);assert.equal(s.m.samples.at(-1).source,'workday');assert.equal(s.m.nextAt(),Date.parse('2026-10-13T17:00:00+08:00'));assert.equal(s.m.plan.endsAt,ends);assert.equal(fs.readFileSync(path.join(s.m.dir,'sample-0.json'),'utf8'),old);
 const restored=new Monitor(s.dir,path.join(s.dir,'exports'),s.engine);await restored.tick();assert.equal(s.calls(),4);assert.equal(restored.nextAt(),Date.parse('2026-10-13T17:00:00+08:00'));
});
test('a workday read can recover after ten minutes without inventing a successful failed snapshot',async()=>{
 const s=await releaseSetup();s.m.useWorkdaySchedule();s.time(Date.parse('2026-10-13T09:00:00+08:00'));let reads=0;s.engine.overview=async(c,date)=>{if(!reads++)throw Error('fetch failed');return view(date)};await s.m.tick();assert.equal(s.m.plan.failed,1);assert.equal(s.m.summary.samples,1);
 s.time(Date.parse('2026-10-13T09:09:59+08:00'));await s.m.tick();assert.equal(reads,1);s.time(Date.parse('2026-10-13T09:10:00+08:00'));await s.m.tick();assert.equal(reads,3);assert.equal(s.m.summary.samples,2);assert.equal(s.m.plan.failed,1);assert(fs.existsSync(path.join(s.m.dir,'workday-2026-10-13-09-2.json')));
});
test('sleep gaps skip missed workday windows and save only the current actual capture',async()=>{
 const s=await releaseSetup();s.m.useWorkdaySchedule();s.time(Date.parse('2026-10-14T10:00:00+08:00'));await s.m.tick();assert.equal(s.m.plan.skippedWindows,2);assert.equal(s.m.samples.at(-1).workdayKey,'2026-10-14-09');assert.equal(s.m.samples.at(-1).capturedAt,new Date(s.engine.now()).toISOString());assert.equal(s.m.samples.filter(x=>x.source==='workday').length,1);
});
test('a release update stuck after three old failures resumes when the network recovers',async()=>{
 const s=await releaseSetup();s.m.useWorkdaySchedule();s.m.plan.failed=3;s.m.plan.releaseDays['2026-10-12']={status:'failed',attempts:3,date:'2026-10-14',retryAt:Date.parse('2026-10-12T20:40:00+08:00')};s.m.savePlan();s.time(Date.parse('2026-10-12T21:16:00+08:00'));await s.m.tick();assert.equal(s.m.summary.releaseSamples,1);assert.equal(s.m.plan.failed,3);assert.equal(s.m.plan.releaseDays['2026-10-12'].attempts,4);assert.equal(s.m.plan.releaseDays['2026-10-12'].status,'complete');assert(fs.existsSync(path.join(s.m.dir,'release-2026-10-12-4.json')));
});
test('a deferred workday capture at eighteen makes no fake snapshot and resumes only in the next working window',async()=>{
 const s=await releaseSetup();s.m.useWorkdaySchedule();s.time(Date.parse('2026-10-13T17:59:59+08:00'));let reads=0;s.engine.overview=async(c,date,allowed)=>{reads++;s.time(Date.parse('2026-10-13T18:00:00+08:00'));assert.equal(allowed(),false);throw Object.assign(Error('deferred'),{code:'MONITOR_DEFERRED'})};await s.m.tick();assert.equal(reads,1);assert.equal(s.m.samples.length,1);assert.equal(s.m.plan.failed,0);assert.equal(s.m.nextAt(),Date.parse('2026-10-14T09:00:00+08:00'));
});
test('working windows that were never sampled are counted once when the seven-day period ends',async()=>{
 const s=await releaseSetup();s.m.useWorkdaySchedule();const windows=s.m.workdayWindows().length;s.time(Date.parse(s.m.plan.endsAt));await s.m.tick();assert.equal(s.m.plan.skippedWindows,windows);await s.m.tick();assert.equal(s.m.plan.skippedWindows,windows);assert.equal(s.calls(),2);
});
