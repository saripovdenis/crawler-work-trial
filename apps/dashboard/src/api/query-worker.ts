import { parentPort, workerData } from 'node:worker_threads';
import { CoverageReader } from '../../../../packages/reconciliation/src/view.js';
import { Observatory } from '../metrics/observability.js';
import { Charts } from '../metrics/charts.js';

const coverage=new CoverageReader(workerData.monitorPath,workerData.directory+'/crawler.sqlite');
const observation=new Observatory(workerData.directory);
const charts=new Charts(workerData.directory);
parentPort!.on('message',async ({id,method,args})=> {
  const startedAt=Date.now();
  try {
    let value;
    if(method==='coverage') value=coverage.dataset(args.window,args.site,args.provider,startedAt,args.freshness);
    else if(method==='overview') value=observation.overview();
    else if(method==='charts') value=charts.parsingQuality(new URLSearchParams(args.query));
    else if(method==='detail') value=await observation.requestDetail(args.id);
    else if(method==='requests') value=observation.requests(new URLSearchParams(args.query));
    else if(method==='articles') value=observation.articles(new URLSearchParams(args.query));
    else if(method==='sources') value=observation.sources(new URLSearchParams(args.query));
    else throw new Error('Invalid dashboard query');
    parentPort!.postMessage({id,value,startedAt,durationMs:Date.now()-startedAt});
  } catch(error) {parentPort!.postMessage({id,error:String(error)});}
});
