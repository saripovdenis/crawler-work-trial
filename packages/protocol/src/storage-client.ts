// The only S3 client. Deliberately loopback-only during the Garage trial.
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { MAX_RESPONSE_BYTES } from './index.js';

export class StorageClient {
  private client:S3Client;
  private bucket:string;
  constructor(env:NodeJS.ProcessEnv=process.env) {
    const endpoint=new URL(env.ARCHIVE_S3_ENDPOINT || 'http://127.0.0.1:3900');
    if(endpoint.protocol!=='http:' || endpoint.hostname!=='127.0.0.1' || endpoint.pathname!=='/'
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Storage endpoint must be loopback HTTP');
    this.bucket=env.ARCHIVE_S3_BUCKET || 'response-archive';
    if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(this.bucket))throw new Error('Invalid archive bucket');
    if(!env.ARCHIVE_S3_ACCESS_KEY || !env.ARCHIVE_S3_SECRET_KEY)throw new Error('Missing storage credentials');
    this.client=new S3Client({endpoint:endpoint.href,region:env.ARCHIVE_S3_REGION || 'garage',forcePathStyle:true,
      maxAttempts:1,followRegionRedirects:false,requestChecksumCalculation:'WHEN_REQUIRED',
      credentials:{accessKeyId:env.ARCHIVE_S3_ACCESS_KEY,secretAccessKey:env.ARCHIVE_S3_SECRET_KEY}});
  }
  private key(hash:string) {
    if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid body hash');
    return `snapshots/${hash}.gz`;
  }
  async put(hash:string,body:Buffer) {
    if(body.length>MAX_RESPONSE_BYTES+65536)throw new Error('Archive too large');
    await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:this.key(hash),Body:body,
      ContentType:'application/gzip',Metadata:{sha256:hash}}),{abortSignal:AbortSignal.timeout(5000)});
  }
  async get(hash:string):Promise<Buffer> {
    const response=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:this.key(hash)}),
      {abortSignal:AbortSignal.timeout(5000)});
    const stream=response.Body as AsyncIterable<Uint8Array> & {destroy():void} | undefined;
    if(!stream)throw new Error('Empty storage response');
    const chunks:Uint8Array[]=[];let length=0;
    try {
      for await(const chunk of stream) {
        length+=chunk.length;
        if(length>MAX_RESPONSE_BYTES+65536)throw new Error('Archive too large');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {stream.destroy();}
  }
  close() {this.client.destroy();}
}
