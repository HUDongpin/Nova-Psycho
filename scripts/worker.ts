import { processDeletionJobs,processOneJob,cleanOrphanReports } from "../src/lib/worker";
import { closeDatabase,assertDatabaseRegion } from "../src/lib/db";
import { closePdfBrowser } from "../src/lib/pdf";
import { getConfig } from "../src/lib/config";
let stopping=false;
for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>{stopping=true;});
await assertDatabaseRegion();
console.log(`Nova report worker ready (${getConfig().region}); automatic publishing enabled.`);
const once=process.argv.includes("--once");let cycles=0;
try{
  do{
    await processDeletionJobs();
    if(cycles++%120===0)await cleanOrphanReports();
    const worked=await processOneJob();
    if(once&&!worked)break;
    if(!worked&&!stopping)await new Promise(resolve=>setTimeout(resolve,1000));
  }while(!stopping);
}finally{await closePdfBrowser();await closeDatabase();}
