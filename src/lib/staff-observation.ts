import { randomUUID } from "node:crypto";
import type { Actor, Locale } from "../domain/types";
import { familyFor, canManageFamilyReports } from "./access";
import { transaction } from "./db";
import { HttpError, requireRole, validateId } from "./http";
import { lockRegistrationActor, requireRegistrationConsent, resolveTriadAssignment } from "./triad";
import { getSyntheticTestFamilyMembers, isSyntheticTestActorForFamily } from "./synthetic-testing";
import { PARENT_FIRST_WORKFLOW } from "./staged-reports";

export async function startStaffObservation(actor:Actor,familyId:string,locale:Locale):Promise<{id:string}> {
  requireRole(actor.role,["staff"]);validateId(familyId);
  await familyFor(actor,familyId);
  return transaction(async client=>{
    const family=await client.query("SELECT id,region,assigned_to FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[familyId,actor.region]);
    await lockRegistrationActor(client,actor,"SHARE");
    if(!family.rows[0]||!canManageFamilyReports(actor,family.rows[0]))throw new HttpError(404,"未找到负责的家庭。","NOT_FOUND");
    await requireRegistrationConsent(client,familyId);
    if(await getSyntheticTestFamilyMembers(familyId,actor.region,client)&&!await isSyntheticTestActorForFamily(actor,familyId,client))throw new HttpError(403,"此合成测试家庭仅允许明确配置的负责老师测试账号填写现场观察。","SYNTHETIC_TEST_SCOPE_REQUIRED");
    const rounds=await client.query("SELECT id,report_workflow FROM triad_rounds WHERE family_id=$1 AND region=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[familyId,actor.region]);
    const round=rounds.rows[0];
    if(round?.report_workflow!==PARENT_FIRST_WORKFLOW)throw new HttpError(409,"该轮次使用原有问卷流程，请保留其原版本。","LEGACY_ROUND");
    const existing=await client.query("SELECT id,status,respondent_id,respondent_context FROM assessments WHERE triad_round_id=$1 AND respondent_role='teacher' FOR UPDATE",[round.id]);
    if(existing.rows[0]){
      const task=existing.rows[0];
      if(task.respondent_context!=="tope_staff")throw new HttpError(409,"本轮已有其他来源的老师问卷。","ROLE_TAKEN");
      if(task.status!=="pending")throw new HttpError(409,"本轮现场观察已提交，可在跟进记录中补充。","OBSERVATION_SUBMITTED");
      if(task.respondent_id!==actor.id){
        // Preserve the draft during reassignment; the final submission records its responsible author.
        await client.query("UPDATE assessments SET respondent_id=$1,draft_revision=draft_revision+1,acknowledged_at=NULL WHERE id=$2 AND status='pending'",[actor.id,task.id]);
        await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'observation.reassigned',$3)",[actor.region,actor.id,task.id]);
      }
      return {id:String(task.id)};
    }
    const assignment=await resolveTriadAssignment(client,familyId,"teacher",{staffObservation:true});
    if(assignment.roundId!==round.id)throw new HttpError(409,"本轮已完成，请重新载入家庭档案。","ROUND_COMPLETED");
    const scale=await client.query("SELECT id FROM scales WHERE id=$1 AND status='active'",[assignment.scaleVersionId]);
    if(!scale.rows[0])throw new HttpError(409,"现场观察问卷尚未准备好。","SCALE_NOT_FOUND");
    const id=randomUUID();
    await client.query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id,respondent_context) VALUES($1,$2,$3,$4,'teacher',$5,$6,$7,'tope_staff')",[id,familyId,actor.region,actor.id,assignment.scaleVersionId,locale,round.id]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'observation.started',$3)",[actor.region,actor.id,id]);
    return {id};
  });
}
