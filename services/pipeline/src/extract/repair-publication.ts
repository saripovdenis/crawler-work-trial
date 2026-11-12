import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { load } from 'cheerio';
import { publisherPublication } from '../../../../packages/core/src/parse.js';
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
};

/** Repair only missing publication evidence from an already archived article fetch. */
export function repairPublication(options: RepairOptions) {
  const now = options.now ?? Date.now(), windowMs = options.windowMs ?? 3 * 3600_000;
  const limit = options.limit ?? 200;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > 7 * 86400_000)
    throw new Error('Window must be positive and no longer than seven days');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be 1..1000');
  if (options.apply && !options.auditPath) throw new Error('--apply requires a new --audit file');
  if (!existsSync(options.database)) throw new Error('Database does not exist');
  const db = new DatabaseSync(resolve(options.database), { readOnly: !options.apply });
  let audit: number | undefined;
  const result = { apply: !!options.apply, windowStart: now - windowMs, windowEnd: now, limit, truncated: false, eligible: 0, proposed: 0, updated: 0, skipped: {} as Record<string, number> };
  const skip = (reason: string) => { result.skipped[reason] = (result.skipped[reason] || 0) + 1; };
  try {
    db.exec('PRAGMA busy_timeout=2000');
    if (!options.apply) db.exec('PRAGMA query_only=ON');
    const durable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='attempt_assignments'").get();
    const articles = db.prepare(`SELECT a.*,s.started FROM articles a JOIN sites s ON s.domain=a.domain
      WHERE a.published IS NULL AND a.domain IN ('ce.cn','eastmoney.com') AND a.fetched>=? AND a.fetched<=?
      ORDER BY a.fetched DESC,a.canonical_url LIMIT ?`).all(now-windowMs,now,limit+1) as Row[];
    result.truncated = articles.length > limit;
    result.eligible = Math.min(articles.length, limit);
    const receipt = db.prepare(durable ? `SELECT r.* FROM requests r
      LEFT JOIN attempt_assignments a ON a.request_id=r.id LEFT JOIN crawl_tasks t ON t.id=a.task_id
      WHERE r.domain=? AND r.purpose='article' AND r.status=200 AND r.error IS NULL
      AND r.body_hash IS NOT NULL AND r.finished<=? AND r.started<=?
      AND ((a.processing='done' AND t.purpose='article' AND t.url=?) OR (a.attempt_id IS NULL AND r.url=?))
      ORDER BY r.finished DESC,r.id DESC LIMIT 1` : `SELECT r.* FROM requests r
      WHERE r.domain=? AND r.purpose='article' AND r.status=200 AND r.error IS NULL
      AND r.body_hash IS NOT NULL AND r.finished<=? AND r.started<=? AND r.url=? AND r.url=?
      ORDER BY r.finished DESC,r.id DESC LIMIT 1`);
    for (const row of articles.slice(0,limit)) {
      let payload: Row;
      try { payload=JSON.parse(row.payload); } catch { skip('invalid_payload'); continue; }
      if (!payload || typeof payload!=='object' || Array.isArray(payload) || payload.publishedAt != null) { skip('existing_payload_date'); continue; }
      const source = payload.sourceUrl;
      if (typeof source!=='string' || domainFor(source)!==row.domain) { skip('unverified_source'); continue; }
      const request = receipt.get(row.domain,row.fetched,row.fetched,source,source) as Row | undefined;
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
      const publication=publisherPublication(load(body),request.url);
      if (!publication) { skip('no_publisher_publication'); continue; }
      const duplicate=!!db.prepare('SELECT 1 FROM articles WHERE fingerprint=? AND canonical_url<>?').get(row.fingerprint,row.canonical_url);
      const classification=classify(publication.value,row.started,row.discovered,duplicate,
        typeof payload.text==='string' && payload.text.length>=200 && typeof payload.title==='string' && payload.title.length>0);
      const nextPayload=JSON.stringify({...payload,publishedAt:publication.value,dateSource:publication.source,isArticle:true,classification});
      result.proposed++;
      if (!options.apply) continue;
      // Write-ahead audit: a planned record can be undone only if the DB equals
      // its complete after value. This also makes a crash before commit harmless.
      audit ??= openSync(resolve(options.auditPath!),'wx',0o600);
      const before={published:row.published,classification:row.classification,payload:row.payload};
      const after={published:publication.value,classification,payload:nextPayload};
      db.exec('BEGIN IMMEDIATE');
      try {
        const current=db.prepare('SELECT published,classification,payload,discovered,fetched FROM articles WHERE canonical_url=?').get(row.canonical_url) as Row;
        if (!current || current.published!==null || current.payload!==row.payload || current.classification!==row.classification || current.discovered!==row.discovered || current.fetched!==row.fetched) {
          db.exec('ROLLBACK');skip('concurrent_change');continue;
        }
        writeSync(audit,JSON.stringify({version:1,phase:'planned',at:now,database:resolve(options.database),canonicalUrl:row.canonical_url,requestId:request.id,bodyHash:request.body_hash,before,after})+'\n');
        fsyncSync(audit);
        db.prepare('UPDATE articles SET published=?,classification=?,payload=? WHERE canonical_url=?').run(after.published,after.classification,after.payload,row.canonical_url);
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
      if(!['--db','--data-dir','--hours','--limit','--audit'].includes(args[i]!) || !args[i+1] || args[i+1]!.startsWith('--')) throw new Error('Unknown or missing argument: '+args[i]);
      values.set(args[i]!,args[++i]!);
    }
    if(!values.has('--db')||!values.has('--data-dir'))throw new Error('Usage: node --import tsx services/pipeline/src/extract/repair-publication.ts --db PATH --data-dir DIR [--hours 3] [--limit 200] [--apply --audit NEW_FILE]');
    console.log(JSON.stringify(repairPublication({database:values.get('--db')!,dataDirectory:values.get('--data-dir')!,windowMs:Number(values.get('--hours')||3)*3600_000,limit:Number(values.get('--limit')||200),apply,auditPath:values.get('--audit')}),null,2));
  } catch(error) { console.error(String(error));process.exitCode=1; }
}
