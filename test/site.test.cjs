'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Site}=require('../site');
function client(){const s=Object.create(Site.prototype);s.auth={no:'test',token:'test'};s.offset=0;return s}
test('HTTP 429 and 503 carry a retry delay while read requests retain the short caller timeout',async()=>{
 const s=client();let timeout;s.request=async(url,options,ms)=>{timeout=ms;return{status:429,body:'rate limit',retryAfterMs:7000}};await assert.rejects(()=>s.api('bizLiveListTimeTable',{},'GET',true,2500),e=>e.code==='RATE_LIMITED'&&e.retryAfterMs===7000);assert.equal(timeout,2500);
 s.request=async()=>({status:503,body:'gateway unavailable',retryAfterMs:1000});await assert.rejects(()=>s.api('bizLiveList'),e=>e.code==='SCHOOL_UNAVAILABLE'&&e.retryable===true);
});
test('automatic login recovery preserves a read timeout and does not replay an ambiguous write',async()=>{
 const s=client();let requests=0,logins=0;s.login=async()=>{logins++};s.request=async(url,options,ms)=>{assert.equal(ms,2500);requests++;return{status:200,body:JSON.stringify(requests===1?{success:false,errorCode:'18000'}:{success:true,data:[]})}};await s.api('bizLiveList',{},'GET',true,2500);assert.equal(logins,1);assert.equal(requests,2);
 requests=0;logins=0;await s.api('bizLiveItemEdit',{},'POST',false,2500);assert.equal(requests,1);assert.equal(logins,0);
});
test('timeout diagnostics identify the request and elapsed time without recording authentication or request parameters',async()=>{
 const s=client();s.auth={no:'private-account',token:'private-token'};s.request=async()=>{throw new DOMException('operation timed out','TimeoutError')};
 await assert.rejects(()=>s.api('bizLiveList',{parentEmployee:'private-owner'},'GET',true,10000),e=>e.code==='REQUEST_TIMEOUT'&&e.endpoint==='bizLiveList'&&e.timeoutMs===10000&&typeof e.elapsedMs==='number'&&e.retryable);
 const encoded=JSON.stringify(s.lastRequest);for(const value of ['private-account','private-token','private-owner'])assert(!encoded.includes(value));assert.equal(s.lastRequest.method,'GET');
});
test('network connection failures retain their cause code for the booking postmortem',async()=>{
 const s=client();s.request=async()=>{throw Object.assign(Error('fetch failed'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}})};
 await assert.rejects(()=>s.api('bizLiveListTimeTable',{},'GET',true,6000),e=>e.code==='UND_ERR_CONNECT_TIMEOUT'&&e.endpoint==='bizLiveListTimeTable'&&e.timeoutMs===6000&&e.retryable);
});
test('a body timeout is distinguished from waiting for response headers without recording credentials',async()=>{
 const s=client();s.request=async()=>{throw Object.assign(new DOMException('aborted','AbortError'),{requestStage:'response_body',headersMs:25,status:200})};
 await assert.rejects(()=>s.api('bizLiveItem',{id:123},'GET',true,10000),e=>e.code==='REQUEST_TIMEOUT'&&e.requestStage==='response_body'&&e.headersMs===25&&e.status===200);
 assert(!JSON.stringify(s.lastRequest).includes('token'));
});
test('school HTTPS keeps the original certificate hostname while using resolved WLAN addresses and fresh connections',async()=>{
 const https=require('node:https'),{EventEmitter}=require('node:events'),original=https.request,s=client();s.cookies=new Map();s.networkRoute=async()=>({localAddress:'10.0.0.2',hosts:{'tstc.scnu.edu.cn':'121.8.171.52'}});let captured;
 https.request=(url,opts,callback)=>{captured={url,opts};const req=new EventEmitter();req.end=body=>{captured.body=body;queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'set-cookie':['session=test; Path=/']};callback(res);res.emit('data',Buffer.from('{"success":true,"data":[]}'));res.emit('end')})};return req};
 try{const r=await s.api('bizLiveList',{},'GET',false);assert(r.success);assert.equal(captured.url.hostname,'tstc.scnu.edu.cn');assert.equal(captured.url.protocol,'https:');assert.equal(captured.opts.localAddress,'10.0.0.2');assert.equal(captured.opts.agent,false);assert.notEqual(captured.opts.rejectUnauthorized,false);let lookup;captured.opts.lookup('tstc.scnu.edu.cn',{all:true},(err,addresses)=>lookup=addresses);assert.deepEqual(lookup,[{address:'121.8.171.52',family:4}]);assert.equal(s.lastRequest.transport,'wlan_https');assert(s.cookies.size===1)}finally{https.request=original}
});
test('HTTPS posts preserve the form body and the school redirect is returned for explicit login handling',async()=>{
 const https=require('node:https'),{EventEmitter}=require('node:events'),original=https.request,s=client();s.cookies=new Map();s.networkRoute=async()=>({});let captured;
 https.request=(url,opts,callback)=>{captured=opts;const req=new EventEmitter();req.end=body=>{captured.body=body;queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=302;res.headers={location:'/login'};callback(res);res.emit('data',Buffer.from(''));res.emit('end')})};return req};
 try{const r=await s.request('/webservice/bizLiveItemEdit.action',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'title=test&token=secret'});assert.equal(captured.method,'POST');assert.equal(captured.body,'title=test&token=secret');assert.equal(r.location,'/login');assert.equal(r.status,302);assert.equal(r.transport,'system_https')}finally{https.request=original}
});
test('a failed HTTPS connection clears its cached route and cannot follow an unrelated hostname',async()=>{
 const https=require('node:https'),{EventEmitter}=require('node:events'),original=https.request,s=client();s.cookies=new Map();s.route={cached:true};s.networkRoute=async()=>({});let requests=0;
 https.request=()=>{requests++;const req=new EventEmitter();req.end=()=>queueMicrotask(()=>req.emit('error',Object.assign(Error('connect timed out'),{code:'ETIMEDOUT'})));return req};
 try{await assert.rejects(()=>s.request('https://other.example/path'),/未配置/);assert.equal(requests,0);await assert.rejects(()=>s.api('bizLiveList',{},'GET',false),e=>e.code==='ETIMEDOUT'&&e.requestStage==='response_headers');assert.equal(s.route,null);assert.equal(requests,1)}finally{https.request=original}
});
