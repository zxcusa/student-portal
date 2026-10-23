const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function client(){
  let calls=[];
  const source=fs.readFileSync('public/portal.js','utf8').replace(/^boot\(\);$/m,'');
  const context=vm.createContext({structuredClone,URL,Blob,setTimeout,clearTimeout,console,
    document:{addEventListener(){}},window:{addEventListener(){}},
    fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({value:calls.length})};}
  });
  vm.runInContext(source,context);
  return {calls,run:code=>vm.runInContext(code,context)};
}
test('navigation reuses and deduplicates reads without sharing mutable state',async()=>{
  const c=client();
  await c.run("Promise.all([api('/departments'),api('/departments')])");
  assert.equal(c.calls.length,1);
  await c.run("api('/departments').then(data=>{data.value=999})");
  assert.equal((await c.run("api('/departments')")).value,1);
  await c.run("responseCache.get('/departments').expires=0;api('/departments')");
  assert.equal(c.calls.length,2);
});
test('writes invalidate navigation data and slots always stay live',async()=>{
  const c=client();
  await c.run("api('/bookings')");
  await c.run("api('/bookings/1/status',{status:'tasdiqlandi'})");
  await c.run("api('/bookings')");
  assert.equal(c.calls.length,3);
  await c.run("api('/slots?bolim_id=1&sana=2099-01-01')");
  await c.run("api('/slots?bolim_id=1&sana=2099-01-01')");
  assert.equal(c.calls.length,5);
});
test('an old request cannot repopulate the cache after invalidation',async()=>{
  const c=client();
  await c.run("fetch=()=>new Promise(resolve=>{globalThis.finish=()=>resolve({ok:true,json:async()=>({old:true})})});globalThis.old=api('/users');clearApiCache();finish();old");
  assert.equal(c.run('responseCache.size'),0);
});
