import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { demoAdvice,demoScale,demoTemplate } from "../src/domain/demo";
import { scoreAssessment } from "../src/domain/scoring";
import { parseScale } from "../src/domain/validation";
import { pool,closeDatabase } from "../src/lib/db";
import { getConfig } from "../src/lib/config";
import { ageAt } from "../src/lib/access";
import type { AssessmentSnapshot,RespondentRole } from "../src/domain/types";
import { noticeVersion } from "../src/lib/privacy";
import {reportHtml} from "../src/domain/report-html";
const config=getConfig(),db=pool();
try{
  const marker=await db.query("SELECT to_regclass('public.deployment_settings') AS marker");
  if(marker.rows[0].marker){const r=await db.query("SELECT to_jsonb(deployment_settings) AS settings FROM deployment_settings");if(r.rows[0]?.settings.region!==config.region)throw new Error("Refusing to migrate a different region");if(r.rows[0]?.settings.mode&&r.rows[0].settings.mode!==config.mode)throw new Error("Refusing to change a database data classification");}
  else{const r=await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");if(r.rows.length)throw new Error("Refusing to migrate a non-empty unowned database");}
  await db.query(await fs.readFile(new URL("../src/lib/schema.sql",import.meta.url),"utf8"));
  await db.query("INSERT INTO deployment_settings(singleton,region,mode) VALUES(true,$1,$2) ON CONFLICT(singleton) DO NOTHING",[config.region,config.mode]);
  const frozenMissing=await db.query("SELECT id,payload FROM reports WHERE html_documents IS NULL");
  if(frozenMissing.rows.length){
    const migration=await db.connect();
    try{
      await migration.query("BEGIN");await migration.query("ALTER TABLE reports DISABLE TRIGGER reports_immutable");
      for(const r of frozenMissing.rows)await migration.query("UPDATE reports SET html_documents=$1 WHERE id=$2 AND html_documents IS NULL",[JSON.stringify({"zh-CN":reportHtml(r.payload,"zh-CN"),"zh-HK":reportHtml(r.payload,"zh-HK")}),r.id]);
      await migration.query("ALTER TABLE reports ENABLE TRIGGER reports_immutable");await migration.query("COMMIT");
    }catch(e){await migration.query("ROLLBACK");throw e;}finally{migration.release();}
  }
  console.log(`Schema ready for ${config.region}.`);
  if(config.mode!=="demo"){console.log("Service mode: no demo accounts or clinical instruments were seeded.");}
  else{
    const count=await db.query("SELECT count(*)::int AS n FROM users");
    if(count.rows[0].n>0)console.log("Existing data preserved; synthetic seed skipped.");
    else{
      const client=await db.connect();
      try{
        await client.query("BEGIN");
        const hk=config.region==="HK",scale=parseScale(demoScale),scaleId=`${scale.id}@${scale.version}`;
        const adviceId=randomUUID(),templateId=randomUUID();
        await client.query("INSERT INTO scales(id,scale_id,version,definition) VALUES($1,$2,$3,$4)",[scaleId,scale.id,scale.version,JSON.stringify(scale)]);
        await client.query("INSERT INTO content_versions(id,kind,version,content) VALUES($1,'advice','1.0.0',$2),($3,'template','1.0.0',$4)",[adviceId,JSON.stringify(demoAdvice),templateId,JSON.stringify(demoTemplate)]);
        const accounts=[
          {key:"admin",name:hk?"Nova 管理員 · 示範":"Nova 管理员 · 演示",role:"admin"},
          {key:"staff",name:hk?"陳老師 · 示範":"陈老师 · 演示",role:"staff"},
          {key:"staff_other",name:hk?"何老師 · 示範":"何老师 · 演示",role:"staff"},
          {key:"parent",name:hk?"林家長 · 示範":"林家长 · 演示",role:"parent"},
          {key:"student",name:hk?"林小禾 · 示範":"林小禾 · 演示",role:"student"},
          {key:"parent_other",name:hk?"周家長 · 示範":"周家长 · 演示",role:"parent"},
          {key:"student_other",name:hk?"周予安 · 示範":"周予安 · 演示",role:"student"},
          {key:"teacher",name:hk?"許老師 · 示範":"许老师 · 演示",role:"teacher"}
        ].map(a=>({...a,id:randomUUID()}));
        const account=(key:string)=>accounts.find(a=>a.key===key)!;
        for(const a of accounts)await client.query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,$2,$3,$4,$5,true)",[a.id,config.region,`demo_${a.key}`,a.name,a.role]);
        const families=[
          {id:randomUUID(),name:hk?"林小禾的家庭":"林小禾的家庭",child:"林小禾",birth:"2013-04-12",grade:hk?"中二":"初二",guardian:hk?"母親":"母亲",staff:account("staff").id,parent:account("parent").id,student:account("student").id},
          {id:randomUUID(),name:"周予安的家庭",child:"周予安",birth:"2011-08-16",grade:hk?"中四":"高一",guardian:hk?"父親":"父亲",staff:account("staff_other").id,parent:account("parent_other").id,student:account("student_other").id}
        ];
        for(const f of families){
          await client.query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,assigned_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[f.id,config.region,f.name,f.child,f.birth,f.grade,f.guardian,f.staff]);
          for(const [uid,role] of [[f.parent,"parent"],[f.student,"student"],[account("teacher").id,"teacher"]])await client.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,$3)",[f.id,uid,role]);
          await client.query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,$4,'synthetic','SYNTHETIC-DEMO-ONLY',$5,$6)",[randomUUID(),f.id,f.parent,`${f.child}${hk?"家長":"家长"}`,noticeVersion,JSON.stringify(["assessment","parent_report","sensitive_data"])]);
        }
        const baseline={q1:3,q2:1,q3:2,q4:1,q5:3,q6:1,q7:2,q8:1,q9:0};
        const recent={q1:1,q2:2,q3:1,q4:2,q5:2,q6:2,q7:1,q8:2,q9:0};
        const calm={q1:0,q2:3,q3:1,q4:3,q5:1,q6:2,q7:0,q8:3,q9:0};
        for(const [fi,role,days,answers] of [[0,"student",45,baseline],[0,"student",20,recent],[0,"parent",25,recent],[1,"student",30,calm],[1,"parent",22,calm]] as const){
          const f=families[fi],respondent=role==="student"?f.student:f.parent,id=randomUUID(),submittedAt=new Date(Date.now()-days*86400000).toISOString();
          const snapshot:AssessmentSnapshot={scale,advice:{id:adviceId,version:"1.0.0",content:demoAdvice},template:{id:templateId,version:"1.0.0",content:demoTemplate},score:scoreAssessment(scale,answers,{age:ageAt(f.birth,new Date(submittedAt)),region:config.region,role:role as RespondentRole}),childName:f.child,grade:f.grade,submittedAt,aiConsented:false};
          await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,status,answers,snapshot,created_at,submitted_at,acknowledged_at) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$10,$10)",[id,f.id,config.region,respondent,role,scaleId,hk?"zh-HK":"zh-CN",JSON.stringify(answers),JSON.stringify(snapshot),submittedAt]);
          await client.query("INSERT INTO report_jobs(id,assessment_id) VALUES($1,$2)",[randomUUID(),id]);
        }
        for(const [fi,uid,role] of [[0,families[0].student,"student"],[0,families[0].parent,"parent"],[0,account("teacher").id,"teacher"],[1,families[1].student,"student"]] as const){
          await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale) VALUES($1,$2,$3,$4,$5,$6,$7)",[randomUUID(),families[fi].id,config.region,uid,role,scaleId,hk?"zh-HK":"zh-CN"]);
        }
        for(const [title,detail,status] of [
          [hk?"留一段彼此傾聽的時間":"留一段彼此倾听的时间",hk?"晚飯後先聽孩子分享一件想說的事，不急着提出建議。":"晚饭后先听孩子分享一件想说的事，不急着提出建议。","active"],
          [hk?"一起整理一週的休息安排":"一起整理一周的休息安排",hk?"保留一段由孩子自主選擇活動的時間。":"保留一段由孩子自主选择活动的时间。","active"],
          [hk?"確認孩子喜歡的交流方式":"确认孩子喜欢的交流方式",hk?"已一起討論，可選擇散步時聊天。":"已一起讨论，可以选择散步时聊天。","completed"]
        ])await client.query("INSERT INTO goals(id,family_id,title,detail,status,created_by) VALUES($1,$2,$3,$4,$5,$6)",[randomUUID(),families[0].id,title,detail,status,account("staff").id]);
        await client.query("INSERT INTO observations(id,family_id,body,created_by) VALUES($1,$2,$3,$4)",[randomUUID(),families[0].id,hk?"合成服務紀錄：家庭希望先從晚間交流方式開始調整。本紀錄僅供服務團隊使用。":"合成服务记录：家庭希望先从晚间交流方式开始调整。本记录仅供服务团队使用。",account("staff").id]);
        await client.query("COMMIT");console.log(`Synthetic demo seeded for ${config.region}: 2 families, 8 accounts, 5 report jobs. No real student data.`);
      }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
    }
  }
}finally{await closeDatabase();}
