// Read-only against Garage. Writes only the local verification report.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { StorageClient } from '../../packages/protocol/src/storage-client.js';
import { createBodyStore } from '../../packages/protocol/src/body-store.js';
import { atomicWrite } from '../../packages/protocol/src/files.js';
import { MAX_RESPONSE_BYTES } from '../../packages/protocol/src/index.js';

const directory=resolve(process.env.CRAWLER_DATA_DIR || 'data');
const root=resolve(directory,'receipts','archive-mirror'),bodies=createBodyStore(directory),client=new StorageClient();
const limit=Number(process.env.ARCHIVE_VERIFY_LIMIT || 500);
if(!Number.isInteger(limit)||limit<1||limit>100000)throw new Error('Invalid verification limit');
const reportPath=resolve(directory,'receipts','archive-mirror-verification.json');
let previous:{verifiedHashes:string[];startedAt:number}={verifiedHashes:[],startedAt:Date.now()};
try {previous=JSON.parse(readFileSync(reportPath,'utf8'));}catch {}
const verified=new Set(process.env.ARCHIVE_VERIFY_ALL==='1'?[]:previous.verifiedHashes);
const names=readdirSync(resolve(root,'uploaded')).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
const selected=names.filter(name=>!verified.has(name.slice(0,-5))).slice(0,limit);
const errors:{hash:string;error:string}[]=[];
try {
  for(const name of selected) {
    const hash=name.slice(0,-5);
    try {
      const body=gunzipSync(await client.get(hash),{maxOutputLength:MAX_RESPONSE_BYTES});
      if(createHash('sha256').update(body).digest('hex')!==hash || !body.equals(bodies.readVerified(hash)))throw new Error('Body hash/content mismatch');
      verified.add(hash);
    }catch(error) {errors.push({hash,error:error instanceof Error?error.message:String(error)});}
  }
}finally {client.close();}
const report={startedAt:previous.startedAt,generatedAt:Date.now(),uploaded:names.length,checkedThisRun:selected.length,
  verified:verified.size,remaining:names.filter(name=>!verified.has(name.slice(0,-5))).length,errors,verifiedHashes:[...verified]};
atomicWrite(reportPath,JSON.stringify(report));
const {verifiedHashes,...summary}=report;
console.log(JSON.stringify(summary));
if(errors.length)process.exitCode=1;
