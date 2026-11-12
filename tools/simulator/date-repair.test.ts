import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { repairPublication } from '../../services/pipeline/src/extract/repair-publication.js';

const now=Date.parse('2026-11-12T09:00:00Z');
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'publication-repair-')),database=join(directory,'crawler.sqlite');
  mkdirSync(join(directory,'snapshots'));
  const db=new DatabaseSync(database);
  db.exec(`CREATE TABLE sites(domain TEXT PRIMARY KEY,started INTEGER);
    CREATE TABLE articles(canonical_url TEXT PRIMARY KEY,domain TEXT,discovered INTEGER,fetched INTEGER,published TEXT,classification TEXT,fingerprint TEXT,payload TEXT);
    CREATE TABLE requests(id INTEGER PRIMARY KEY,domain TEXT,url TEXT,purpose TEXT,started INTEGER,finished INTEGER,status INTEGER,error TEXT,body_hash TEXT,headers TEXT);
    CREATE TABLE crawl_tasks(id INTEGER PRIMARY KEY,url TEXT,purpose TEXT);
    CREATE TABLE attempt_assignments(attempt_id TEXT,request_id INTEGER,task_id INTEGER,processing TEXT);
    INSERT INTO sites VALUES ('ce.cn',0),('eastmoney.com',0),('bbc.com',0),('chosun.com',0);`);
  let seq=0;
  function article(options:{domain?:string;purpose?:string;status?:number;processing?:string;archive?:boolean;corrupt?:boolean;fetched?:number;published?:string;source?:string;html?:string;text?:string}={}) {
    const id=++seq,domain=options.domain||'ce.cn',source=options.source||`https://finance.${domain}/article/${id}`;
    const canonical=`https://www.${domain}/canonical/${id}`;
    const fetched=options.fetched??now-1800000,discovered=fetched-60000;
    const payload=JSON.stringify({title:'An archived article headline',text:options.text??'Real article content. '.repeat(30),description:'A description',socialTags:{'og:title':['Original']},discoveredAt:new Date(discovered).toISOString(),fetchedAt:new Date(fetched).toISOString(),sourceUrl:source,publishedAt:options.published??null,dateSource:null,classification:'incomplete',isArticle:false});
    db.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?,?)').run(canonical,domain,discovered,fetched,options.published??null,'incomplete','fingerprint-'+id,payload);
    const html=options.html??'<meta name="publishdate" content="2026-11-12 16:25:00">';
    const bytes=Buffer.from(html),hash=createHash('sha256').update(bytes).digest('hex');
    if(options.archive!==false)writeFileSync(join(directory,'snapshots',hash+'.gz'),gzipSync(options.corrupt?Buffer.from('corrupted'):bytes));
    db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,domain,source,options.purpose||'article',fetched-1000,fetched-500,options.status??200,null,hash,'{"content-type":"text/html; charset=utf-8"}');
    db.prepare('INSERT INTO crawl_tasks VALUES (?,?,?)').run(id,source,options.purpose||'article');
    db.prepare('INSERT INTO attempt_assignments VALUES (?,?,?,?)').run('attempt-'+id,id,id,options.processing||'done');
    return {canonical,source,payload,discovered,fetched,hash};
  }
  const row=(url:string)=>db.prepare('SELECT * FROM articles WHERE canonical_url=?').get(url)!;
  return {directory,database,db,article,row,options:{database,dataDirectory:directory,now},close:()=>{db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('publication repair is dry-run by default; apply preserves fetch/discovery, content and audit evidence',()=>{
  const f=fixture();try {
    const a=f.article(),before=f.row(a.canonical),audit=join(f.directory,'audit.jsonl');
    const dry=repairPublication(f.options);
    assert.equal(dry.proposed,1);assert.equal(dry.updated,0);assert.deepEqual(f.row(a.canonical),before);
    const applied=repairPublication({...f.options,apply:true,auditPath:audit});
    assert.equal(applied.updated,1);
    const after=f.row(a.canonical),oldPayload=JSON.parse(a.payload),newPayload=JSON.parse(String(after.payload));
    assert.equal(after.published,'2026-11-12T08:25:00.000Z');assert.equal(after.classification,'new');
    assert.equal(newPayload.reprocessedAt,new Date(now).toISOString());
    assert.equal(after.discovered,before.discovered);assert.equal(after.fetched,before.fetched);assert.equal(after.fingerprint,before.fingerprint);
    for(const key of ['title','text','description','socialTags','discoveredAt','fetchedAt','sourceUrl'])assert.deepEqual(newPayload[key],oldPayload[key]);
    const record=JSON.parse(readFileSync(audit,'utf8').trim());
    assert.equal(record.before.payload,before.payload);assert.equal(record.after.payload,after.payload);assert.equal(record.canonicalUrl,a.canonical);assert.equal(record.requestId,1);
    assert.equal(repairPublication({...f.options,apply:true,auditPath:join(f.directory,'second.jsonl')}).updated,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM requests').get()!.n,1);
  }finally{f.close();}
});

test('repair rejects failed, pending, discovery and mismatched archives; excludes old and already-dated articles',()=>{
  const f=fixture();try {
    f.article({purpose:'audit'});f.article({purpose:'discovery'});f.article({status:404});f.article({processing:'pending'});
    f.article({archive:false,html:'<meta name="publishdate" content="2026-11-12 16:20:00">'});
    f.article({corrupt:true,html:'<meta name="publishdate" content="2026-11-12 16:21:00">'});
    f.article({fetched:now-4*3600000});f.article({published:'2026-11-12T08:00:00Z'});f.article({domain:'bbc.com'});
    f.article({source:'https://bbc.com/wrong-domain'});
    const result=repairPublication(f.options);
    assert.equal(result.eligible,7);assert.equal(result.proposed,0);assert.equal(result.skipped.no_successful_article_receipt,4);
    assert.equal(result.skipped.unreadable_archive,1);assert.equal(result.skipped.archive_hash_mismatch,1);assert.equal(result.skipped.unverified_source,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM articles WHERE published IS NULL').get()!.n,9);
  }finally{f.close();}
});

test('repair obeys row limits, retains duplicate classification and requires a write-ahead audit',()=>{
  const f=fixture();try {
    const a=f.article(),b=f.article({domain:'eastmoney.com',html:'<div id="topbox"><div class="tipbox"><div class="infos"><div class="item">2026年11月12日 16:27</div></div></div></div>'});
    f.db.prepare('UPDATE articles SET fingerprint=? WHERE canonical_url=?').run('fingerprint-1',b.canonical);
    assert.throws(()=>repairPublication({...f.options,apply:true}),/audit/);
    const page=repairPublication({...f.options,limit:1});assert.equal(page.proposed,1);assert.equal(page.truncated,true);assert.ok(page.nextCursor);
    const secondPage=repairPublication({...f.options,limit:1,cursor:page.nextCursor!});assert.equal(secondPage.eligible,1);assert.equal(secondPage.proposed,1);assert.equal(secondPage.truncated,false);
    const result=repairPublication({...f.options,apply:true,auditPath:join(f.directory,'audit.jsonl')});
    assert.equal(result.updated,2);assert.equal(f.row(a.canonical).classification,'duplicate');assert.equal(f.row(b.canonical).classification,'duplicate');
    assert.equal(f.row(b.canonical).published,'2026-11-12T08:27:00.000Z');
    assert.throws(()=>repairPublication({...f.options,limit:1001}),/Limit/);
  }finally{f.close();}
});

test('Chosun archive repair restores body and fingerprints without resetting any timestamps',()=>{
  const f=fixture();try {
    const firstDate='2026-11-12T08:12:34Z',knownDate='2026-11-12T08:10:00Z';
    const textA='A verified article paragraph from the embedded publisher story. '.repeat(8);
    const textB='A different article with independent text and independent fingerprint. '.repeat(8);
    const html=(id:string,text:string)=>'<meta property="og:title" content="Chosun story"><script>Fusion.globalContent='+JSON.stringify({_id:id,type:'story',first_publish_date:firstDate,display_date:'2030-01-01T00:00:00Z',content_elements:[{type:'text',content:text}]})+';</script>';
    const a=f.article({domain:'chosun.com',source:'https://www.chosun.com/news/A/',published:knownDate,text:'',html:html('A',textA)});
    const b=f.article({domain:'chosun.com',source:'https://www.chosun.com/news/B/',text:'',html:html('B',textB)});
    const empty=f.article({domain:'chosun.com',source:'https://www.chosun.com/news/EMPTY/',text:'',html:html('EMPTY','')});
    const oldFingerprint=createHash('sha256').update('').digest('hex');
    f.db.prepare("UPDATE articles SET fingerprint=? WHERE domain='chosun.com'").run(oldFingerprint);
    const beforeA=f.row(a.canonical),audit=join(f.directory,'chosun-audit.jsonl');
    const dry=repairPublication(f.options);assert.equal(dry.proposed,2);assert.equal(dry.updated,0);
    const result=repairPublication({...f.options,apply:true,auditPath:audit});assert.equal(result.updated,2);assert.equal(result.skipped.no_improved_article_text,1);
    const afterA=f.row(a.canonical),afterB=f.row(b.canonical),payloadA=JSON.parse(String(afterA.payload));
    assert.equal(afterA.fetched,beforeA.fetched);assert.equal(afterA.discovered,beforeA.discovered);assert.equal(payloadA.fetchedAt,JSON.parse(a.payload).fetchedAt);
    assert.equal(afterA.published,knownDate);assert.equal(afterB.published,'2026-11-12T08:12:34.000Z');
    assert.equal(payloadA.text,textA.trim());assert.equal(payloadA.title,JSON.parse(a.payload).title);assert.deepEqual(payloadA.socialTags,JSON.parse(a.payload).socialTags);
    assert.equal(afterA.fingerprint,createHash('sha256').update(textA.trim()).digest('hex'));assert.notEqual(afterA.fingerprint,afterB.fingerprint);
    assert.equal(afterA.classification,'new');assert.equal(afterB.classification,'new');assert.equal(f.row(empty.canonical).classification,'incomplete');
    const records=readFileSync(audit,'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.equal(records.length,2);
    assert.equal(records[0].before.fingerprint,oldFingerprint);assert.ok(records[0].after.fingerprint);
    assert.equal(repairPublication({...f.options,apply:true,auditPath:join(f.directory,'again.jsonl')}).updated,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM requests').get()!.n,3);
  }finally{f.close();}
});
