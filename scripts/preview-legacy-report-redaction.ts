import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { reportHtml } from "../src/domain/report-html";
import { PARENT_REPORT_AUDIENCE_VERSION, reportNeedsPrivacyRefresh } from "../src/domain/report-privacy";
import type { Locale, ReportPayload } from "../src/domain/types";
import { closePdfBrowser, renderPdf } from "../src/lib/pdf";

const payloadKeys = new Set(["scale", "advice", "template", "score", "childName", "grade", "submittedAt", "aiConsented", "syntheticTest", "selectedAdviceIds", "generationMode", "fallbackReason", "aiModel", "comparison", "triad"]);

async function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error("Expected payload input and new work output directory");
  const work = await realpath("work");
  const destination = path.resolve(output);
  if (await realpath(path.dirname(destination)) !== work) throw new Error("Output must be a new immediate child of work");
  const bytes = await readFile(input);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some(key => !payloadKeys.has(key))) throw new Error("Expected a report payload export");
  const source = parsed as ReportPayload;
  if (!source.triad || !Array.isArray(source.triad.words) || !reportNeedsPrivacyRefresh(source)) throw new Error("Expected an unmarked historical triad report");
  const repaired: ReportPayload = { ...source, triad: { ...source.triad, words: [], parentAudienceVersion: PARENT_REPORT_AUDIENCE_VERSION, legacyWritingOmitted: true } };
  const documents: { locale: Locale; html: string; pdf: Buffer }[] = [];
  try {
    for (const locale of ["zh-CN", "zh-HK"] as const) {
      const html = reportHtml(repaired, locale);
      documents.push({ locale, html, pdf: await renderPdf(html) });
    }
  } finally {
    await closePdfBrowser();
  }
  await mkdir(destination, { mode: 0o700 });
  const put = (filename: string, content: string | Buffer) => writeFile(path.join(destination, filename), content, { flag: "wx", mode: 0o600 });
  await put("payload.json", JSON.stringify(repaired));
  for (const document of documents) {
    await put(`${document.locale}.html`, document.html);
    await put(`${document.locale}.pdf`, document.pdf);
  }
  await put("manifest.json", JSON.stringify({ sourceSha256: createHash("sha256").update(bytes).digest("hex"), parentAudienceVersion: PARENT_REPORT_AUDIENCE_VERSION, legacyWritingOmitted: true, runtimeChanged: false }, null, 2));
  console.log("Created a private local redaction preview. Runtime reports and original files are unchanged.");
}

main().catch(() => {
  console.error("Legacy report preview failed. Check the payload shape, private output directory and local PDF renderer.");
  process.exitCode = 1;
});
