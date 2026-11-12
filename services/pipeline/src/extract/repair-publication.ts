import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { load } from 'cheerio';
import { publisherPublication, parseArticle, publisherStoryFromHtml } from '../../../../packages/core/src/parse.js';
import { classify, domainFor } from '../../../../packages/core/src/policy.js';

type Row = Record<string, any>;
export type RepairOptions = {
  database: string;
  dataDirectory: string;
  now?: number;
  windowMs?: number;
  limit?: number;
  apply?: boolean;
  auditPath?: string;
  cursor?: string;
};

/** Repair missing publisher dates and incomplete Chosun text from archived article fetches. */
export function repairPublication(options: RepairOptions) {
  const now = options.now ?? Date.now(), windowMs = options.windowMs ?? 3 * 3600_000;
  const limit = options.limit ?? 200;
  const cursor=options.cursor?JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8')):{fetched:now+1,canonicalUrl:''};
  if(!cursor || !Number.isSafeInteger(cursor.fetched) || typeof cursor.canonicalUrl!=='string')throw new Error('Invalid repair cursor');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > 7 * 86400_000)
    throw new Error('Window must be positive and no longer than seven days');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be 1..1000');
  if (options.apply && !options.auditPath) throw new Error('--apply requires a new --audit file');
  if (!existsSync(options.database)) throw new Error('Database does not exist');
  const db = new DatabaseSync(resolve(options.database), { readOnly: !options.apply });
  let audit: number | undefined;
  const result = { apply: !!options.apply, windowStart: now - windowMs, windowEnd: now, limit, truncated: false, nextCursor: null as string | null, eligible: 0, proposed: 0, updated: 0, skipped: {} as Record<string, number> };
  const skip = (reason: string) => { result.skipped[reason] = (result.skipped[reason] || 0) + 1; };
  try {
    db.exec('PRAGMA busy_timeout=2000');
    if (!options.apply) db.exec('PRAGMA query_only=ON');
    const durable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='attempt_assignments'").get();
    const articles = db.prepare(`SELECT a.*,s.started FROM articles a JOIN sites s ON s.domain=a.domain
      WHERE ((a.published IS NULL AND a.domain IN ('ce.cn','eastmoney.com'))
        OR (a.classification='incomplete' AND a.domain='chosun.com')) AND a.fetched>=? AND a.fetched<=?
      AND (a.fetched<? OR (a.fetched=? AND a.canonical_url>?))
      ORDER BY a.fetched DESC,a.canonical_url LIMIT ?`).all(now-windowMs,now,cursor.fetched,cursor.fetched,cursor.canonicalUrl,limit+1) as Row[];
    result.truncated = articles.length > limit;
    result.eligible = Math.min(articles.length, limit);
    if(result.truncated) {
      const last=articles[limit-1]!;
      result.nextCursor=Buffer.from(JSON.stringify({fetched:last.fetched,canonicalUrl:last.canonical_url})).toString('base64url');
    }
    // Load eligible receipts once, rather than rescanning a domain's complete
    // request history for every article in the batch.
    const receiptRows=db.prepare(durable ? `SELECT r.*,CASE WHEN a.attempt_id IS NULL THEN r.url ELSE t.url END source_url
      FROM requests r LEFT JOIN attempt_assignments a ON a.request_id=r.id LEFT JOIN crawl_tasks t ON t.id=a.task_id
      WHERE r.domain IN ('ce.cn','eastmoney.com','chosun.com') AND r.purpose='article' AND r.status=200
      AND r.error IS NULL AND r.body_hash IS NOT NULL AND r.finished<=? AND r.started<=?
      AND (a.attempt_id IS NULL OR (a.processing='done' AND t.purpose='article'))
      ORDER BY r.finished DESC,r.id DESC` : `SELECT r.*,r.url source_url FROM requests r
      WHERE r.domain IN ('ce.cn','eastmoney.com','chosun.com') AND r.purpose='article' AND r.status=200
      AND r.error IS NULL AND r.body_hash IS NOT NULL AND r.finished<=? AND r.started<=?
      ORDER BY r.finished DESC,r.id DESC`).all(now,now) as Row[];
    const receipts=new Map<string,Row[]>();
    for(const receipt of receiptRows) {
      const key=receipt.domain+'|'+receipt.source_url;
      const list=receipts.get(key)||[];list.push(receipt);receipts.set(key,list);
    }
    for (const row of articles.slice(0,limit)) {
      let payload: Row;
      try { payload=JSON.parse(row.payload); } catch { skip('invalid_payload'); continue; }
      if (!payload || typeof payload!=='object' || Array.isArray(payload)) { skip('invalid_payload'); continue; }
      if (row.domain!=='chosun.com' && payload.publishedAt != null) { skip('existing_payload_date'); continue; }
      const source = payload.sourceUrl;
      if (typeof source!=='string' || domainFor(source)!==row.domain) { skip('unverified_source'); continue; }
      const request = receipts.get(row.domain+'|'+source)?.find(r=>r.finished<=row.fetched && r.started<=row.fetched);
      if (!request || !/^[a-f0-9]{64}$/.test(request.body_hash)) { skip('no_successful_article_receipt'); continue; }
      if (domainFor(request.url)!==row.domain) { skip('unverified_response_domain'); continue; }
      let body: string;
      try {
        const bytes=gunzipSync(readFileSync(resolve(options.dataDirectory,'snapshots',request.body_hash+'.gz')),{maxOutputLength:5*1024*1024});
        if (createHash('sha256').update(bytes).digest('hex')!==request.body_hash) { skip('archive_hash_mismatch'); continue; }
        const headers=JSON.parse(request.headers || '{}');
        const charset=headers['content-type']?.match(/charset=["']?([^;"'\s]+)/i)?.[1]
          || bytes.subarray(0,2048).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
        try { body=new TextDecoder(charset).decode(bytes); } catch { body=bytes.toString('utf8'); }
      } catch { skip('unreadable_archive'); continue; }
      let published: string | null=row.published;
      let next={...payload}, fingerprint: string=row.fingerprint;
      if(row.domain==='chosun.com') {
        const story=publisherStoryFromHtml(body,request.url);
        const parsed=story ? {...story,isArticle:true,textSource:'fusion.globalContent.content_elements',dateSource:'fusion.globalContent.first_publish_date',title:payload.title,description:payload.description}
          : parseArticle(body,request.url,row.discovered,payload.publishedAt || null);
        if(!parsed.isArticle || parsed.text.length<200 || parsed.text.length<=(payload.text?.length||0)) { skip('no_improved_article_text'); continue; }
        // Correct text only from the archived response; keep original identity,
        // publication evidence and timing. The request ledger is never changed.
        next={...next,text:parsed.text,textSource:parsed.textSource,isArticle:true};
        if(!next.title && parsed.title)next.title=parsed.title;
        if(!next.description && parsed.description)next.description=parsed.description;
        if(!published && parsed.publishedAt) {published=parsed.publishedAt;next.publishedAt=published;next.dateSource=parsed.dateSource;}
        fingerprint=createHash('sha256').update(parsed.text).digest('hex');
      } else {
        const publication=publisherPublication(load(body),request.url);
        if (!publication) { skip('no_publisher_publication'); continue; }
        published=publication.value;
        next={...next,publishedAt:publication.value,dateSource:publication.source,isArticle:true};
      }
      const duplicate=!!db.prepare('SELECT 1 FROM articles WHERE fingerprint=? AND canonical_url<>?').get(fingerprint,row.canonical_url);
      const classification=classify(published,row.started,row.discovered,duplicate,
        next.isArticle===true && typeof next.text==='string' && next.text.length>=200 && typeof next.title==='string' && next.title.length>0);
      const nextPayload=JSON.stringify({...next,classification,reprocessedAt:new Date(now).toISOString()});
      result.proposed++;
      if (!options.apply) continue;
      // Write-ahead audit: a planned record can be undone only if the DB equals
      // its complete after value. This also makes a crash before commit harmless.
      audit ??= openSync(resolve(options.auditPath!),'wx',0o600);
      const before={published:row.published,classification:row.classification,fingerprint:row.fingerprint,payload:row.payload};
      const after={published,classification,fingerprint,payload:nextPayload};
      db.exec('BEGIN IMMEDIATE');
      try {
        const current=db.prepare('SELECT published,classification,fingerprint,payload,discovered,fetched FROM articles WHERE canonical_url=?').get(row.canonical_url) as Row;
        if (!current || current.published!==row.published || current.fingerprint!==row.fingerprint || current.payload!==row.payload || current.classification!==row.classification || current.discovered!==row.discovered || current.fetched!==row.fetched) {
          db.exec('ROLLBACK');skip('concurrent_change');continue;
        }
        writeSync(audit,JSON.stringify({version:1,phase:'planned',at:now,database:resolve(options.database),canonicalUrl:row.canonical_url,requestId:request.id,bodyHash:request.body_hash,before,after})+'\n');
        fsyncSync(audit);
        db.prepare('UPDATE articles SET published=?,classification=?,fingerprint=?,payload=? WHERE canonical_url=?').run(after.published,after.classification,after.fingerprint,after.payload,row.canonical_url);
        db.exec('COMMIT');result.updated++;
      } catch(error) { if(db.isTransaction)db.exec('ROLLBACK');throw error; }
    }
    return result;
  } finally { if(audit!==undefined)closeSync(audit);db.close(); }
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2),values=new Map<string,string>();let apply=false;
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--apply') {apply=true;continue;}
      if(!['--db','--data-dir','--hours','--limit','--audit','--cursor'].includes(args[i]!) || !args[i+1] || args[i+1]!.startsWith('--')) throw new Error('Unknown or missing argument: '+args[i]);
      values.set(args[i]!,args[++i]!);
    }
    if(!values.has('--db')||!values.has('--data-dir'))throw new Error('Usage: node --import tsx services/pipeline/src/extract/repair-publication.ts --db PATH --data-dir DIR [--hours 3] [--limit 200] [--apply --audit NEW_FILE] [--cursor TOKEN]');
    console.log(JSON.stringify(repairPublication({database:values.get('--db')!,dataDirectory:values.get('--data-dir')!,windowMs:Number(values.get('--hours')||3)*3600_000,limit:Number(values.get('--limit')||200),apply,auditPath:values.get('--audit'),cursor:values.get('--cursor')}),null,2));
  } catch(error) { console.error(String(error));process.exitCode=1; }
}
