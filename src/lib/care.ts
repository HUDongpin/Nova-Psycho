import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "../domain/types";
import { familyFor } from "./access";
import { audit } from "./auth";
import { query } from "./db";
import { HttpError,requireRole,validateId } from "./http";
export async function addGoal(actor:Actor,input:unknown){
  requireRole(actor.role,["admin","staff","parent"]);const d=z.object({familyId:z.string().uuid(),title:z.string().trim().min(1).max(150),detail:z.string().trim().max(2000)}).strict().parse(input);await familyFor(actor,d.familyId);
  const id=randomUUID();await query("INSERT INTO goals(id,family_id,title,detail,created_by) VALUES($1,$2,$3,$4,$5)",[id,d.familyId,d.title,d.detail,actor.id]);await audit(actor,"goal.created",id);return {id};
}
export async function updateGoal(actor:Actor,id:string,input:unknown){
  requireRole(actor.role,["admin","staff","parent"]);validateId(id);const d=z.object({status:z.enum(["active","completed"])}).strict().parse(input);
  const rows=await query("SELECT family_id FROM goals WHERE id=$1",[id]);if(!rows[0])throw new HttpError(404,"未找到行动目标。","NOT_FOUND");await familyFor(actor,rows[0].family_id);
  await query("UPDATE goals SET status=$1 WHERE id=$2",[d.status,id]);await audit(actor,"goal.status_changed",id);return {ok:true};
}
export async function addObservation(actor:Actor,input:unknown){
  requireRole(actor.role,["admin","staff"]);const d=z.object({familyId:z.string().uuid(),body:z.string().trim().min(1).max(4000)}).strict().parse(input);await familyFor(actor,d.familyId);
  const id=randomUUID();await query("INSERT INTO observations(id,family_id,body,created_by) VALUES($1,$2,$3,$4)",[id,d.familyId,d.body,actor.id]);await audit(actor,"observation.created",id);return {id};
}
