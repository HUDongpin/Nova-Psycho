import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decryptFile, encryptFile } from "../scripts/backup-lib";
import { RestoreCommandTerminationError, runRestoreCommand, withDecryptedBackup, withRestoreInterruption } from "../scripts/restore-lib";

const roots: string[] = [];
const key = Buffer.from("73".repeat(32), "hex");
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "nova-restore-interruption-")); roots.push(root);
  for (const name of ["database", "reports"]) {
    await fs.writeFile(path.join(root, `${name}.src`), `synthetic ${name}`);
    await encryptFile(path.join(root, `${name}.src`), path.join(root, `${name}.enc`), key);
  }
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor<T>(read: () => Promise<T | null>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await read(); if (result !== null) return result; await delay(5); }
  throw new Error("Synthetic restore barrier timed out");
}
async function readJson(file: string) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}

describe("restore command lifecycle", () => {
  it("captures a successful command and restores only its signal handlers", async () => {
    const counts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const output = await withRestoreInterruption(signal => runRestoreCommand(process.execPath, ["-e", "console.log('synthetic output');console.error('synthetic warning')"], { signal }));
    expect(output).toEqual({ stdout: "synthetic output\n", stderr: "synthetic warning\n" });
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(counts);
  });
  it("preserves ordinary callback failure and removes handlers", async () => {
    const failure = new Error("Synthetic callback failure"), counts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await expect(withRestoreInterruption(async () => { throw failure; })).rejects.toBe(failure);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(counts);
  });
  it("rejects a missing command without signaling an undefined process group", async () => {
    await expect(runRestoreCommand("/nonexistent/nova-synthetic-restore-command", [])).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not start commands or create staging after cancellation", async () => {
    const root = await fixture(), controller = new AbortController(), reason = new Error("Already stopped"); controller.abort(reason);
    expect(() => runRestoreCommand(process.execPath, ["-e", "process.exit(0)"], { signal: controller.signal })).toThrow(reason);
    await expect(withDecryptedBackup(root, path.join(root, "database.enc"), path.join(root, "reports.enc"), true, key, async () => { throw Error("Must not run"); }, controller.signal)).rejects.toBe(reason);
    expect((await fs.readdir(root)).some(name => name.startsWith(".restore-"))).toBe(false);
  });
  it("stops and reaps an output-overflow command before rejecting", async () => {
    const root = await fixture(), pidFile = path.join(root, "overflow.pid");
    await expect(runRestoreCommand(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)`], { maxBuffer: 32 })).rejects.toThrow("output limit");
    expect(alive(Number(await fs.readFile(pidFile, "utf8")))).toBe(false);
  });
  it("stops a descendant holding inherited output after its leader exits", async () => {
    const root = await fixture(), pidFile = path.join(root, "descendant.pid"), ready = path.join(root, "ready");
    const descendant = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
    const leader = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});const t=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(ready)})){clearInterval(t);process.exit(0)}},5)`;
    await expect(runRestoreCommand(process.execPath, ["-e", leader])).rejects.toThrow("left a subprocess running");
    expect(alive(Number(await fs.readFile(pidFile, "utf8")))).toBe(false);
  }, 10000);
});

describe("catchable interruption and private staging", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("waits for a %s command to stop before removing plaintext", async signal => {
    await interruptedRestore(signal, false);
  }, 10000);
  it("kills a TERM-resistant descendant after its leader exits, before cleanup", async () => {
    await interruptedRestore("SIGTERM", true);
  }, 10000);
  it("retains only owned private staging when subprocess termination is unconfirmed", async () => {
    const root = await fixture(); let stage = "";
    await fs.writeFile(path.join(root, "keep.txt"), "preserve");
    await expect(withDecryptedBackup(root, path.join(root, "database.enc"), path.join(root, "reports.enc"), true, key, async dump => {
      stage = path.dirname(dump); throw new RestoreCommandTerminationError("synthetic command");
    })).rejects.toThrow(`private staging retained at ${stage}`);
    expect((await fs.stat(stage)).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(path.join(stage, "database.dump"), "utf8")).toBe("synthetic database");
    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("preserve");
  });
  it("aborts an active decrypt pipeline and removes its partial plaintext", async () => {
    const root = await fixture(), source = path.join(root, "large.src"), encrypted = path.join(root, "large.enc"), destination = path.join(root, "partial.dump");
    await fs.writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0x53)); await encryptFile(source, encrypted, key);
    const controller = new AbortController(), reason = new Error("Synthetic stream interruption");
    const pending = decryptFile(encrypted, destination, key, controller.signal).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    await waitFor(async () => { try { return (await fs.stat(destination)).size > 0 ? true : null; } catch { return null; } });
    controller.abort(reason);
    expect(await pending).toEqual({ ok: false, error: reason });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function interruptedRestore(signal: "SIGINT" | "SIGTERM", descendant: boolean) {
  const root = await fixture(), ready = path.join(root, "ready.json"), shutdown = path.join(root, "shutdown.json"), beforeCleanup = path.join(root, "before-cleanup.json");
  const previous = path.join(root, ".restore-previous"); await fs.mkdir(previous); await fs.writeFile(path.join(previous, "keep"), "preserve");
  await fs.symlink(previous, path.join(root, ".restore-sibling-link"));
  const grandReady = path.join(root, "grand-ready");
  const grand = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(grandReady)},'ready');setInterval(()=>{},1000)`;
  const command = descendant
    ? `const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(grandReady)})){clearInterval(t);fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,childPid:child.pid}));}},5);setInterval(()=>{},1000);`
    : `const fs=require('fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(shutdown)},JSON.stringify({inputExists:fs.existsSync(process.argv[1])}));setTimeout(()=>process.exit(0),50)});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
  const program = `
    import fs from 'node:fs/promises';
    import {withRestoreInterruption,withDecryptedBackup,runRestoreCommand,RestoreInterruptionError} from ${JSON.stringify(new URL("../scripts/restore-lib.ts", import.meta.url).href)};
    const counts=[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')];
    try {
      await withRestoreInterruption(signal=>withDecryptedBackup(${JSON.stringify(root)},${JSON.stringify(path.join(root, "database.enc"))},${JSON.stringify(path.join(root, "reports.enc"))},true,Buffer.from(${JSON.stringify(key.toString("hex"))},'hex'),async dump=>{
        try { await runRestoreCommand(process.execPath,['-e',${JSON.stringify(command)},dump],{signal}); }
        finally {
          const pids=JSON.parse(await fs.readFile(${JSON.stringify(ready)},'utf8'));
          const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
          await fs.writeFile(${JSON.stringify(beforeCleanup)},JSON.stringify({inputExists:!!(await fs.stat(dump)),leaderAlive:alive(pids.pid),descendantAlive:pids.childPid?alive(pids.childPid):false}));
        }
      },signal));
      console.log('UNEXPECTED SUCCESS');
    } catch(error) {
      process.exitCode=error instanceof RestoreInterruptionError?error.exitCode:1;
      console.log(JSON.stringify({exitCode:process.exitCode,handlersRestored:counts.every((n,i)=>n===process.listenerCount(i?'SIGTERM':'SIGINT'))}));
    }
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit"); let stdout = "", stderr = "", ownedGroup: number | undefined;
  child.stdout.on("data", data => { stdout += data.toString(); }); child.stderr.on("data", data => { stderr += data.toString(); });
  try {
    const info = await waitFor(() => readJson(ready)); ownedGroup = info.pid;
    child.kill(signal);
    const result = await Promise.race([exited, delay(6000).then(() => { throw Error(`Restore child did not exit: ${stderr}`); })]);
    expect(result).toEqual([signal === "SIGINT" ? 130 : 143, null]);
    expect(stdout).not.toContain("UNEXPECTED SUCCESS"); expect(stdout).toContain('"handlersRestored":true');
    expect(await readJson(beforeCleanup)).toEqual({ inputExists: true, leaderAlive: false, descendantAlive: false });
    if (!descendant) expect(await readJson(shutdown)).toEqual({ inputExists: true });
    expect((await fs.readdir(root)).filter(name => name.startsWith(".restore-")).sort()).toEqual([".restore-previous", ".restore-sibling-link"]);
    expect(await fs.readFile(path.join(previous, "keep"), "utf8")).toBe("preserve");
    expect(await fs.readlink(path.join(root, ".restore-sibling-link"))).toBe(previous);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (ownedGroup) { try { process.kill(-ownedGroup, "SIGKILL"); } catch {} }
    await exited;
  }
}
