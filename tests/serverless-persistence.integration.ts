import { randomUUID } from "node:crypto";
import { afterAll,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("../src/lib/pdf",()=>({renderPdf:vi.fn(async()=>Buffer.from("%PDF-1.4 SYNTHETIC DATABASE TEST ONLY")),closePdfBrowser:vi.fn()}));
import { demoAdvice,demoScale,demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";
import type { AssessmentSnapshot,Actor,Region } from "../src/domain/types";
import { closeDatabase,query,transaction } from "../src/lib/db";
import { deleteFamily } from "../src/lib/families";
import { renderPdf } from "../src/lib/pdf";
import { MAX_PRIVATE_PDF_BYTES,readPrivatePdf,writePrivatePdf } from "../src/lib/storage";
import { processReportJob } from "../src/lib/worker";

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw new Error("A dedicated local persistence test database is required");
const address=new URL(databaseUrl);
if(!["127.0.0.1","localhost"].includes(address.hostname)||!address.pathname.startsWith("/nova_queue_test_")||process.env.NOVA_MODE!=="demo"||process.env.NOVA_REPORT_STORAGE!=="database")throw new Error("Persistence checks require an isolated loopback synthetic database");
const fakePdf=Buffer.from("%PDF-1.4 SYNTHETIC DATABASE TEST ONLY");
const answers={q1:1,q2:2,q3:1,q4:2,q5:1,q6:2,q7:1,q8:2,q9:0};
const actor:Actor={id:randomUUID(),name:"Synthetic admin",role:"admin",region:"CN"};

async function fixture(region:Region="CN"){
  const userId=randomUUID(),familyId=randomUUID(),assessmentId=randomUUID(),jobId=randomUUID();
  const submittedAt=new Date().toISOString();
  const snapshot:AssessmentSnapshot={scale:demoScale,advice:{id:randomUUID(),version:"1.0.0",content:demoAdvice},template:{id:randomUUID(),version:"1.0.0",content:demoTemplate},score:scoreAssessment(demoScale,answers,{age:12,region,role:"parent"}),childName:"Synthetic persistence child",grade:"S2",submittedAt,aiConsented:false};
  await transaction(async client=>{
    await client.query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,$2,$3,'Synthetic persistence parent','parent',true)",[userId,region,`synthetic_${userId}`]);
    await client.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label) VALUES($1,$2,'Synthetic persistence family','Synthetic persistence child','2013-04-12','S2','Parent')",[familyId,region]);
    await client.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'parent')",[familyId,userId]);
    await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,status,answers,snapshot,submitted_at) VALUES($1,$2,$3,$4,'parent',$5,'zh-CN','queued',$6,$7,$8)",[assessmentId,familyId,region,userId,`${demoScale.id}@${demoScale.version}`,JSON.stringify(answers),JSON.stringify(snapshot),submittedAt]);
    await client.query("INSERT INTO report_jobs(id,assessment_id) VALUES($1,$2)",[jobId,assessmentId]);
  });
  return {userId,familyId,assessmentId,jobId};
}
async function fileCount(reportId:string){return (await query<{n:number}>("SELECT count(*)::int AS n FROM report_files WHERE report_id=$1",[reportId]))[0].n;}
beforeEach(()=>{vi.mocked(renderPdf).mockReset().mockResolvedValue(fakePdf);});
afterAll(async()=>{await closeDatabase();});

describe("real PostgreSQL serverless persistence (PDF rendering intentionally stubbed)",()=>{
  it("publishes both encrypted locales atomically and deduplicates later delivery",async()=>{
    const item=await fixture();
    await expect(processReportJob(item.jobId)).resolves.toEqual({status:"published"});
    expect(await fileCount(item.assessmentId)).toBe(2);
    const files=await query<{file_key:string;encrypted_body:Buffer;locale:string}>("SELECT file_key,encrypted_body,locale FROM report_files WHERE report_id=$1 ORDER BY locale",[item.assessmentId]);
    expect(files.map(row=>row.locale)).toEqual(["zh-CN","zh-HK"]);
    for(const file of files){expect(file.encrypted_body.subarray(0,5).toString()).toBe("NOVA1");expect(file.encrypted_body.includes(Buffer.from("SYNTHETIC DATABASE"))).toBe(false);expect(await readPrivatePdf(file.file_key)).toEqual(fakePdf);}
    await expect(processReportJob(item.jobId)).resolves.toEqual({status:"already_done"});
    expect(vi.mocked(renderPdf)).toHaveBeenCalledTimes(2);
    expect((await query("SELECT state,attempts FROM report_jobs WHERE id=$1",[item.jobId]))[0]).toMatchObject({state:"done",attempts:1});
  });
  it("rolls back the first locale if the second file fails and can subsequently retry",async()=>{
    const item=await fixture(),tooLarge=Buffer.alloc(MAX_PRIVATE_PDF_BYTES+1);tooLarge.write("%PDF");
    vi.mocked(renderPdf).mockResolvedValueOnce(fakePdf).mockResolvedValueOnce(tooLarge);
    expect((await processReportJob(item.jobId)).status).toBe("retry_at");
    expect(await fileCount(item.assessmentId)).toBe(0);
    expect(await query("SELECT id FROM reports WHERE id=$1",[item.assessmentId])).toHaveLength(0);
    expect((await query("SELECT status FROM assessments WHERE id=$1",[item.assessmentId]))[0].status).toBe("queued");
    await query("UPDATE report_jobs SET available_at=now() WHERE id=$1",[item.jobId]);
    await expect(processReportJob(item.jobId)).resolves.toEqual({status:"published"});
    expect(await fileCount(item.assessmentId)).toBe(2);
  });
  it("the deferred report foreign key refuses to commit an unowned PDF",async()=>{
    const item=await fixture(),key=`${item.assessmentId}.${randomUUID()}.zh-CN.pdf.enc`;
    await expect(transaction(client=>writePrivatePdf(key,fakePdf,client))).rejects.toMatchObject({code:"23503"});
    expect(await fileCount(item.assessmentId)).toBe(0);
  });
  it("competing deliveries cannot render twice or claim a different queued job",async()=>{
    const item=await fixture(),unrelated=await fixture();
    let release!:()=>void,started!:()=>void;
    const paused=new Promise<void>(resolve=>{release=resolve;}),observed=new Promise<void>(resolve=>{started=resolve;});
    vi.mocked(renderPdf).mockImplementationOnce(async()=>{started();await paused;return fakePdf;});
    const first=processReportJob(item.jobId);
    await observed;
    try{expect((await processReportJob(item.jobId)).status).toBe("retry_at");}
    finally{release();}
    await expect(first).resolves.toEqual({status:"published"});
    expect(await fileCount(item.assessmentId)).toBe(2);expect(vi.mocked(renderPdf)).toHaveBeenCalledTimes(2);
    expect((await query("SELECT state,attempts FROM report_jobs WHERE id=$1",[unrelated.jobId]))[0]).toMatchObject({state:"ready",attempts:0});
  });
  it("cascades both PDFs and the job when the authorized synthetic family is deleted",async()=>{
    const item=await fixture();await processReportJob(item.jobId);
    await deleteFamily(actor,item.familyId,{confirmation:"Synthetic persistence child"});
    expect(await fileCount(item.assessmentId)).toBe(0);
    expect(await query("SELECT id FROM reports WHERE id=$1",[item.assessmentId])).toHaveLength(0);
    expect(await query("SELECT id FROM report_jobs WHERE id=$1",[item.jobId])).toHaveLength(0);
    expect(await query("SELECT file_key FROM file_deletion_jobs WHERE file_key LIKE $1",[`${item.assessmentId}%`])).toHaveLength(0);
    await expect(processReportJob(item.jobId)).resolves.toEqual({status:"already_done"});
  });
  it("cannot resurrect a family deleted while a report is rendering",async()=>{
    const item=await fixture();let release!:()=>void,started!:()=>void;
    const paused=new Promise<void>(resolve=>{release=resolve;}),observed=new Promise<void>(resolve=>{started=resolve;});
    vi.mocked(renderPdf).mockImplementationOnce(async()=>{started();await paused;return fakePdf;});
    const rendering=processReportJob(item.jobId);await observed;
    try{await deleteFamily(actor,item.familyId,{confirmation:"Synthetic persistence child"});}
    finally{release();}
    await expect(rendering).resolves.toEqual({status:"already_done"});
    expect(await fileCount(item.assessmentId)).toBe(0);
  });
  it("marks the assessment and job failed together after three crashed claims",async()=>{
    const item=await fixture();
    await query("UPDATE report_jobs SET state='running',attempts=3,lease_until=now()-interval '1 second',available_at=now()-interval '1 second' WHERE id=$1",[item.jobId]);
    await expect(processReportJob(item.jobId)).resolves.toEqual({status:"terminal"});
    expect(vi.mocked(renderPdf)).not.toHaveBeenCalled();
    expect((await query("SELECT j.state,j.attempts,a.status FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE j.id=$1",[item.jobId]))[0]).toMatchObject({state:"failed",attempts:3,status:"failed"});
  });
  it("never claims a job belonging to a different application region",async()=>{
    const item=await fixture("HK");
    await expect(processReportJob(item.jobId)).resolves.toEqual({status:"already_done"});
    expect(vi.mocked(renderPdf)).not.toHaveBeenCalled();
    expect((await query("SELECT state,attempts FROM report_jobs WHERE id=$1",[item.jobId]))[0]).toMatchObject({state:"ready",attempts:0});
  });
});
