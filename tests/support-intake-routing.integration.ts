/** Synthetic database integration. Run with a dedicated work/qa-*.env via node --env-file. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../src/lib/config";
import { closeDatabase, query } from "../src/lib/db";
import { createAssessment } from "../src/lib/assessments";
import { joinFamily, joinWithCode } from "../src/lib/triad";
import { childScaleStaffNotes, parentScaleStaffNotes, teacherScaleStaffNotes, parentScaleSupportIntake, currentTriadScaleIds, legacyTriadScaleIds } from "../src/domain/triad-scales";
import { parseStoredScale } from "../src/domain/validation";
import type { Actor, RespondentRole, ScaleDefinition } from "../src/domain/types";

const config = getConfig(), address = new URL(config.databaseUrl);
assert.equal(config.mode, "demo");
assert.equal(config.ai.enabled, false);
assert.equal(config.triadAiEnabled, false);
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(address.hostname));
assert.match(address.pathname, /^\/nova_intake_(cn|hk)_[a-z0-9_]+$/);
const output = path.resolve(process.env.NOVA_ROUTING_OUTPUT_DIR ?? "work/support-intake-20261023");
const relative = path.relative(path.resolve("work"), output);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
const families: string[] = [], users: string[] = [], results: { name: string; passed: boolean }[] = [];
const locale = config.region === "CN" ? "zh-CN" : "zh-HK";
const old = { parent: parentScaleStaffNotes, student: childScaleStaffNotes, teacher: teacherScaleStaffNotes };
const nonce = randomBytes(5).toString("hex");
async function account(role: Actor["role"]): Promise<Actor> {
  const id = randomUUID(); users.push(id);
  await query("INSERT INTO users(id,region,username,name,role,demo) VALUES($1,$2,$3,$4,$5,true)", [id, config.region, `intake_route_${nonce}_${id}`, "Synthetic intake routing", role]);
  return { id, name: "Synthetic intake routing", role, region: config.region };
}
async function fixture() {
  const id = randomUUID(); families.push(id);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = `TOPE-${[...randomBytes(8)].map(value => alphabet[value % alphabet.length]).join("")}`;
  const members = { parent: await account("parent"), student: await account("student"), teacher: await account("teacher") };
  await query("INSERT INTO families(id,region,family_name,child_name,birth_date,grade,guardian_label,join_code) VALUES($1,$2,'Synthetic intake routing','Synthetic child','2014-06-01','初中','母亲',$3)", [id, config.region, code]);
  await query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'parent')", [id, members.parent.id]);
  await query("INSERT INTO consents(id,family_id,actor_id,guardian_name,method,reference,notice_version,scopes) VALUES($1,$2,$3,'Synthetic parent','synthetic','SYNTHETIC-INTAKE-ROUTING','synthetic',$4)", [randomUUID(), id, members.parent.id, JSON.stringify(["assessment", "sensitive_data", "parent_report"])]);
  return { id, code, members };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function round(family: Fixture) {
  const id = randomUUID();
  await query("INSERT INTO triad_rounds(id,family_id,region) VALUES($1,$2,$3)", [id, family.id, config.region]);
  return id;
}
async function seed(family: Fixture, role: RespondentRole, scale: ScaleDefinition, roundId: string | null, submitted = false) {
  const id = randomUUID();
  const submittedAt = submitted ? new Date(Date.now() - 100 * 86400000).toISOString() : null;
  await query("INSERT INTO assessments(id,family_id,region,respondent_id,respondent_role,scale_version_id,locale,triad_round_id,status,submitted_at,answers,snapshot,draft_answers) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [id, family.id, config.region, family.members[role].id, role, `${scale.id}@${scale.version}`, locale, roundId, submitted ? "queued" : "pending", submittedAt, submitted ? JSON.stringify({ fixture: "synthetic" }) : null, submitted ? JSON.stringify({ scale: parseStoredScale(scale), syntheticTest: true }) : null, JSON.stringify({ syntheticDraft: "preserved" })]);
  return id;
}
async function observe(id: string) { return (await query("SELECT scale_version_id,triad_round_id,answers,snapshot,draft_answers FROM assessments WHERE id=$1", [id]))[0]; }
async function check(name: string, run: () => Promise<void>) { await run(); results.push({ name, passed: true }); console.log(`PASS ${config.region} ${name}`); }
let passed = false;
try {
  assert.deepEqual(await query("SELECT region,mode FROM deployment_settings WHERE singleton=true"), [{ region: config.region, mode: "demo" }]);
  const admin = await account("admin");
  await check("legacy late joins, concurrent replay, mixed request rejection and frozen snapshot preservation", async () => {
    const family = await fixture(), roundId = await round(family);
    const parentId = await seed(family, "parent", old.parent, roundId, true), before = await observe(parentId);
    await query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'student')", [family.id, family.members.student.id]);
    await assert.rejects(createAssessment(admin, { familyId: family.id, respondentId: family.members.student.id, scaleVersionId: currentTriadScaleIds.student, locale }), { code: "TRIAD_GENERATION_MISMATCH" });
    const joins = await Promise.all([joinFamily(family.members.student, { code: family.code }, locale), joinFamily(family.members.student, { code: family.code }, locale)]);
    assert.equal(joins[0].assessmentId, joins[1].assessmentId);
    assert.equal((await observe(joins[0].assessmentId)).scale_version_id, legacyTriadScaleIds.student);
    const teacher = await joinWithCode({ code: family.code, role: "teacher", name: "Synthetic teacher", username: `intake_route_join_${nonce}`, password: randomBytes(24).toString("base64url") }, locale);
    users.push(teacher.userId);
    const teacherTask = await query("SELECT scale_version_id,triad_round_id FROM assessments WHERE family_id=$1 AND respondent_id=$2", [family.id, teacher.userId]);
    assert.deepEqual(teacherTask, [{ scale_version_id: legacyTriadScaleIds.teacher, triad_round_id: roundId }]);
    assert.deepEqual(await observe(parentId), before);
  });
  await check("unbound old pending task determines generation and is adopted without replacing draft", async () => {
    const family = await fixture(), parentId = await seed(family, "parent", old.parent, null);
    const before = await observe(parentId);
    const student = await joinFamily(family.members.student, { code: family.code }, locale);
    const studentRow = await observe(student.assessmentId);
    assert.equal(studentRow.scale_version_id, legacyTriadScaleIds.student);
    const adopted = await createAssessment(admin, { familyId: family.id, respondentId: family.members.parent.id, scaleVersionId: currentTriadScaleIds.parent, locale });
    assert.equal(adopted.id, parentId);
    assert.deepEqual(await observe(parentId), { ...before, triad_round_id: studentRow.triad_round_id });
  });
  await check("old pending adoption into an existing intake round is rejected atomically", async () => {
    const family = await fixture(), roundId = await round(family);
    await seed(family, "parent", parentScaleSupportIntake, roundId);
    await query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'student')", [family.id, family.members.student.id]);
    const studentId = await seed(family, "student", old.student, null), before = await observe(studentId);
    await assert.rejects(createAssessment(admin, { familyId: family.id, respondentId: family.members.student.id, scaleVersionId: currentTriadScaleIds.student, locale }), { code: "TRIAD_GENERATION_MISMATCH" });
    assert.deepEqual(await observe(studentId), before);
  });
  await check("completed legacy round opens a new intake round without modifying historic submissions", async () => {
    const family = await fixture(), roundId = await round(family), ids: string[] = [];
    for (const role of ["parent", "student", "teacher"] as const) ids.push(await seed(family, role, old[role], roundId, true));
    const before = await Promise.all(ids.map(observe));
    const created = await createAssessment(admin, { familyId: family.id, respondentId: family.members.parent.id, scaleVersionId: currentTriadScaleIds.parent, locale });
    const row = await observe(created.id);
    assert.equal(row.scale_version_id, currentTriadScaleIds.parent); assert.notEqual(row.triad_round_id, roundId);
    assert.deepEqual(await Promise.all(ids.map(observe)), before);
  });
  passed = true;
} finally {
  // Only random identifiers created by this run are removed, in the dedicated demo DB.
  if (families.length) await query("DELETE FROM families WHERE id=ANY($1::uuid[])", [families]);
  if (users.length) await query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await closeDatabase();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, `routing-${config.region.toLowerCase()}-${nonce}.json`), JSON.stringify({ passed, region: config.region, syntheticOnly: true, loopbackOnly: true, snapshotsPreserved: passed, cleanup: true, results }, null, 2), { flag: "wx", mode: 0o600 });
}
