import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Actor, Region, Role } from "../domain/types";
import { audit, hashPassword, hashToken } from "./auth";
import { getConfig } from "./config";
import { query, transaction } from "./db";
import { HttpError, requireRole, validateId } from "./http";

// Password recovery for accounts that already exist. Accounts here are created through
// one-time invitations, and there is no email infrastructure, so recovery works the same
// way: an administrator issues a single-use link and passes it on out of band. The
// alternative — a locked-out parent with no path back in — has no good outcome.

// Shorter than an invitation window, because this link resets a credential.
const RECOVERY_MINUTES = 60;

function recoveryToken(token: unknown): string {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(404, "链接无效或已过期。", "INVALID_RECOVERY");
  return token;
}

export async function createRecovery(actor: Actor, userId: string) {
  requireRole(actor.role, ["admin"]);
  validateId(userId);

  const users = await query<{ id: string; name: string; role: Role; disabled: boolean }>(
    "SELECT id,name,role,disabled FROM users WHERE id=$1 AND region=$2",
    [userId, actor.region]
  );
  const user = users[0];
  if (!user) throw new HttpError(404, "未找到该账号。", "NOT_FOUND");
  if (user.disabled) throw new HttpError(409, "该账号已停用，请先恢复账号。", "ACCOUNT_DISABLED");

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RECOVERY_MINUTES * 60000);

  await transaction(async client => {
    // Issuing a new link retires any earlier outstanding one for the same account.
    await client.query("UPDATE recovery_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [userId]);
    await client.query(
      "INSERT INTO recovery_tokens(token_hash,user_id,region,expires_at,created_by) VALUES($1,$2,$3,$4,$5)",
      [hashToken(token), userId, actor.region, expiresAt, actor.id]
    );
  });

  await audit(actor, "user.recovery_issued", userId);
  return { url: `${getConfig().publicUrl}/recover#token=${token}`, expiresAt: expiresAt.toISOString(), name: user.name };
}

export interface RecoveryInfo { name: string; username: string; role: Role; region: Region; expiresAt: string }

export async function recoveryInfo(rawToken: unknown): Promise<RecoveryInfo> {
  const rows = await query<RecoveryInfo>(
    `SELECT u.name,u.username,u.role,r.region,r.expires_at AS "expiresAt"
     FROM recovery_tokens r JOIN users u ON u.id=r.user_id
     WHERE r.token_hash=$1 AND r.expires_at>now() AND r.used_at IS NULL AND r.region=$2 AND NOT u.disabled`,
    [hashToken(recoveryToken(rawToken)), getConfig().region]
  );
  if (!rows[0]) throw new HttpError(404, "链接无效或已过期。", "INVALID_RECOVERY");
  return rows[0];
}

export async function acceptRecovery(input: unknown): Promise<{ ok: true }> {
  const d = z.object({ token: z.string(), password: z.string().min(12).max(256) }).strict().parse(input);
  const tokenHash = hashToken(recoveryToken(d.token));
  // Hash outside the transaction; scrypt is deliberately slow.
  const passwordHash = await hashPassword(d.password);

  await transaction(async client => {
    const candidate = await client.query("SELECT user_id FROM recovery_tokens WHERE token_hash=$1", [tokenHash]);
    if (!candidate.rows[0]) throw new HttpError(404, "链接无效或已过期。", "INVALID_RECOVERY");
    // Lock the token row so two simultaneous submissions cannot both succeed.
    const locked = await client.query(
      `SELECT r.user_id FROM recovery_tokens r JOIN users u ON u.id=r.user_id
       WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at>now() AND r.region=$2 AND NOT u.disabled
       FOR UPDATE OF r`,
      [tokenHash, getConfig().region]
    );
    const row = locked.rows[0];
    if (!row) throw new HttpError(404, "链接无效或已过期。", "INVALID_RECOVERY");

    await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [passwordHash, row.user_id]);
    await client.query("UPDATE recovery_tokens SET used_at=now() WHERE token_hash=$1", [tokenHash]);
    // Changing a password must end every existing session: a recovery is often
    // triggered precisely because someone else may have had access.
    await client.query("DELETE FROM sessions WHERE user_id=$1", [row.user_id]);
    await client.query("INSERT INTO audit_events(region,actor_id,action,entity_id) VALUES($1,$2,'user.recovery_completed',$3)", [getConfig().region, row.user_id, row.user_id]);
  });

  return { ok: true };
}
