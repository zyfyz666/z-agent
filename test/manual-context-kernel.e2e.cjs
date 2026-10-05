'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { OpenCodeSidecar, buildOpenCodeConfig } = require('../lib/opencode-sidecar');
process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-compact-kernel-'));
const requests = [];
const server = http.createServer((req,res)=>{
 let raw=''; req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
  const body=JSON.parse(raw||'{}');requests.push(body);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const emit=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:'compact-fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
  emit({role:'assistant',content:'COMPACT_SUMMARY: preserve the original objective and continue only when asked.'});emit({},'stop');res.end('data: [DONE]\n\n');
 });
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const sidecar=new OpenCodeSidecar({appRoot:path.resolve(__dirname,'..'),dataDir:path.join(root,'data'),maxKernels:2});
 try{
  const config=buildOpenCodeConfig({providerId:'fixture',modelId:'compact-fixture',apiKey:'local',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,mcpServers:[],enableSubagents:false,accessMode:'full',contextWindow:1000000,compactionThreshold:900000});
  const request={providerId:'fixture',modelId:'compact-fixture',workspace:root,hasUserWorkspace:true,workMode:'normal',accessMode:'full',openCodeConfig:config};
  const budgets=[];
  const captureBudget=event=>{if(event.type==='z.context.budget')budgets.push(event.data);};
  const run=await sidecar.run({...request,runId:'compact-fixture-run',prompt:'THRESHOLD_ORIGINAL_7351: Explain this task without tools. '+ 'Historic context to preserve. '.repeat(1000)},captureBudget);
  assert.equal(run.status,'done',run.error);
  const originalKernel=[...sidecar.kernels.values()][0];
  const originalHistory=await originalKernel.client.session.messages({sessionID:run.openCodeSessionId,directory:root});
  const originalIds=new Set(originalHistory.data.map(message=>message.info.id));
  const changedConfig={...config,compaction:{...config.compaction,threshold:700000}};
  const changedRequest={...request,openCodeConfig:changedConfig,openCodeSessionId:run.openCodeSessionId};
  const resumed=await sidecar.run({...changedRequest,runId:'compact-fixture-resumed',prompt:'THRESHOLD_FOLLOW_UP_7351: Continue the same conversation without tools.'},captureBudget);
  assert.equal(resumed.status,'done',resumed.error);
  assert.equal(resumed.openCodeSessionId,run.openCodeSessionId,'a threshold change must keep the same native session');
  assert.equal(sidecar.kernels.size,2,'a changed threshold selects another kernel configuration');
  assert.deepEqual(budgets.map(item=>[item.contextWindow,item.softThreshold]),[[1000000,900000],[1000000,700000]]);
  const kernel=[...sidecar.kernels.values()].find(item=>item!==originalKernel);
  const resumedHistory=await kernel.client.session.messages({sessionID:run.openCodeSessionId,directory:root});
  assert.ok([...originalIds].every(id=>resumedHistory.data.some(message=>message.info.id===id)),'switching kernel configuration retains every original native history message');
  assert.ok(resumedHistory.data.some(message=>message.info.role==='user'&&message.parts.some(part=>part.text?.includes('THRESHOLD_ORIGINAL_7351'))));
  assert.ok(resumedHistory.data.some(message=>message.info.role==='user'&&message.parts.some(part=>part.text?.includes('THRESHOLD_FOLLOW_UP_7351'))));
  const before=requests.length;
  const result=await sidecar.compressSession(changedRequest);
  assert.equal(result.compacted,true,result.error);
  assert.equal(result.budget.contextWindow,1000000);
  assert.equal(result.budget.softThreshold,700000);
  assert.ok(requests.length>before,'manual compaction must invoke the model');
  const history=await kernel.client.session.messages({sessionID:run.openCodeSessionId,directory:root});
  assert.ok(history.data.some(m=>m.info.summary && m.parts.some(p=>p.text?.includes('COMPACT_SUMMARY'))),'summary must be persisted');
  assert.equal(requests.slice(before).filter(r=>r.tools?.length).length,0,'manual compaction must not resume tool execution');
  assert.ok(result.afterTokens>0 && result.afterTokens<result.beforeTokens,JSON.stringify(result));
  console.log(JSON.stringify({ok:true,sameNativeSession:true,originalHistoryPreserved:true,thresholds:budgets.map(item=>item.softThreshold),contextWindow:result.budget.contextWindow,beforeTokens:result.beforeTokens,afterTokens:result.afterTokens,summaryRequests:requests.length-before}));
 }finally{
  const exits=[...sidecar.kernels.values()].map(k=>k.server?.child).filter(c=>c && c.exitCode===null).map(c=>new Promise(resolve=>c.once('exit',resolve))); sidecar.close(); await Promise.all(exits);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});

