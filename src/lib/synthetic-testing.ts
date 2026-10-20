import type { PoolClient } from "pg";
import type { Actor, Region, RespondentRole } from "../domain/types";
import { getTestAccountUsernames, hasTestAccountLogin } from "./auth-provider";
import { getConfig } from "./config";
import { query } from "./db";

export interface SyntheticTestMember { id: string; role: RespondentRole }
interface MemberRow {
  id: string; role: RespondentRole; user_role: string; username: string | null;
  region: Region; family_region: Region; disabled: boolean; demo: boolean; has_password: boolean;
}

function configuredFamilies(): string[] {
  const ids = (process.env.NOVA_SYNTHETIC_TEST_FAMILY_IDS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    throw new Error("NOVA_SYNTHETIC_TEST_FAMILY_IDS must contain exact family UUIDs");
  }
  return [...new Set(ids)];
}

// A deployment-owned family scope is separate from login eligibility. An ordinary
// member, disabled account or region mismatch invalidates the entire test family.
export async function getSyntheticTestFamilyMembers(familyId: string, region: Region, client?: PoolClient): Promise<SyntheticTestMember[] | null> {
  const config = getConfig();
  if (config.mode !== "service" || config.region !== region || !hasTestAccountLogin() || !configuredFamilies().includes(familyId.toLowerCase())) return null;
  const sql = `SELECT u.id,m.role,u.role AS user_role,u.username,u.region,f.region AS family_region,
      u.disabled,u.demo,(u.password_hash IS NOT NULL) AS has_password
    FROM families f JOIN memberships m ON m.family_id=f.id JOIN users u ON u.id=m.user_id
    WHERE f.id=$1 ORDER BY u.id${client ? " FOR SHARE OF f,m,u" : ""}`;
  const rows = client ? (await client.query<MemberRow>(sql, [familyId])).rows : await query<MemberRow>(sql, [familyId]);
  const usernames = new Set(getTestAccountUsernames());
  if (rows.length !== 3 || new Set(rows.map(row => row.id)).size !== 3 ||
    !(["parent", "student", "teacher"] as const).every(role => rows.filter(row => row.role === role).length === 1) ||
    rows.some(row => row.user_role !== row.role || row.region !== region || row.family_region !== region ||
      row.disabled !== false || row.demo !== false || row.has_password !== true || !row.username || !usernames.has(row.username))) return null;
  return rows.map(({ id, role }) => ({ id, role }));
}

export async function isSyntheticTestFamily(familyId: string, region: Region, client?: PoolClient): Promise<boolean> {
  return (await getSyntheticTestFamilyMembers(familyId, region, client)) !== null;
}

export async function isSyntheticTestActorForFamily(actor: Actor, familyId: string, client?: PoolClient): Promise<boolean> {
  if (actor.sessionMethod !== "test") return false;
  const members = await getSyntheticTestFamilyMembers(familyId, actor.region, client);
  return members?.some(member => member.id === actor.id && member.role === actor.role) === true;
}
