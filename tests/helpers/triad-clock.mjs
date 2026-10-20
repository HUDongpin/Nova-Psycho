// Loaded only by scripts/triad-comparison-checks.mjs in its owned app processes.
// Keep parse/UTC as own properties: Next's Date wrapper copies those descriptors.
import fs from "node:fs";
import path from "node:path";
const NativeDate = Date;
const file = process.env.NOVA_TEST_CLOCK_FILE;
if (!file || !path.isAbsolute(file) || process.env.NOVA_MODE !== "demo" || process.env.NOVA_AI_ENABLED !== "false" || process.env.NOVA_AUTH_PROVIDER !== "local") throw new Error("Synthetic clock requires an explicit local demo runtime");
const origin = new URL(process.env.NOVA_PUBLIC_URL);
if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) throw new Error("Synthetic clock requires a loopback origin");
if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error("Synthetic clock file must be private");
const offset = () => { const value = Number(fs.readFileSync(file, "utf8")); if (![0, -91 * 86400000].includes(value)) throw new Error("Unexpected synthetic clock offset"); return value; };
function SyntheticDate(...args) {
  if (!new.target) return new NativeDate(NativeDate.now() + offset()).toString();
  return Reflect.construct(NativeDate, args.length ? args : [NativeDate.now() + offset()], new.target);
}
SyntheticDate.prototype = NativeDate.prototype;
Object.defineProperties(SyntheticDate, {
  now: { value: () => NativeDate.now() + offset(), writable: true, configurable: true },
  parse: { value: NativeDate.parse, writable: true, configurable: true },
  UTC: { value: NativeDate.UTC, writable: true, configurable: true }
});
global.Date = SyntheticDate;
