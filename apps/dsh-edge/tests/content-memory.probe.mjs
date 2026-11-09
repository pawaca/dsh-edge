/** Sample promoted workerd V8 heap via its local inspector; samples are a lower
 * bound on instantaneous peak, and include inspector overhead. No Node heap proxy.
 */
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {unstable_dev} from 'wrangler'
import {workerArtifactPath,writePrebuiltModeWranglerConfig} from '../scripts/wrangler-config.mjs'
import {startMockDeepSeek} from './fixtures/mock-deepseek.mjs'
const mode=process.env.DSH_EDGE_TEST_RUNTIME_MODE??'direct'
const root=mkdtempSync(join(tmpdir(),'dsh-memory-'));let worker,ws
const estimateUsage=process.env.DSH_EDGE_MEMORY_USAGE==='estimate'
const mock=await startMockDeepSeek(0,{estimateUsage});const key='memory-local-owner-fixture-12345678'
const report=[];let cookie;let id=0;let pending=new Map()
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id
  const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Inspector timed out: ${method}`)) }, 15000)
  pending.set(n, {
    resolve: result => { clearTimeout(timer); resolve(result) },
    reject: error => { clearTimeout(timer); reject(error) },
  })
  ws.send(JSON.stringify({ id: n, method, params }))
})
const boot=async()=>{
 const config=join(root,`wrangler-${crypto.randomUUID()}.json`);const appDirectory=process.env.DSH_EDGE_PROBE_PACKAGE;const artifactOptions=appDirectory?{appDirectory,sourceConfigPath:join(appDirectory,'wrangler.jsonc')}:{};await writePrebuiltModeWranglerConfig(mode,config,artifactOptions)
 worker=await unstable_dev(workerArtifactPath(mode,artifactOptions),{config,env:mode==='direct'?'':'isolated',persistTo:root,inspectorPort:19379,vars:{DSH_EDGE_ACCESS_KEY:key,DEEPSEEK_API_KEY:'local-only',DEEPSEEK_BASE_URL:mock.url},logLevel:'error',experimental:{disableExperimentalWarning:true,showInteractiveDevSession:false,watch:false}})
 const login=await worker.fetch('/api/auth/login',{method:'POST',body:`accessKey=${key}`,headers:{'content-type':'application/x-www-form-urlencoded'},redirect:'manual'});cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')
 const targets=await(await fetch('http://127.0.0.1:19379/json/list')).json()
 ws=new WebSocket(targets[0].webSocketDebuggerUrl,{headers:{Origin:"http://localhost:19379"}});await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=e=>reject(e.error??e)})
 ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);if(m.error)p.reject(Error(JSON.stringify(m.error)));else p.resolve(m.result)}}
 await cdp('Runtime.enable')
}
const rpc=async(method,payload)=>{const r=await worker.fetch(`/api/session.${method}`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),payload})});const b=await r.json();assert.equal(b.result?.ok,true,JSON.stringify(b));return b.result.value}
const phase=async(name,action)=>{
 const before=await cdp('Runtime.getHeapUsage');let max=before.usedSize;let maxBacking=before.backingStorageSize??0;let running=true;let samples=0
 const sampling=(async()=>{while(running){const value=await cdp('Runtime.getHeapUsage');max=Math.max(max,value.usedSize);maxBacking=Math.max(maxBacking,value.backingStorageSize??0);samples++;await pause(20)}})()
 let value;try{value=await action()}finally{running=false;await sampling}
 const after=await cdp('Runtime.getHeapUsage');max=Math.max(max,after.usedSize)
 const row={name,before:before.usedSize,after:after.usedSize,maxSampledHeap:max,maxSampledBacking:maxBacking,samples,value:Array.isArray(value)&&value[0]?.sessionId?{sessions:6,toolTurns:value.length}:value};report.push(row);console.log(JSON.stringify(row));return value
}
let compactions=0;let maxRequestBytes=0
const collectRequests=()=>{for(const request of mock.requests){const source=JSON.stringify(request);maxRequestBytes=Math.max(maxRequestBytes,Buffer.byteLength(source));if(source.includes('You are now acting as a compaction engine'))compactions++}mock.requests.splice(0)}
const fillResults=async()=>{
 const file=await worker.fetch('/api/workspace/file?path=/workspace/memory-fixture.txt',{method:'PUT',headers:{cookie},body:('bounded fixture '.repeat(20)+'\n').repeat(700)})
 assert.equal(file.status,200);await file.arrayBuffer()
 const refs=[]
 for(let session=0;session<6;session++){
  const sessionId=(await rpc('create',{})).sessionId
  for(let turn=0;turn<20;turn++){
   const r=await worker.fetch(`/api/sessions/${sessionId}/turn`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({message:`read the file /workspace/memory-fixture.txt (sample ${turn})`})})
   assert.equal(r.status,200);const text=await r.text();assert.match(text,/"kind":"completed"/)
   const result=text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(event=>event.type==='tool/result')
   assert.ok(result);refs.push({sessionId,seq:result.seq});collectRequests()
  }
 }
 return refs
}
try{
 await boot();const sessionId=(await rpc('create',{})).sessionId
 const turn=async n=>{const r=await worker.fetch(`/api/sessions/${sessionId}/turn`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({message:`${n}: `+'large log fixture '.repeat(2400)})});assert.equal(r.status,200);const text=await r.text();assert.match(text,/"kind":"completed"/);collectRequests()}
 const concurrency=Number(process.env.DSH_EDGE_MEMORY_COPIES??8)
 const expectCopies=(results,status)=>{assert.ok(results.some(r=>r.status===status));assert.ok(results.every(r=>r.status===status||r.status===429));if(concurrency>=32&&status===200)assert.ok(results.some(r=>r.status===429),'large-copy bursts must exercise admission')}
 const copy=async()=>{const r=await worker.fetch(`/api/session.markdown?sessionId=${sessionId}`,{headers:{cookie}});const bytes=(await r.arrayBuffer()).byteLength;return{status:r.status,bytes}}
 if(process.env.DSH_EDGE_MEMORY_HISTORY_ONLY==='1'){
   await phase('100 long turns with request-sized usage',async()=>{for(let n=0;n<100;n++)await turn(n);return{compactions,maxRequestBytes}})
   ws.close();await worker.stop();await boot()
   await phase('cold resume after 100 turns',()=>turn(100))
 }else if(process.env.DSH_EDGE_MEMORY_HISTORY_ONLY==='resident'){
   await phase('44 long turns',async()=>{for(let n=0;n<44;n++)await turn(n)})
   ws.close();await worker.stop();await boot()
   await phase('six resident sessions with 120 real tool results',fillResults)
   await phase('80 long turns with six other resident sessions',async()=>{for(let n=44;n<80;n++)await turn(n)})
 }else{
 await phase('44 long turns',async()=>{for(let n=0;n<44;n++)await turn(n)})
 ws.close();await worker.stop();await boot()
 await phase(`cold near-limit Markdown: ${concurrency} concurrent copies`,async()=>{const results=await Promise.all(Array.from({length:concurrency},copy));expectCopies(results,200);return results})
 const file = await worker.fetch('/api/workspace/file?path=/workspace/memory-fixture.txt', { method: 'PUT', headers: { cookie }, body: ('bounded fixture '.repeat(20) + '\n').repeat(700) })
 assert.equal(file.status, 200); await file.arrayBuffer()
 if(process.env.DSH_EDGE_MEMORY_SATURATE==='1'){
   const refs=await phase('fill and evict the global Trajectory cache using real tools',fillResults)
   const probe=new WebSocket(`ws://${worker.address}:${worker.port}/api/remote.mux`,{headers:{cookie}})
   await new Promise((resolve,reject)=>{probe.on('open',resolve);probe.on('error',reject)})
   const values=[]
   probe.on('message',bytes=>{const frame=JSON.parse(String(bytes));if(frame.type==='item')values.push(frame)})
   for(const [index,ref] of [refs[0],refs.at(-1)].entries())probe.send(JSON.stringify({type:'open',streamId:`eviction-${index}`,endpoint:'toolResults/watch',payload:{args:{request:ref}}}))
   for(let n=0;n<100&&values.length<2;n++)await pause(20)
   assert.equal(values.length,2);assert.equal(values.find(frame=>frame.streamId==='eviction-0').value.available,false);assert.equal(values.find(frame=>frame.streamId==='eviction-1').value.available,true)
   probe.close();await new Promise(resolve=>probe.once('close',resolve))

 }
 const toolSessionId = (await rpc('create', {})).sessionId
 const toolTurn = await worker.fetch(`/api/sessions/${toolSessionId}/turn`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'read the file /workspace/memory-fixture.txt' }) })
 const toolEvents = (await toolTurn.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
 const toolResult = toolEvents.find(event => event.type === 'tool/result')
 assert.ok(toolResult, 'read must produce a real tool result')
 const carrier = new WebSocket(`ws://${worker.address}:${worker.port}/api/remote.mux`, { headers: { cookie } })
 await new Promise((resolve, reject) => { carrier.on('open', resolve); carrier.on('error', reject) })
 const items = []
 carrier.on('message', bytes => { const frame = JSON.parse(String(bytes)); if (frame.type === 'item') items.push(frame) })
 await phase(`warm 44-turn history + 16 Trajectory followers + ${concurrency} copies + optional streaming upload`, async () => {
   for (let n=0;n<17;n++) carrier.send(JSON.stringify({ type: 'open', streamId: `memory-${n}`, endpoint: 'toolResults/watch', payload: { args: { request: { sessionId: toolSessionId, seq: toolResult.seq } } } }))
   for (let n=0;n<100 && items.length<17;n++) await pause(20)
   assert.equal(items.length, 17)
   assert.ok(items.slice(0,16).every(frame => frame.value.available))
   assert.equal(items[16].value.available, false)
   const copies = Promise.all(Array.from({length:concurrency}, copy))
   let upload
   if(process.env.DSH_EDGE_MEMORY_SATURATE==='1'){
     const bytes=16*1024*1024
     const response=await worker.fetch(`/api/session/uploadFileBinary?sessionId=${toolSessionId}&name=memory-stream.bin`,{method:'POST',headers:{cookie,'content-type':'application/octet-stream','content-length':String(bytes)},body:new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(64*1024));this.left=(this.left??bytes)-64*1024;if(this.left===0)controller.close()}}),duplex:'half'})
     assert.equal(response.status,200);upload=await response.json();assert.equal(upload.ok,true)
   }
   const results = await copies
   expectCopies(results,200)
   return { rawResultBytes: new TextEncoder().encode(JSON.stringify(items[0].value.value)).byteLength, followers: 16, upload, results }
 })
 await phase('80 long turns total with 16 followers', async () => { for (let n=44;n<80;n++) await turn(n) })
 await phase(`warm 80-turn history + 16 Trajectory followers + ${concurrency} oversized copies`, async () => {
   const results = await Promise.all(Array.from({length:concurrency}, copy))
   expectCopies(results,413)
   return { followers: 16, results }
 })
 carrier.close()
 mock.requests.splice(0)
 console.log(JSON.stringify({name:'state after combined workload',...await cdp('Runtime.getHeapUsage')}))
 ws.close();await worker.stop();await boot()
 await phase(`cold oversized Markdown: ${concurrency} concurrent requests`,async()=>{const results=await Promise.all(Array.from({length:concurrency},copy));expectCopies(results,413);return results})
 }
 if(process.env.DSH_EDGE_PROBE_REPORT)writeFileSync(process.env.DSH_EDGE_PROBE_REPORT,JSON.stringify({mode,estimateUsage,compactions,maxRequestBytes,report},null,2)+'\n')
}finally{ws?.close();await worker?.stop();await mock.close();rmSync(root,{recursive:true,force:true})}
