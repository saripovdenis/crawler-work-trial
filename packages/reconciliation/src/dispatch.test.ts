import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dispatchSummary} from './dispatch.js';
test('dispatch metrics distinguish worker startup delay, unsent failures and lease expiry',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  assert.equal(dispatchSummary(db,10000000).available,false);
  db.exec('CREATE TABLE requests(id INTEGER,domain TEXT,started INTEGER);CREATE TABLE attempt_assignments(request_id INTEGER,start_by INTEGER,terminal TEXT,assignment TEXT,completion TEXT)');
  const now=10000000;
  for(const [id,delay,error,terminal,transport] of [[1,100,null,'completed','node'],[2,500,null,'completed','chrome136'],[3,null,'curl_cffi: Dispatch deadline expired','completed','chrome136'],[4,null,null,'expired','node']] as const){
   db.prepare('INSERT INTO requests VALUES (?,?,?)').run(id,'bbc.com',now-1000);
   db.prepare('INSERT INTO attempt_assignments VALUES (?,?,?,?,?)').run(id,now+1000,terminal,JSON.stringify({transport}),terminal==='expired'?null:JSON.stringify({started_at:delay===null?null:new Date(now-1000+delay).toISOString(),error}));
  }
  const m=dispatchSummary(db,now);assert.equal(m.attempts,4);assert.equal(m.p50Ms,100);assert.equal(m.p95Ms,500);assert.equal(m.deadlineFailures,1);assert.equal(m.unsent,1);assert.equal(m.leaseExpiries,1);assert.equal(m.byTransport.find(t=>t.transport==='chrome136')!.deadlineFailures,1);
  assert.equal(dispatchSummary(db,now,'ce.cn').attempts,0);
 }finally{db.close();}
});
