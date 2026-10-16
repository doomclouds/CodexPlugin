import test from 'node:test';
import assert from 'node:assert/strict';
import { browserExecutable } from '../src/export.ts';
import { inspectCodeHtml } from '../src/code-browser.ts';

test('real browser captures full content, runtime errors and usable visual metrics',{timeout:45000},async t=>{
  if(!await browserExecutable()){t.skip('Chromium unavailable');return;}
  const result=await inspectCodeHtml('<!doctype html><html><head><title>Code inspection</title></head><body style="margin:0;min-height:1400px"><h1>真实代码预览</h1><button>预约</button><script>throw new Error("prototype error")</script></body></html>',{width:900,height:600,pdf:true});
  assert.equal(result.png.readUInt32BE(16),900);assert.ok(result.png.readUInt32BE(20)>=1400);assert.equal(result.pdf!.subarray(0,5).toString(),'%PDF-');assert.equal(result.metrics.controls,1);assert.deepEqual(result.metrics.headings,['真实代码预览']);assert.ok(result.errors.some(error=>error.includes('prototype error')));
});
test('browser inspection blocks outgoing requests without executing prototype code on the host',{timeout:45000},async t=>{
  if(!await browserExecutable()){t.skip('Chromium unavailable');return;}
  const result=await inspectCodeHtml('<html><body><h1>Isolated</h1><img src="http://127.0.0.1:1/blocked"><script>document.body.dataset.executed="browser-only"</script></body></html>',{width:600,height:400});
  assert.ok(result.blockedRequests>=1);assert.ok(result.metrics.textLength>0);assert.equal(result.metrics.horizontalOverflow,false);
});
