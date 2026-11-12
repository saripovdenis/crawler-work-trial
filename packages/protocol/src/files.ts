// File-only durable writes shared by coordinator/worker; no network or database.
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export function atomicWrite(path: string, value: string | Buffer) {
  const temporary=path+'.'+randomUUID()+'.tmp';
  const fd=openSync(temporary,'wx',0o600);
  try {writeFileSync(fd,value);fsyncSync(fd);} finally {closeSync(fd);}
  renameSync(temporary,path);
  const directory=openSync(dirname(path),'r');try {fsyncSync(directory);}finally{closeSync(directory);}
}
export function acquireLock(path: string) {
  try {
    const pid=Number(readFileSync(path,'utf8'));
    try {process.kill(pid,0);} catch(e:any) {if(e.code==='ESRCH') unlinkSync(path); else throw e;}
  } catch(e:any) {if(e.code!=='ENOENT') throw e;}
  const fd=openSync(path,'wx');writeFileSync(fd,String(process.pid));closeSync(fd);
  return ()=>unlinkSync(path);
}
