import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { OBSERVATION_MAX_LENGTH } from "../domain/care-limits";
import type { Actor } from "../domain/types";
import { familyFor } from "./access";
import { query, transaction } from "./db";
import { HttpError,requireRole,validateId } from "./http";
import { lockRegistrationActor } from "./triad";

async function lockCareFamily(client:PoolClient,actor:Actor,id:string){
  // Assignment and deletion use this same lock. Check scope after any wait,
  // preserving staff access to regional safety-alert families for follow-up care.
  const family=await client.query("SELECT id FROM families WHERE id=$1 AND region=$2 FOR UPDATE",[id,actor.region]);
  if(!family.rows[0])throw new HttpError(404,"未找到该家庭或没有访问权限。","NOT_FOUND");
  const current=await lockRegistrationActor(client,actor,"SHARE");
  await familyFor(current,id,client);
}
export async function addGoal(actor:Actor,input:unknown){
  requireRole(actor.role,["admin","staff","parent"]);const d=z.object({familyId:z.string().uuid(),title:z.string().trim().min(1).max(150),detail:z.string().trim().max(2000)}).strict().parse(input);
  return transaction(async client=>{
    await lockCareFamily(client,actor,d.familyId);
    const id=randomUUID();await client.query("INSERT INTO goals(id,family_id,title,detail,created_by) VALUES($1,$2,$3,$4,$5)",[id,d.familyId,d.title,d.detail,actor.id]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'goal.created',$3)",[actor.region,actor.id,id]);return {id};
  });
}
export async function updateGoal(actor:Actor,id:string,input:unknown){
  requireRole(actor.role,["admin","staff","parent"]);validateId(id);const d=z.object({status:z.enum(["active","completed"])}).strict().parse(input);
  const rows=await query("SELECT family_id FROM goals WHERE id=$1",[id]);if(!rows[0])throw new HttpError(404,"未找到行动目标。","NOT_FOUND");
  return transaction(async client=>{
    await lockCareFamily(client,actor,rows[0].family_id);
    await client.query("UPDATE goals SET status=$1 WHERE id=$2",[d.status,id]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'goal.status_changed',$3)",[actor.region,actor.id,id]);return {ok:true};
  });
}
export async function addObservation(actor:Actor,input:unknown){
  requireRole(actor.role,["admin","staff"]);const d=z.object({familyId:z.string().uuid(),body:z.string().trim().min(1).max(OBSERVATION_MAX_LENGTH)}).strict().parse(input);
  return transaction(async client=>{
    await lockCareFamily(client,actor,d.familyId);
    const id=randomUUID();await client.query("INSERT INTO observations(id,family_id,body,created_by) VALUES($1,$2,$3,$4)",[id,d.familyId,d.body,actor.id]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'observation.created',$3)",[actor.region,actor.id,id]);return {id};
  });
}
