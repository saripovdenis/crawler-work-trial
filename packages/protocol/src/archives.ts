import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { LruCache } from '../../core/src/lru.js';
import { atomicWrite } from './files.js';
import { MAX_RESPONSE_BYTES } from './index.js';
import type { BodyStore } from './body-store.js';

export class ArchiveStore implements BodyStore {
  private verified=new LruCache<string,string>(4096);
  readonly metrics={reused:0,written:0,repaired:0,avoidedBytes:0};
  constructor(readonly directory:string) {}
  private signature(path:string) {
    const stat=lstatSync(path);
    if(!stat.isFile())throw new Error('Archive is not a regular file');
    return [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
  }
  valid(hash:string,expectedBytes:number):boolean {
    if(!/^[a-f0-9]{64}$/.test(hash))return false;
    const path=resolve(this.directory,'snapshots',hash+'.gz');
    try {
      const signature=this.signature(path)+':'+expectedBytes;
      if(this.verified.get(hash)===signature)return true;
      this.readVerified(hash,expectedBytes);return true;
    } catch {this.verified.delete(hash);return false;}
  }
  readVerified(hash:string,expectedBytes?:number):Buffer {
    if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid archive reference');
    const path=resolve(this.directory,'snapshots',hash+'.gz'),signature=this.signature(path)+':'+expectedBytes;
    const body=gunzipSync(readFileSync(path),{maxOutputLength:MAX_RESPONSE_BYTES});
    if((expectedBytes!==undefined && body.length!==expectedBytes) || createHash('sha256').update(body).digest('hex')!==hash)
      throw new Error('Archive integrity mismatch');
    this.verified.set(hash,signature);return body;
  }
  readCompressed(hash:string):Buffer {
    this.readVerified(hash);
    return readFileSync(resolve(this.directory,'snapshots',hash+'.gz'));
  }
  store(body:Buffer,hash=createHash('sha256').update(body).digest('hex')) {
    if(body.length>MAX_RESPONSE_BYTES || !/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid archive');
    if(this.valid(hash,body.length)) {
      this.metrics.reused++;this.metrics.avoidedBytes+=body.length;
      return {hash,ref:`snapshots/${hash}.gz`,reused:true};
    }
    const path=resolve(this.directory,'snapshots',hash+'.gz');
    try {lstatSync(path);this.metrics.repaired++;}catch {}
    mkdirSync(resolve(this.directory,'snapshots'),{recursive:true});
    atomicWrite(path,gzipSync(body));
    this.verified.set(hash,this.signature(path)+':'+body.length);this.metrics.written++;
    return {hash,ref:`snapshots/${hash}.gz`,reused:false};
  }
}
