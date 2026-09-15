import {query,closeDatabase,transaction} from "../src/lib/db";
import {renderPdf,closePdfBrowser} from "../src/lib/pdf";
try {
  const rows=await query("SELECT state,count(*) FROM report_jobs GROUP BY state");console.log("Job states",rows);
  try { await transaction(async c=>{await c.query("UPDATE assessments SET status=status WHERE id=(SELECT id FROM assessments LIMIT 1)");});console.log("Assessment status trigger OK"); }
  catch(e){console.log("Trigger error",(e as {code?:string}).code,(e as Error).message);}
  try {const pdf=await renderPdf("<html><meta charset='utf-8'><body>Nova 測試 · 中文报告</body></html>");console.log("PDF renderer bytes",pdf.length);}
  catch(e){console.log("PDF error",(e as Error).name,(e as Error).message.slice(0,1200));}
}finally{await closePdfBrowser();await closeDatabase();}
