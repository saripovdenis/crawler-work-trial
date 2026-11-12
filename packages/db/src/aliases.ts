import type { DatabaseSync } from 'node:sqlite';
import { domainFor } from '../../core/src/policy.js';

export class ArticleAliases {
  constructor(readonly db:DatabaseSync) {}
  remember(from:string,to:string,kind:'redirect'|'canonical',requestId:number,observed:number) {
    // Exact, observed URLs only. No host/scheme/slash/title/query normalization.
    if(from===to || !domainFor(from) || domainFor(from)!==domainFor(to))return 0;
    return Number(this.db.prepare(`INSERT INTO article_aliases(alias_url,target_url,domain,kind,request_id,observed,expires)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(alias_url) DO UPDATE SET target_url=excluded.target_url,
      kind=excluded.kind,request_id=excluded.request_id,observed=excluded.observed,expires=excluded.expires
      WHERE excluded.observed>=article_aliases.observed`).run(from,to,domainFor(from)!,kind,requestId,observed,observed+7*86400_000).changes);
  }
  resolve(url:string,now:number):string|undefined {
    const seen=new Set<string>();let current=url;
    for(let n=0;n<8;n++) {
      if(seen.has(current))return;seen.add(current);
      const row=this.db.prepare('SELECT target_url FROM article_aliases WHERE alias_url=? AND expires>?').get(current,now);
      if(!row)return current;
      current=String(row.target_url);
    }
  }
  backfill() {
    if(this.db.prepare("SELECT 1 FROM meta WHERE key='alias-backfill-v1'").get())return 0;
    const responses=this.db.prepare(`SELECT id,url,domain,status,headers,finished FROM requests
      WHERE purpose='article' AND error IS NULL AND finished IS NOT NULL
      AND (status IN (301,308) OR (status=200 AND body_hash IS NOT NULL)) ORDER BY id`).all();
    const direct=new Map<string,typeof responses[number]>();let count=0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const r of responses) {
        if(r.status===200) {direct.set(String(r.url),r);continue;}
        try {
          const location=JSON.parse(String(r.headers||'{}')).location;
          if(typeof location==='string')count+=this.remember(String(r.url),new URL(location,String(r.url)).href,'redirect',Number(r.id),Number(r.finished));
        }catch {}
      }
      const articles=this.db.prepare(`SELECT canonical_url,json_extract(payload,'$.sourceUrl') source
        FROM articles WHERE classification<>'incomplete' AND json_extract(payload,'$.isArticle')=1`).all();
      for(const a of articles) {
        const response=direct.get(String(a.source));
        if(response)count+=this.remember(String(a.source),String(a.canonical_url),'canonical',Number(response.id),Number(response.finished));
      }
      this.db.prepare("INSERT INTO meta(key,value) VALUES ('alias-backfill-v1','done')").run();
      this.db.exec('COMMIT');return count;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
}
