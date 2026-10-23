import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Actor } from "../domain/types";
import { canManageFamilyReports, familyFor } from "./access";
import { ACTIVE_CONSENT_ROWS_SQL, PARENT_REPORT_SCOPE, hasGranted } from "./consent";
import { getConfig } from "./config";
import { query, transaction } from "./db";
import { HttpError, requireRole, validateId } from "./http";
import { audit } from "./auth";

export const PARENT_FIRST_WORKFLOW = "parent_first_v1";

// Caller holds the family lock. Each job owns a frozen source set and an ordered
// revision number; worker completion order never determines the latest report.
export async function queueStagedReport(client: PoolClient, familyId: string, roundId: string, sources: {id:string;respondent_role:string}[]): Promise<string|null> {
  const parent = sources.find(source => source.respondent_role === "parent");
  if (!parent) return null;
  if (sources.length > 3 || new Set(sources.map(source => source.respondent_role)).size !== sources.length) throw new Error("Invalid staged report sources");
  const consent = await client.query(ACTIVE_CONSENT_ROWS_SQL, [familyId]);
  if (!hasGranted(consent.rows, [PARENT_REPORT_SCOPE])) return null;
  const sourceIds = sources.map(source => source.id).sort();
  const version = await client.query("SELECT COALESCE(MAX(report_version),0)+1 AS version FROM report_jobs WHERE triad_round_id=$1", [roundId]);
  await client.query("INSERT INTO report_jobs(id,assessment_id,source_assessment_ids,triad_round_id,report_version,source_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(triad_round_id,source_key) WHERE report_version IS NOT NULL DO NOTHING", [randomUUID(), parent.id, sourceIds, roundId, Number(version.rows[0].version), sourceIds.join(":")]);
  return parent.id;
}

export async function retryStagedReport(actor:Actor,jobId:string):Promise<{id:string;status:"queued"}> {
  requireRole(actor.role,["admin","staff"]);validateId(jobId);
  const found=await query("SELECT a.family_id FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE j.id=$1 AND a.region=$2 AND j.report_version IS NOT NULL",[jobId,actor.region]);
  if(!found[0])throw new HttpError(404,"未找到报告任务。","NOT_FOUND");
  await familyFor(actor,found[0].family_id);
  const retried=await transaction(async client=>{
    const locked=await client.query("SELECT id,region,assigned_to FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[found[0].family_id,actor.region]);
    if(!locked.rows[0]||!canManageFamilyReports(actor,locked.rows[0]))throw new HttpError(404,"未找到该家庭或没有访问权限。","NOT_FOUND");
    const account=await client.query("SELECT role,disabled,region FROM users WHERE id=$1 FOR SHARE",[actor.id]);
    if(account.rows[0]?.disabled||account.rows[0]?.role!==actor.role||account.rows[0]?.region!==getConfig().region)throw new HttpError(403,"账号已变更，请重新登录。","ACCOUNT_REVOKED");
    const jobs=await client.query("SELECT j.* FROM report_jobs j JOIN assessments a ON a.id=j.assessment_id WHERE j.id=$1 AND a.family_id=$2 AND a.region=$3 AND j.report_version IS NOT NULL FOR UPDATE OF j",[jobId,found[0].family_id,actor.region]);
    const job=jobs.rows[0];
    if(!job)throw new HttpError(404,"未找到报告任务。","NOT_FOUND");
    const consent=await client.query(ACTIVE_CONSENT_ROWS_SQL,[found[0].family_id]);
    if(!hasGranted(consent.rows,[PARENT_REPORT_SCOPE]))throw new HttpError(409,"请先取得家长报告授权。","GUARDIAN_CONSENT_REQUIRED");
    if(job.state==="ready"||job.state==="running")return false;
    if(job.state!=="failed")throw new HttpError(409,"仅可重试生成失败的报告。","REPORT_NOT_FAILED");
    await client.query("UPDATE report_jobs SET state='ready',attempts=0,lease_until=NULL,claim_token=NULL,last_error_code=NULL,available_at=now() WHERE id=$1",[jobId]);
    return true;
  });
  if(retried)await audit(actor,"report.retry_queued",jobId);
  return {id:jobId,status:"queued"};
}
