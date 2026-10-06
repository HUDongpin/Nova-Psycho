import fs from "node:fs/promises";
import path from "node:path";
import { decryptFile } from "./backup-lib";

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
  fn: (dumpToRestore: string, reportsToRestore: string) => Promise<T>
): Promise<T> {
  if (!encrypted) return fn(databasePath, reportsPath);
  if (!backupKey) throw new Error("This backup is encrypted. Set NOVA_BACKUP_KEY to the key used when it was taken.");

  const tempDir = await fs.mkdtemp(path.join(backupDir, ".restore-"));
  try {
    const dumpToRestore = path.join(tempDir, "database.dump");
    const reportsToRestore = path.join(tempDir, "reports.tar.gz");
    await decryptFile(databasePath, dumpToRestore, backupKey);
    await decryptFile(reportsPath, reportsToRestore, backupKey);
    return await fn(dumpToRestore, reportsToRestore);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
