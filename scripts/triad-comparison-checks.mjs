#!/usr/bin/env node
/** Fresh local PostgreSQL, HTTP, worker and browser regression; no existing env is loaded. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
const output = path.resolve(process.env.NOVA_TRIAD_CHECKS_OUTPUT_DIR ?? path.join("work", `triad-checks-${runId}`));
const cliTemp = path.relative(root, path.join(output, "tmp"));
const pgOverride = process.env.NOVA_TRIAD_PG_BIN;
const chromeOverride = process.env.NOVA_CHROMIUM_EXECUTABLE;
const clean = () => ({ ...Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TZ"].filter(key => process.env[key]).map(key => [key, process.env[key]])), ...(claimed ? { TMPDIR: path.join(output, "tmp") } : {}) });
const processes = [], databases = [], checks = [];
const owner = "nova-triad-selection-v1";
let interrupted = false, cleanupPromise, claimed = false, passed = false;
let pgBin = "", chrome = "";
const inside = (parent, child) => { const relative = path.relative(parent, child); return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const privateJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
function commandResult(command, args) {
  try { return execFileSync(command, args, { env: clean(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }).trim(); }
  catch { return null; }
}
function postgresBin() {
  const candidates = pgOverride ? [path.resolve(pgOverride)] : [commandResult("pg_config", ["--bindir"]), ...(process.env.PATH ?? "").split(path.delimiter)];
  const found = candidates.find(dir => dir && ["initdb", "pg_ctl", "postgres"].every(name => fs.existsSync(path.join(dir, name))));
  assert.ok(found, "Native PostgreSQL tools required: set NOVA_TRIAD_PG_BIN to their bin directory");
  return found;
}
function chromiumPath() {
  if (chromeOverride) { const file = path.resolve(chromeOverride); assert.ok(fs.existsSync(file), "Configured Chromium executable must exist"); return file; }
  const require = createRequire(path.join(root, "package.json"));
  const candidates = [require("playwright").chromium.executablePath(), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ...["chromium", "chromium-browser", "google-chrome"].flatMap(name => (process.env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, name)))];
  const found = candidates.find(file => fs.existsSync(file));
  assert.ok(found, "Install Playwright Chromium or set NOVA_CHROMIUM_EXECUTABLE to a local Chrome/Chromium executable");
  return found;
}
const allocatedPorts = new Set();
async function unusedPort() {
  while (true) {
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(error => error ? reject(error) : resolve(address.port)); }); });
    if (!allocatedPorts.has(port)) { allocatedPorts.add(port); return port; }
  }
}
function start(command, args, { cwd = root, env = clean(), label, log }) {
  assert.ok(!interrupted, "Run interrupted");
  const fd = fs.openSync(log, "a", 0o600);
  let child;
  try { child = spawn(command, args, { cwd, env, stdio: ["ignore", fd, fd], detached: true }); }
  finally { fs.closeSync(fd); }
  const record = { child, label, log, finished: false, outcome: null, done: null };
  record.done = new Promise(resolve => {
    child.once("error", () => { record.finished = true; record.outcome = { code: null, signal: "spawn-error" }; resolve(record.outcome); });
    child.once("exit", (code, signal) => { record.finished = true; record.outcome = { code, signal }; resolve(record.outcome); });
  });
  processes.push(record);
  return record;
}
async function command(command, args, options) {
  const started = Date.now(), record = start(command, args, options);
  const result = await record.done;
  checks.push({ name: options.label, passed: result.code === 0 && !result.signal, durationMs: Date.now() - started });
  assert.ok(result.code === 0 && !result.signal, `${options.label} failed; inspect its private log under the output directory`);
  console.log(`PASS ${options.label}`);
}
async function stopProcess(record) {
  if (record.finished) return;
  try { process.kill(-record.child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await Promise.race([record.done, pause(5000)]);
  if (!record.finished) { try { process.kill(-record.child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } await record.done; }
}
async function cleanup() {
  cleanupPromise ??= (async () => {
    const errors = [];
    for (const record of [...processes].reverse()) try { await stopProcess(record); } catch { errors.push(`${record.label} cleanup failed`); }
    for (const db of [...databases].reverse()) {
      const pidFile = path.join(db.data, "postmaster.pid");
      if (!fs.existsSync(pidFile)) continue;
      try {
        const lines = fs.readFileSync(pidFile, "utf8").split("\n");
        assert.equal(fs.realpathSync(lines[1]), fs.realpathSync(db.data), "Refusing to stop an unowned database");
        execFileSync(path.join(pgBin, "pg_ctl"), ["-D", db.data, "-w", "-t", "30", "-m", "fast", "stop"], { env: clean(), stdio: "ignore", timeout: 35000 });
        assert.ok(!fs.existsSync(pidFile), "Owned database must stop");
      } catch { errors.push(`${db.region} database cleanup failed`); }
    }
    if (claimed) privateJson(path.join(output, "cleanup.json"), { stopped: !errors.length, retainedEvidence: true, errors });
    return errors;
  })();
  return cleanupPromise;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; process.exitCode = 130; void cleanup(); });
function snapshot(app) {
  fs.mkdirSync(app, { recursive: true, mode: 0o700 });
  for (const part of ["src", "scripts", "public", "assets", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "next-env.d.ts"]) {
    const source = path.join(root, part);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(app, part), { recursive: true, filter: file => path.basename(file) !== ".DS_Store" });
  }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(app, "node_modules"), "dir");
  const hashes = {};
  function visit(dir, relative = "") { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { if (item.name === "node_modules") continue; const name = path.join(relative, item.name), file = path.join(dir, item.name); if (item.isDirectory()) visit(file, name); else hashes[name] = createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } }
  visit(app);
  privateJson(path.join(app, "source-hashes.json"), { head: commandResult("git", ["rev-parse", "HEAD"]), hashes });
}
const runtimeEnv = spec => ({ ...clean(), ...spec.config, TMPDIR: path.join(spec.dir, "tmp"), NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `--import=${JSON.stringify(path.join(root, "tests/helpers/triad-clock.mjs"))}` });
async function createDatabase(connectionString, name) {
  assert.match(name, /^[a-z][a-z0-9_]+$/);
  const { Client } = createRequire(path.join(root, "package.json"))("pg"), address = new URL(connectionString);
  address.pathname = "/postgres";
  const client = new Client({ connectionString: address.href, connectionTimeoutMillis: 5000 });
  try { await client.connect(); await client.query(`CREATE DATABASE ${name}`); } finally { await client.end(); }
}
async function prepare(region) {
  const dir = path.join(output, region.toLowerCase()), data = path.join(dir, "postgres"), app = path.join(dir, "app");
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const part of ["logs", "reports", "tmp"]) fs.mkdirSync(path.join(dir, part), { mode: 0o700 });
  const webPort = await unusedPort(), dbPort = await unusedPort(), name = `nova_triad_comparison_${region.toLowerCase()}`;
  const password = randomBytes(24).toString("hex"), clockFile = path.join(dir, "clock-offset-ms.txt");
  const config = {
    NOVA_MODE: "demo", NOVA_REGION: region, NOVA_DATA_REGION: region, NOVA_AUTH_PROVIDER: "local",
    DATABASE_URL: `postgresql://${name}:${password}@127.0.0.1:${dbPort}/${name}`,
    NOVA_PUBLIC_URL: `http://127.0.0.1:${webPort}`, NOVA_DEMO_SIBLING_URL: "",
    NOVA_REPORT_STORAGE: "filesystem", NOVA_REPORT_DIR: path.join(dir, "reports"), NOVA_REPORT_KEY: randomBytes(32).toString("hex"),
    NOVA_WORKER_MODE: "continuous", NOVA_AI_ENABLED: "false", NOVA_AI_API_KEY: "", NOVA_AI_BASE_URL: "", NOVA_AI_MODEL: "",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "", CLERK_SECRET_KEY: "", NOVA_TEST_ACCOUNT_USERNAMES: "", VERCEL: "0",
    NOVA_DIST_DIR: ".next-owned", NOVA_TEST_CLOCK_FILE: clockFile, NOVA_CHROMIUM_EXECUTABLE: chrome
  };
  const spec = { region, dir, data, app, webPort, dbPort, config, configFile: path.join(dir, "private-config.json") };
  databases.push(spec);
  privateJson(spec.configFile, config);
  fs.writeFileSync(clockFile, String(-91 * 86400000), { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(dir, "postgres-password.txt"), password + "\n", { flag: "wx", mode: 0o600 });
  snapshot(app);
  await command(path.join(pgBin, "initdb"), ["-D", data, "-U", name, "--encoding=UTF8", "--locale=C", "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", `--pwfile=${path.join(dir, "postgres-password.txt")}`], { label: `${region} initialize owned PostgreSQL`, log: path.join(dir, "logs/initdb.log") });
  fs.appendFileSync(path.join(data, "postgresql.conf"), `\nlisten_addresses = '127.0.0.1'\nport = ${dbPort}\nunix_socket_directories = ''\nmax_connections = 40\nshared_buffers = '64MB'\nlog_statement = 'none'\nlog_min_error_statement = 'panic'\n`);
  await command(path.join(pgBin, "pg_ctl"), ["-D", data, "-l", path.join(dir, "logs/postgres.log"), "-w", "-t", "30", "start"], { label: `${region} start owned PostgreSQL`, log: path.join(dir, "logs/pg-start.log") });
  await createDatabase(config.DATABASE_URL, name);
  await command(process.execPath, ["--import", "tsx", "scripts/setup.ts"], { cwd: app, env: runtimeEnv(spec), label: `${region} synthetic setup`, log: path.join(dir, "logs/setup.log") });
  return spec;
}
async function ready(spec, web) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    assert.ok(!web.finished, `${spec.region} local web process exited`);
    try { const response = await fetch(`${spec.config.NOVA_PUBLIC_URL}/api/health`, { signal: AbortSignal.timeout(5000), redirect: "error" }); if (response.ok) { const value = await response.json(); if (value.ok && value.region === spec.region && value.mode === "demo") return; } } catch { /* Startup compilation may not yet serve requests. */ }
    await pause(250);
  }
  assert.fail(`${spec.region} local health check timed out`);
}
async function selection(cn) {
  const dir = path.join(output, "selection"); fs.mkdirSync(dir, { mode: 0o700 });
  for (const part of ["reports", "tmp", "evidence"]) fs.mkdirSync(path.join(dir, part), { mode: 0o700 });
  const name = "nova_triad_selection_regression", address = new URL(cn.config.DATABASE_URL); address.pathname = `/${name}`;
  await createDatabase(cn.config.DATABASE_URL, name);
  const config = { ...cn.config, DATABASE_URL: address.href, NOVA_REPORT_DIR: path.join(dir, "reports"), NOVA_REPORT_KEY: randomBytes(32).toString("hex"), NOVA_TRIAD_SELECTION_OWNERSHIP: owner, NOVA_TRIAD_SELECTION_ROOT: dir, NOVA_TRIAD_SELECTION_OUTPUT_DIR: path.join(dir, "evidence") };
  delete config.NOVA_TEST_CLOCK_FILE;
  privateJson(path.join(dir, "private-config.json"), config);
  const environment = { ...clean(), ...config, TMPDIR: path.join(dir, "tmp"), NEXT_TELEMETRY_DISABLED: "1" };
  await command(process.execPath, ["--import", "tsx", "scripts/setup.ts"], { cwd: cn.app, env: environment, label: "selection synthetic setup", log: path.join(dir, "setup.log") });
  const { Client } = createRequire(path.join(root, "package.json"))("pg"), client = new Client({ connectionString: address.href });
  try { await client.connect(); await client.query("CREATE TABLE triad_selection_test_owner(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),owner text NOT NULL)"); await client.query("INSERT INTO triad_selection_test_owner(singleton,owner) VALUES(true,$1)", [owner]); } finally { await client.end(); }
  await command(process.execPath, ["--import", "tsx", "tests/triad-comparison-selection.integration.ts"], { env: environment, label: "real PostgreSQL prior-round selection integration", log: path.join(dir, "integration.log") });
}
async function main() {
  assert.ok(inside(path.join(root, "work"), output), "Output must be a new directory inside this checkout's work/");
  assert.ok(!fs.existsSync(output), "Refusing to reuse an existing run directory");
  assert.ok(Buffer.byteLength(`${cliTemp}/tsx-99999/999999999.pipe`) < 100, "Choose a shorter output path inside work/ so the tsx Unix socket fits the operating-system limit");
  assert.ok(fs.existsSync(path.join(root, "node_modules/next/package.json")), "Run npm ci before these checks");
  assert.notEqual(process.getuid?.(), 0, "Native initdb requires a non-root operating-system user");
  pgBin = postgresBin(); chrome = chromiumPath();
  assert.notEqual(commandResult("pdftotext", ["-v"]), null, "Poppler pdftotext must be installed");
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.mkdirSync(output, { mode: 0o700 }); fs.mkdirSync(path.join(output, "tmp"), { mode: 0o700 }); claimed = true;
  console.log(`Synthetic comparison evidence: ${path.relative(root, output)}`);
  const cn = await prepare("CN"), hk = await prepare("HK");
  for (const spec of [cn, hk]) {
    spec.config.NOVA_DEMO_SIBLING_URL = (spec === cn ? hk : cn).config.NOVA_PUBLIC_URL; privateJson(spec.configFile, spec.config);
    const web = start(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", spec.app, "--webpack", "--hostname", "127.0.0.1", "--port", String(spec.webPort)], { cwd: spec.app, env: runtimeEnv(spec), label: `${spec.region} web`, log: path.join(spec.dir, "logs/web.log") });
    start(process.execPath, ["--import", "tsx", "scripts/worker.ts"], { cwd: spec.app, env: runtimeEnv(spec), label: `${spec.region} worker`, log: path.join(spec.dir, "logs/worker.log") });
    await ready(spec, web);
  }
  privateJson(path.join(output, "runtime.json"), { syntheticOnly: true, aiEnabled: false, root, pgBin, chrome, regions: [cn, hk].map(spec => ({ region: spec.region, webPort: spec.webPort, dbPort: spec.dbPort, dataDir: spec.data })), processes: processes.filter(p => !p.finished).map(p => ({ label: p.label, pid: p.child.pid })) });
  await command(process.execPath, ["--import", "tsx", "tests/triad-comparison.integration.ts"], { env: { ...clean(), TMPDIR: path.join(output, "tmp"), NOVA_AI_ENABLED: "false", NOVA_CHROMIUM_EXECUTABLE: chrome, NOVA_TRIAD_COMPARISON_CN_CONFIG: cn.configFile, NOVA_TRIAD_COMPARISON_HK_CONFIG: hk.configFile, NOVA_TRIAD_COMPARISON_OUTPUT_DIR: path.join(output, "comparison") }, label: "two-round HTTP, immutable reports and bilingual browser integration", log: path.join(output, "comparison.log") });
  for (const spec of [cn, hk]) assert.equal(Number(fs.readFileSync(spec.config.NOVA_TEST_CLOCK_FILE, "utf8")), 0, "Full integration must run on the current clock");
  await selection(cn);
  await command("npm", ["run", "test:integration"], { env: { ...clean(), TMPDIR: cliTemp, NOVA_AI_ENABLED: "false", NOVA_INTEGRATION_CN_URL: cn.config.NOVA_PUBLIC_URL, NOVA_INTEGRATION_HK_URL: hk.config.NOVA_PUBLIC_URL, NOVA_INTEGRATION_OUTPUT_DIR: path.join(output, "full-integration") }, label: "existing npm run test:integration", log: path.join(output, "full-integration.log") });
  passed = true;
}
try { await main(); }
catch (error) { console.error(error instanceof assert.AssertionError ? error.message : `Local regression runner failed (${error instanceof Error ? error.name : "UnknownError"}); inspect private run logs`); process.exitCode ||= 1; }
finally {
  const cleanupErrors = await cleanup();
  if (cleanupErrors.length) { process.exitCode ||= 1; passed = false; console.error(cleanupErrors.join("; ")); }
  if (claimed) privateJson(path.join(output, "results.json"), { runId, passed: passed && !interrupted, syntheticOnly: true, aiEnabled: false, checks, cleanupPassed: !cleanupErrors.length });
  if (passed && !interrupted) console.log(`All comparison and existing integration checks passed; owned processes stopped. Evidence: ${path.relative(root, output)}`);
}
