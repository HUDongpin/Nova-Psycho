import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { decryptFile } from "./backup-lib";

type RestoreSignal = "SIGINT" | "SIGTERM";

export class RestoreInterruptionError extends Error {
  readonly exitCode: number;
  constructor(readonly signal: RestoreSignal, cause?: unknown) {
    super(`Restore interrupted by ${signal}.${cause instanceof Error ? ` ${cause.message}` : ""}`, cause === undefined ? undefined : { cause });
    this.name = "RestoreInterruptionError";
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

export class RestoreCommandTerminationError extends Error {
  constructor(command: string, cause?: unknown) {
    super(`Could not confirm that restore command ${command} and its subprocesses stopped. Private restore inputs must be retained.`, { cause });
    this.name = "RestoreCommandTerminationError";
  }
}

export async function withRestoreInterruption<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let interruption: RestoreInterruptionError | undefined;
  const interrupt = (signal: RestoreSignal) => {
    if (interruption) return;
    interruption = new RestoreInterruptionError(signal);
    controller.abort(interruption);
  };
  const onInterrupt = () => interrupt("SIGINT"), onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
  try {
    const result = await fn(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (interruption && error !== interruption) throw new RestoreInterruptionError(interruption.signal, error);
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
  }
}

export function runRestoreCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; maxBuffer?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  if (process.platform === "win32") throw new Error("Restore commands require a POSIX process environment.");
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1) throw new Error("Invalid restore command output limit");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const group = child.pid;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, closed = false, stopping = false, settled = false;
    let failure: unknown;
    let escalation: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined, polling: ReturnType<typeof setInterval> | undefined;
    const groupAlive = () => {
      if (!group) return false;
      try { process.kill(-group, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; return true; }
    };
    const signalGroup = (signal: "SIGTERM" | "SIGKILL") => {
      if (!group) return;
      try { process.kill(-group, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && failure === undefined) failure = error; }
    };
    const finish = () => {
      if (settled || !closed || groupAlive()) return;
      settled = true;
      clearTimeout(escalation); clearTimeout(deadline); clearInterval(polling);
      options.signal?.removeEventListener("abort", onAbort);
      const output = { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
      if (failure !== undefined) reject(failure); else resolve(output);
    };
    const stop = (reason: unknown) => {
      if (failure === undefined) failure = reason;
      if (!stopping) {
        stopping = true;
        signalGroup("SIGTERM");
        escalation = setTimeout(() => signalGroup("SIGKILL"), 1000);
        deadline = setTimeout(() => {
          if (settled) return;
          finish();
          if (settled) return;
          settled = true;
          clearTimeout(escalation); clearInterval(polling);
          options.signal?.removeEventListener("abort", onAbort);
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
          reject(new RestoreCommandTerminationError(command, failure));
        }, 4000);
        polling = setInterval(finish, 20);
      }
      finish();
    };
    const onAbort = () => stop(options.signal!.reason);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, maxBuffer - bytes);
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maxBuffer) stop(new Error(`Restore command ${command} exceeded its output limit`));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", error => stop(error));
    child.on("exit", (code, signal) => {
      if (!stopping && (code !== 0 || signal)) {
        const detail = Buffer.concat(stderr).toString().trim();
        failure = Object.assign(new Error(`Restore command ${command} failed (${signal ?? code}).${detail ? ` ${detail}` : ""}`), { code, signal });
      }
      if (groupAlive()) stop(failure ?? new Error(`Restore command ${command} left a subprocess running`));
    });
    child.on("close", (code, signal) => {
      closed = true;
      if (!stopping && (code !== 0 || signal)) {
        const detail = Buffer.concat(stderr).toString().trim();
        failure = Object.assign(new Error(`Restore command ${command} failed (${signal ?? code}).${detail ? ` ${detail}` : ""}`), { code, signal });
      }
      if (groupAlive()) stop(failure ?? new Error(`Restore command ${command} left a subprocess running`));
      else finish();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

// Decrypts an encrypted backup into a uniquely created directory under the backup
// folder, then runs the restore callback. Cleanup starts before the first decrypt
// so a failure on the second archive cannot leave the first plaintext dump behind.
// Only that unique directory is removed; sibling files in the backup folder stay.

export async function withDecryptedBackup<T>(
  backupDir: string,
  databasePath: string,
  reportsPath: string,
  encrypted: boolean,
  backupKey: Buffer | null,
  fn: (dumpToRestore: string, reportsToRestore: string) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  if (!encrypted) {
    const result = await fn(databasePath, reportsPath);
    signal?.throwIfAborted();
    return result;
  }
  if (!backupKey) throw new Error("This backup is encrypted. Set NOVA_BACKUP_KEY to the key used when it was taken.");

  const tempDir = await fs.mkdtemp(path.join(backupDir, ".restore-"));
  let preserveStaging = false;
  try {
    await fs.chmod(tempDir, 0o700);
    signal?.throwIfAborted();
    const dumpToRestore = path.join(tempDir, "database.dump");
    const reportsToRestore = path.join(tempDir, "reports.tar.gz");
    await decryptFile(databasePath, dumpToRestore, backupKey, signal);
    await fs.chmod(dumpToRestore, 0o600);
    await decryptFile(reportsPath, reportsToRestore, backupKey, signal);
    await fs.chmod(reportsToRestore, 0o600);
    signal?.throwIfAborted();
    const result = await fn(dumpToRestore, reportsToRestore);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (error instanceof RestoreCommandTerminationError) {
      preserveStaging = true;
      throw new Error(`Restore subprocess termination is unconfirmed; private staging retained at ${tempDir}.`, { cause: error });
    }
    throw error;
  } finally {
    if (!preserveStaging) await fs.rm(tempDir, { recursive: true, force: true });
  }
}
