import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ArchiveStore } from '../../protocol/src/archives.js';
import { atomicWrite } from '../../protocol/src/files.js';
import { MAX_RESPONSE_BYTES } from '../../protocol/src/index.js';
import { LruCache } from './lru.js';
import { PARSER_VERSION } from './parser-version.js';
import { discover, parseArticle } from './parse.js';

type Archive={response_ref:string;body_hash:string;bytes:number;headers:Record<string,string>;url:string};
export type ParseInput=Archive & ({kind:'discovery';sourceKind:string}|{kind:'article';discovered:number;hint:string|null});
type Extraction={kind:'discovery';found:ReturnType<typeof discover>}|{kind:'article';article:ReturnType<typeof parseArticle>};
export type ParseResult=Extraction & {cache?:{key:string;hit:boolean};mappingKey?:string};
export class CachedExtractor {
  private memory=new LruCache<string,Extraction>(128,16*1024*1024);
  private archives:ArchiveStore;
  private cacheDirectory:string;
  readonly metrics={memoryHits:0,diskHits:0,misses:0,avoidedParses:0,partialBypasses:0,readErrors:0,writeErrors:0,parseMs:0};
  constructor(readonly directory:string) {
    this.archives=new ArchiveStore(directory);
    this.cacheDirectory=resolve(directory,'snapshots','parsed');
    mkdirSync(this.cacheDirectory,{recursive:true});
  }
  parse(input:ParseInput):ParseResult {
    if(!/^[a-f0-9]{64}$/.test(input.body_hash) || input.response_ref!==`snapshots/${input.body_hash}.gz`
      || !Number.isInteger(input.bytes) || input.bytes<0 || input.bytes>MAX_RESPONSE_BYTES)
      throw new Error('Invalid archive reference');
    const key=createHash('sha256').update(JSON.stringify([PARSER_VERSION,input.body_hash,input.bytes,input.url,
      input.kind,input.headers['content-type']??'',input.kind==='article'?input.hint:input.sourceKind,
      input.kind==='discovery'?Math.floor(Date.now()/86400000):null])).digest('hex');
    const bind=(value:Extraction,hit:boolean):ParseResult=>value.kind==='article'
      ? {...value,article:{...value.article,discoveredAt:new Date((input as ParseInput & {discovered:number}).discovered).toISOString()},cache:{key,hit}}
      : {...value,cache:{key,hit}};
    const memory=this.memory.get(key);
    if(memory){
      if(!this.archives.valid(input.body_hash,input.bytes))throw new Error('Archive integrity mismatch');
      this.metrics.memoryHits++;this.metrics.avoidedParses++;return bind(memory,true);
    }
    const path=resolve(this.cacheDirectory,key+'.json.gz');
    try {
      const saved=JSON.parse(gunzipSync(readFileSync(path),{maxOutputLength:16*1024*1024}).toString('utf8'));
      if(saved.version!==PARSER_VERSION || saved.key!==key || typeof saved.data!=='string'
        || createHash('sha256').update(saved.data).digest('hex')!==saved.checksum)throw new Error('Invalid extraction cache');
      const value=JSON.parse(saved.data) as Extraction;
      if(value.kind!==input.kind || (value.kind==='discovery' && (!Array.isArray(value.found?.articles)||value.found.partial))
        || (value.kind==='article' && typeof value.article?.text!=='string'))throw new Error('Invalid cached extraction');
      if(!this.archives.valid(input.body_hash,input.bytes))throw new Error('Archive integrity mismatch');
      this.memory.set(key,value,Buffer.byteLength(saved.data));
      this.metrics.diskHits++;this.metrics.avoidedParses++;return bind(value,true);
    } catch(error:any) {if(error.code!=='ENOENT')this.metrics.readErrors++;}
    this.metrics.misses++;
    const bytes=this.archives.readVerified(input.body_hash,input.bytes);
    const charset=input.headers['content-type']?.match(/charset=["']?([^;"'\s]+)/i)?.[1]
      || bytes.subarray(0,2048).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    let body:string;
    try{body=new TextDecoder(charset).decode(bytes);}catch{body=bytes.toString('utf8');}
    const started=performance.now();
    const value:Extraction=input.kind==='discovery'
      ? {kind:'discovery',found:discover(body,input.url,input.sourceKind)}
      : {kind:'article',article:parseArticle(body,input.url,input.discovered,input.hint)};
    this.metrics.parseMs+=performance.now()-started;
    if(value.kind==='discovery' && value.found.partial){this.metrics.partialBypasses++;return bind(value,false);}
    // Observation time is per request; never persist it as extraction evidence.
    if(value.kind==='article')value.article={...value.article,discoveredAt:''};
    const data=JSON.stringify(value),size=Buffer.byteLength(data);
    this.memory.set(key,value,size);
    if(size<=8*1024*1024)try {
      atomicWrite(path,gzipSync(JSON.stringify({version:PARSER_VERSION,key,checksum:createHash('sha256').update(data).digest('hex'),data})));
      if(this.metrics.misses%256===0)this.prune();
    }catch{this.metrics.writeErrors++;}
    return bind(value,false);
  }
  private prune() {
    const files=readdirSync(this.cacheDirectory).filter(name=>/^[a-f0-9]{64}\.json\.gz$/.test(name));
    if(files.length<=5000)return;
    files.sort((a,b)=>statSync(resolve(this.cacheDirectory,a)).mtimeMs-statSync(resolve(this.cacheDirectory,b)).mtimeMs);
    for(const file of files.slice(0,files.length-5000))unlinkSync(resolve(this.cacheDirectory,file));
  }
}
