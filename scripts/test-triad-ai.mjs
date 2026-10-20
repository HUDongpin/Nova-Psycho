import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every database, process, credential and report belongs to this local synthetic run.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await fs.mkdir(path.join(root, "work/qa/triad-ai"), { recursive: true });
const output = await fs.realpath(await fs.mkdtemp(path.join(root, "work/qa/triad-ai/run-")));
const tempRoot = path.resolve(process.env.NOVA_TEST_TMP_ROOT ?? path.join(root, "work"));
assert.ok(tempRoot.split(path.sep).includes("work"), "Test temporary files must stay under a work directory");
await fs.mkdir(tempRoot, { recursive: true });
const temporary = await fs.mkdtemp(path.join(tempRoot, "tai-"));
assert.ok(Buffer.byteLength(path.join(temporary, "tsx-501/000000.pipe")) < 100, "Use a shorter NOVA_TEST_TMP_ROOT inside work for local sockets");
const app = path.join(output, "app");
const pgBin = process.env.NOVA_TEST_PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const clean = Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TZ"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
const processes = [];
const databases = [];
const summary = { syntheticOnly: true, liveAi: false, output, checks: [], cleanup: false };

function launch(command, args, cwd, env, log) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const stream = fs.open(log, "a", 0o600).then(handle => {
    child.stdout.on("data", chunk => void handle.write(chunk));
    child.stderr.on("data", chunk => void handle.write(chunk));
    return completed.finally(() => handle.close());
  });
  return { child, completed, stream };
}

async function run(command, args, cwd, env, log) {
  const process = launch(command, args, cwd, env, log);
  const result = await process.completed;
  await process.stream;
  assert.equal(result.code, 0, `${path.basename(command)} failed; see ${path.relative(root, log)}`);
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

async function stop(process) {
  if (process.child.exitCode !== null || process.child.signalCode) return;
  process.child.kill("SIGTERM");
  let timer;
  await Promise.race([process.completed, new Promise(resolve => { timer = setTimeout(resolve, 15000); })]);
  clearTimeout(timer);
  if (process.child.exitCode === null && !process.child.signalCode) process.child.kill("SIGKILL");
  await process.completed;
  await process.stream;
}

async function ready(url, process) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) throw new Error("Owned web process stopped before readiness");
    try {
      const response = await fetch(`${url}/api/session`, { redirect: "error", signal: AbortSignal.timeout(3000) });
      if (response.ok) { assert.equal((await response.json()).mode, "demo"); return; }
    } catch { /* Wait only for this new loopback service. */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error("Owned web service did not become ready");
}

try {
  await fs.mkdir(app);
  for (const item of ["src", "scripts", "tests", "public", "assets", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "next-env.d.ts"]) {
    await fs.cp(path.join(root, item), path.join(app, item), { recursive: true });
  }
  await fs.symlink(await fs.realpath(path.join(root, "node_modules")), path.join(app, "node_modules"), "dir");
  await fs.mkdir(path.join(app, "work"));
  const regions = [];
  for (const region of ["CN", "HK"]) {
    const directory = path.join(output, region);
    for (const name of ["logs", "reports", "tmp"]) await fs.mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
    const databasePort = await port(), webPort = await port();
    const name = `nova_triad_ai_${region.toLowerCase()}`, password = randomBytes(24).toString("hex");
    const passwordFile = path.join(directory, "postgres-password");
    const data = path.join(directory, "postgres");
    await fs.writeFile(passwordFile, password, { flag: "wx", mode: 0o600 });
    const env = {
      ...clean, TMPDIR: temporary, NEXT_TELEMETRY_DISABLED: "1",
      NOVA_MODE: "demo", NOVA_AUTH_PROVIDER: "local", NOVA_REGION: region, NOVA_DATA_REGION: region,
      NOVA_DIST_DIR: ".next",
      DATABASE_URL: `postgresql://${name}:${password}@127.0.0.1:${databasePort}/postgres`,
      NOVA_PUBLIC_URL: `http://127.0.0.1:${webPort}`,
      NOVA_REPORT_STORAGE: "filesystem", NOVA_REPORT_DIR: path.join(directory, "reports"), NOVA_REPORT_KEY: randomBytes(32).toString("hex"),
      NOVA_WORKER_MODE: "continuous", NOVA_AI_ENABLED: "false", NOVA_TRIAD_AI_ENABLED: "false",
      NOVA_AI_API_KEY: "", NOVA_AI_BASE_URL: "", NOVA_AI_MODEL: "", VERCEL: "0",
    };
    const log = path.join(directory, "logs/postgres-setup.log");
    await run(path.join(pgBin, "initdb"), ["-D", data, "-U", name, "--encoding=UTF8", "--locale=C", "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", `--pwfile=${passwordFile}`], root, clean, log);
    await fs.appendFile(path.join(data, "postgresql.conf"), `\nlisten_addresses='127.0.0.1'\nport=${databasePort}\nunix_socket_directories=''\nmax_connections=40\nshared_buffers='64MB'\nlog_statement='none'\nlog_min_error_statement='panic'\n`);
    await run(path.join(pgBin, "pg_ctl"), ["-D", data, "-l", path.join(directory, "logs/postgres.log"), "-w", "-t", "30", "start"], root, clean, log);
    databases.push({ data, log });
    await fs.writeFile(path.join(directory, "private-config.json"), JSON.stringify(env), { flag: "wx", mode: 0o600 });
    await run(process.execPath, ["--import", "tsx", "scripts/setup.ts"], app, env, path.join(directory, "logs/setup.log"));
    await run(process.execPath, ["--import", "tsx", "scripts/worker.ts", "--once"], app, env, path.join(directory, "logs/seed-reports.log"));
    regions.push({ region, env, directory, webPort });
  }
  await run("npm", ["run", "build"], app, regions[0].env, path.join(output, "build.log"));
  summary.checks.push("production build");
  const built = JSON.parse(await fs.readFile(path.join(app, ".next/required-server-files.json"), "utf8"));
  const standalone = path.join(app, ".next/standalone", built.relativeAppDir);
  assert.ok(!path.relative(path.join(app, ".next/standalone"), standalone).startsWith(".."));
  await fs.cp(path.join(app, "public"), path.join(standalone, "public"), { recursive: true });
  await fs.cp(path.join(app, ".next/static"), path.join(standalone, ".next/static"), { recursive: true });
  for (const regional of regions) {
    regional.web = launch(process.execPath, [path.join(standalone, "server.js")], standalone, { ...regional.env, HOSTNAME: "127.0.0.1", PORT: String(regional.webPort) }, path.join(regional.directory, "logs/web.log"));
    processes.push(regional.web);
    await ready(regional.env.NOVA_PUBLIC_URL, regional.web);
    regional.worker = launch(process.execPath, ["--import", "tsx", "scripts/worker.ts"], app, regional.env, path.join(regional.directory, "logs/worker.log"));
    processes.push(regional.worker);
  }
  const integrationEnv = { ...regions[0].env, NOVA_INTEGRATION_CN_URL: regions[0].env.NOVA_PUBLIC_URL, NOVA_INTEGRATION_HK_URL: regions[1].env.NOVA_PUBLIC_URL, NOVA_INTEGRATION_OUTPUT_DIR: path.join(app, "work/integration") };
  await run("npm", ["run", "test:integration"], app, integrationEnv, path.join(output, "integration.log"));
  summary.checks.push("existing AI-off CN/HK integration");
  for (const regional of regions) await stop(regional.worker);
  for (const regional of regions) {
    await run(process.execPath, ["--import", "tsx", "tests/triad-ai.integration.ts"], app, {
      ...regional.env,
      NOVA_TRIAD_AI_TEST_OUTPUT: path.join(app, "work", `triad-ai-${regional.region}`),
    }, path.join(regional.directory, "logs/triad-ai.log"));
    summary.checks.push(`${regional.region} synthetic triad AI, browser and PDF`);
  }
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.failure = error instanceof Error ? error.message : "Unknown failure";
  process.exitCode = 1;
} finally {
  for (const child of processes.reverse()) await stop(child);
  for (const database of databases.reverse()) await run(path.join(pgBin, "pg_ctl"), ["-D", database.data, "-w", "-t", "30", "-m", "fast", "stop"], root, clean, database.log);
  await fs.rm(temporary, { recursive: true, force: true });
  summary.cleanup = true;
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
}
