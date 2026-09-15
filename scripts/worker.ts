import { processDeletionJobs,processOneJob,cleanOrphanReports,recordHeartbeat } from "../src/lib/worker";
import { closeDatabase,assertDatabaseRegion } from "../src/lib/db";
import { closePdfBrowser } from "../src/lib/pdf";
import { getConfig } from "../src/lib/config";
import { randomUUID } from "node:crypto";
let stopping=false;
for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>{stopping=true;});
await assertDatabaseRegion();
const workerId=randomUUID();
console.log(`Nova report worker ready (${getConfig().region}); automatic publishing enabled.`);
const once=process.argv.includes("--once");let cycles=0;
// Heartbeat on a wall-clock interval rather than per cycle: a busy queue runs the
// loop continuously and would otherwise write a heartbeat many times a second.
const HEARTBEAT_INTERVAL_MS=5000;
let lastHeartbeat=0;
try{
  do{
    if(Date.now()-lastHeartbeat>=HEARTBEAT_INTERVAL_MS){
      await recordHeartbeat(workerId);lastHeartbeat=Date.now();
    }
    await processDeletionJobs();
    if(cycles++%120===0)await cleanOrphanReports();
    const worked=await processOneJob();
    if(once&&!worked)break;
    if(!worked&&!stopping)await new Promise(resolve=>setTimeout(resolve,1000));
  }while(!stopping);
}finally{await closePdfBrowser();await closeDatabase();}
