import { ArchiveStore } from './archives.js';

export type ArchiveMetrics = { reused:number; written:number; repaired:number; avoidedBytes:number };
/** Phase one is local. valid() must stay local-only: claims call it inside a transaction. */
export interface BodyStore {
  readonly metrics: ArchiveMetrics;
  valid(hash:string, expectedBytes:number):boolean;
  readVerified(hash:string, expectedBytes?:number):Buffer;
  readCompressed(hash:string):Buffer;
  store(body:Buffer, hash?:string):{hash:string;ref:string;reused:boolean};
}
export const createBodyStore = (directory:string):BodyStore => new ArchiveStore(directory);
