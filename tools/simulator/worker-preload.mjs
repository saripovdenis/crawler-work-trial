// Fixtures for news requests; only loopback TCP remains available for the scheduler.
import net from 'node:net';
import { responseFor } from './responses.cjs';
const originalFetch=globalThis.fetch, connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const first=Array.isArray(args[0])?args[0][0]:args[0];
  const host=typeof first==='object'?first.host:typeof args[1]==='string'?args[1]:'localhost';
  if(!['127.0.0.1','::1','localhost'].includes(host))throw new Error('Offline test blocked non-loopback socket');
  return connect.apply(this,args);
};
globalThis.fetch=async(input,options)=>{
  const url=new URL(String(input));
  if(url.hostname==='127.0.0.1')return originalFetch(input,options);
  const result=responseFor(url.href);return new Response(result.body,{status:result.status,headers:result.headers});
};
