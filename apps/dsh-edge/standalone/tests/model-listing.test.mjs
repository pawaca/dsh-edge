import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelListingCache } from '@deepseek-ai/dsh-llm-deepseek'

test('model listings refresh on stale access, not idle timers; bursts share one load', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now=0,loads=0,credential='local-fixture-key',fail=false,release
  const listing={entries:[],skipped:0}
  const settings={url:'https://fixture.invalid/models',timeoutMs:5000,maxAgeMs:1000}
  const cache=new ModelListingCache({ now:()=>now,credential:async()=>credential,settings:()=>settings,
    load:async()=>{loads++;if(release)await release.promise;if(fail)throw Error('offline');return listing},info(){},warn(){},changed(){} })
  try {
    await Promise.all(Array.from({length:20},()=>cache.view(settings)))
    assert.equal(loads,1)
    now=2000;t.mock.timers.tick(2000)
    for(let i=0;i<10;i++)await Promise.resolve()
    assert.equal(loads,1,'an idle cache must not load or arm another refresh')
    release=Promise.withResolvers()
    const stale=await Promise.all(Array.from({length:20},()=>cache.view(settings)))
    assert.equal(loads,2)
    assert.ok(stale.every(view=>view.listing===listing))
    release.resolve();release=undefined
    for(let i=0;i<10;i++)await Promise.resolve()
    await cache.view(settings);assert.equal(loads,2)
    now=4000;fail=true
    await cache.view(settings)
    for(let i=0;i<10;i++)await Promise.resolve()
    await Promise.all(Array.from({length:20},()=>cache.view(settings)))
    assert.equal(loads,3,'a failed refresh must retain the TTL and prevent a retry storm')
    assert.equal(cache.current().listing,listing)
    credential='different-local-fixture-key';fail=false
    await cache.view(settings);assert.equal(loads,4)
  } finally { await cache.dispose();t.mock.timers.reset() }
})
