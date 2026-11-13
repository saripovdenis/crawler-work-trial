import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWrite } from './files.js';

/** Optional dual write. No network work or upload await on the fetch/completion path. */
export class ArchiveMirror {
  private worker?:Worker;
  private closed=false;
  private restart?:ReturnType<typeof setTimeout>;
  readonly root:string;
  constructor(readonly directory:string) {
    this.root=resolve(directory,'receipts','archive-mirror');
    for(const child of ['pending','uploaded'])mkdirSync(resolve(this.root,child),{recursive:true});
    this.start();
  }
  private start() {
    if(this.closed)return;
    const worker=this.worker=new Worker(new URL('./archive-mirror-bootstrap.mjs',import.meta.url),
      {execArgv:[],workerData:{directory:this.directory},resourceLimits:{maxOldGenerationSizeMb:96}});
    worker.on('error',error=>console.error('Archive mirror:',error.message));
    worker.on('exit',()=> {
      if(this.worker===worker)this.worker=undefined;
      if(!this.closed)this.restart=setTimeout(()=>this.start(),5000);
    });
  }
  enqueue(hash:string) {
    if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid mirror hash');
    if(existsSync(resolve(this.root,'uploaded',hash+'.json')) || existsSync(resolve(this.root,'pending',hash+'.json')))return;
    atomicWrite(resolve(this.root,'pending',hash+'.json'),JSON.stringify({hash,queuedAt:Date.now()}));
    this.worker?.postMessage('wake');
  }
  async close() {
    this.closed=true;clearTimeout(this.restart);
    await this.worker?.terminate();
  }
}
