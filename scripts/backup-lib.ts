import { createHash,createCipheriv,createDecipheriv,randomBytes } from "node:crypto";
import { createReadStream,createWriteStream } from "node:fs";
import { appendFile,open,stat,writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Shared helpers for the backup and restore scripts. Kept out of src/ because this
// is operational tooling that never runs inside the Next.js application.

export const run = promisify(execFile);

export const MAGIC = "NOVA1";
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
// Layout: MAGIC | nonce | ciphertext | auth tag. The tag trails the payload so the
// file can be written in one streaming pass; the tag is not known until the last block.
export const FRONT_BYTES = MAGIC.length + NONCE_BYTES;
export const HEADER_BYTES = FRONT_BYTES + TAG_BYTES;

export interface BackupManifest {
  formatVersion: 1;
  region: "CN" | "HK";
  mode: "demo" | "service";
  createdAt: string;
  encrypted: boolean;
  // A fingerprint lets restore detect a wrong key without ever storing the key.
  reportKeyFingerprint: string;
  database: { file: string; bytes: number; sha256: string; tables: Record<string, number> };
  reports: { file: string; bytes: number; sha256: string; fileCount: number };
  tools: { node: string; pgDump: string };
}

export function maskUrl(url: string): string {
  return url.replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:***@");
}

export function parseDbUrl(url: string) {
  const parsed = new URL(url);
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) throw new Error(`Not a PostgreSQL URL: ${maskUrl(url)}`);
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, "")
  };
}

// The password is passed through the environment, never as an argument, so it
// cannot be read out of the process table.
export function pgConnection(url: string): { args: string[]; env: NodeJS.ProcessEnv; label: string } {
  const c = parseDbUrl(url);
  return {
    args: ["--host", c.host, "--port", c.port, "--username", c.user, "--dbname", c.database],
    env: { ...process.env, PGPASSWORD: c.password },
    label: `${c.host}:${c.port}/${c.database}`
  };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export function fingerprintKey(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// Same framing as the report store: MAGIC | nonce | auth tag | ciphertext.
// The header and tag are written with explicit file operations rather than by
// interleaving writes around a pipeline, so their positions cannot depend on
// stream buffering order.
export async function encryptFile(source: string, destination: string, key: Buffer): Promise<void> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  await writeFile(destination, Buffer.concat([Buffer.from(MAGIC), nonce]), { mode: 0o600 });
  await pipeline(createReadStream(source), cipher, createWriteStream(destination, { flags: "a" }));
  await appendFile(destination, cipher.getAuthTag());
}

export async function decryptFile(source: string, destination: string, key: Buffer): Promise<void> {
  const { size } = await stat(source);
  if (size < HEADER_BYTES) throw new Error("Backup file is too short to be valid");
  const handle = await open(source, "r");
  const front = Buffer.alloc(FRONT_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(front, 0, FRONT_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (front.subarray(0, MAGIC.length).toString() !== MAGIC) throw new Error("Backup file is not in the expected encrypted format");
  const decipher = createDecipheriv("aes-256-gcm", key, front.subarray(MAGIC.length, FRONT_BYTES));
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(source, { start: FRONT_BYTES, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(destination, { mode: 0o600 }));
  } catch (error) {
    // A wrong key surfaces as an authentication failure, not as readable output.
    throw new Error(`Could not decrypt ${source}. The backup key does not match, or the file is damaged. (${(error as Error).message})`);
  }
}

export function backupKeyFromEnv(name = "NOVA_BACKUP_KEY"): Buffer | null {
  const raw = process.env[name];
  if (!raw) return null;
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error(`${name} must be 64 hex characters (32 bytes)`);
  return Buffer.from(raw, "hex");
}

export function requireReportKey(): Buffer {
  const raw = process.env.NOVA_REPORT_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error("NOVA_REPORT_KEY must be 64 hex characters (32 bytes)");
  return Buffer.from(raw, "hex");
}

export function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}
