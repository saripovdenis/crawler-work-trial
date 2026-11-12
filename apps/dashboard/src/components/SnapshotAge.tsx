import { useEffect, useState } from 'react';

export function SnapshotAge({generatedAt,cache}:{generatedAt?:number;cache?:{refreshing?:boolean;staleLimitMs?:number}}) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  if(!generatedAt)return null;
  const seconds=Math.max(0,Math.floor((now-generatedAt)/1000));
  const age=seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`;
  const expired=!!cache?.staleLimitMs && now-generatedAt>=cache.staleLimitMs;
  return <span role="status" style={{marginLeft:8,color:expired?'#b45309':undefined}}>
    · {expired?'Snapshot expired':`${age} old`}{cache?.refreshing?' · refreshing':''}
  </span>;
}
