import type { Locale,ReportPayload,RespondentRole,SupportIntakeObservation,TriadReport } from "./types";
import { text } from "./types";
import { effectiveDemo } from "./validation";
import { gardenIconForSection, gardenIconUri, gardenSceneUri, type GardenIconKey } from "./garden-visuals";
import { reportGardenStyle } from "./report-garden-style";

interface DirectoryEntry { id: string; label: string; icon: GardenIconKey }
function reportIcon(icon: GardenIconKey): string {
  return `<img class="chapter-icon" src="${escapeHtml(gardenIconUri(icon))}" alt="" aria-hidden="true" width="44" height="44">`;
}
function reportHeading(label: string, id: string, icon: GardenIconKey, level: 2 | 3 = 2): string {
  return `<h${level} class="chapter-title" id="${id}">${reportIcon(icon)}<span>${escapeHtml(label)}</span></h${level}>`;
}
function reportDirectory(entries: DirectoryEntry[], locale: Locale): string {
  const label = locale === "zh-HK" ? "這份報告裏" : "这份报告里";
  return `<nav class="report-directory" aria-label="${label}"><p>${label}</p><ul>${entries.map(entry => `<li><a href="#${entry.id}">${reportIcon(entry.icon)}<span>${escapeHtml(entry.label)}</span></a></li>`).join("")}</ul></nav>`;
}
function reportArtwork(): string {
  return `<img class="garden-report-art" src="${escapeHtml(gardenSceneUri("report"))}" alt="" aria-hidden="true" width="480" height="180">`;
}
export function reportShowsDemo(p:Pick<ReportPayload,"score"|"scale">):boolean{
  return effectiveDemo({demo:p.score.demo,norm:p.score.norm})||effectiveDemo(p.scale);
}
export function escapeHtml(value:unknown):string{return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);}
export const respondentLabel=(role:RespondentRole,locale:Locale)=>({student:locale==="zh-HK"?"學生自評":"学生自评",parent:locale==="zh-HK"?"家長觀察":"家长观察",teacher:locale==="zh-HK"?"教師觀察":"教师观察"})[role];
function syntheticTestNotice(p:ReportPayload,locale:Locale):string{
  if(!p.syntheticTest)return "";
  return `<div class="demo"><strong>${locale==="zh-HK"?"線上合成測試報告":"线上合成测试报告"}</strong><br>${locale==="zh-HK"?"僅用於指定測試帳號的流程驗證，使用合成資料及規則模板，不代表真實個案，也不提供臨床診斷。":"仅用于指定测试账号的流程验证，使用合成数据及规则模板，不代表真实个案，也不提供临床诊断。"}</div>`;
}
function triadComparisonHtml(report:TriadReport,locale:Locale):string{
  const hk=locale==="zh-HK",t=(cn:string,tw:string)=>hk?tw:cn,e=escapeHtml;
  const fmt=(iso:string)=>new Intl.DateTimeFormat(locale,{timeZone:"Asia/Hong_Kong",year:"numeric",month:"long",day:"numeric"}).format(new Date(iso));
  const reasons={
    first_assessment:t("目前没有更早的完整三方记录，可在下一轮填写后查看适用的比较。","目前沒有更早的完整三方紀錄，可在下一輪填寫後查看適用的比較。"),
    incompatible_version:t("两次问卷版本或计分依据不同，本方暂不作分数比较。","兩次問卷版本或計分依據不同，本方暫不作分數比較。"),
    not_scored:t("简版问卷不计分，不作分数比较。","簡版問卷不計分，不作分數比較。"),
    different_respondent:t("两次填写人不同，本方的观察分别保留，不作分数比较。","兩次填寫人不同，本方的觀察分別保留，不作分數比較。"),
    incomplete:t("两次记录中有不完整或不适用的资料，本方暂不作分数比较。","兩次紀錄中有不完整或不適用的資料，本方暫不作分數比較。")
  };
  const roles=report.comparisons?.map(result=>{
    const rows=result.available?(result.changes??[]).map(change=>{
      const direction=change.delta>0?t("原始分升高","原始分升高"):change.delta<0?t("原始分降低","原始分降低"):t("原始分没有变化","原始分沒有變化");
      const meaning=change.higherMeans==="more_support"?t("分数越高表示需要更多支持。","分數越高表示需要更多支持。"):t("分数越高表示该方面的优势更明显。","分數越高表示該方面的優勢更明顯。");
      return `<tr><th scope="row">${e(text(change.label,locale))}<span class="meta">${e(meaning)}</span></th><td>${e(change.previous)}</td><td>${e(change.current)}</td><td>${change.delta>0?"+":""}${e(change.delta)}<span class="meta">${e(direction)}</span></td></tr>`;
    }).join(""):"";
    const omitted=result.omitted?.length?`<p class="meta">${e(t("以下维度在其中一次填写时不适用或有效回答不足，未计算变化：","以下維度在其中一次填寫時不適用或有效回答不足，未計算變化："))}${e(result.omitted.map(item=>text(item.label,locale)).join("、"))}。</p>`:"";
    return `<section class="comparison-role"><h3>${e(respondentLabel(result.role,locale))}</h3><p class="meta">${result.previousDate?`${e(t("上次填写","上次填寫"))} ${e(fmt(result.previousDate))} · `:""}${e(t("本次填写","本次填寫"))} ${e(fmt(result.currentDate))}</p>${result.available?`<table class="comparison-table"><thead><tr><th scope="col">${e(t("维度","維度"))}</th><th scope="col">${e(t("上次","上次"))}</th><th scope="col">${e(t("本次","本次"))}</th><th scope="col">${e(t("变化","變化"))}</th></tr></thead><tbody>${rows}</tbody></table>`:`<p>${e(reasons[result.reason??"incomplete"])}</p>`}${omitted}</section>`;
  }).join("");
  return `<section class="triad-comparison">${reportHeading(t("和上一轮相比","和上一輪相比"),"report-comparison","comparison")}${roles?`<p>${e(t("以本次之前最近一轮完整三方填写为参照，分别比较同一填写人、相同问卷版本及计分依据的结果。不合成三方总分。","以本次之前最近一輪完整三方填寫為參照，分別比較同一填寫人、相同問卷版本及計分依據的結果。不合成三方總分。"))}</p>${roles}<p class="meta">${e(t("表中为原始分。家长处理方式的描述、情境题和文字回答不计算分数变化。变化本身不证明辅导疗效，也不能用来诊断。","表中為原始分。家長處理方式的描述、情境題和文字回答不計算分數變化。變化本身不證明輔導療效，也不能用來診斷。"))}</p>`:`<p>${e(t("这份历史报告未记录前后比较结果。后续新报告会在条件满足时提供比较。","這份歷史報告未記錄前後比較結果。後續新報告會在條件滿足時提供比較。"))}</p>`}</section>`;
}
function supportIntakeReportHtml(p:ReportPayload,locale:Locale):string{
  const report=p.triad as TriadReport;
  const intake=report.supportIntake;
  if(!intake)throw new Error("Missing support intake report");
  const hk=locale==="zh-HK",t=(cn:string,tw=cn)=>hk?tw:cn,e=escapeHtml;
  const fmt=(iso:string)=>new Intl.DateTimeFormat(locale,{timeZone:"Asia/Hong_Kong",year:"numeric",month:"long",day:"numeric"}).format(new Date(iso));
  const sourceName=(role:RespondentRole)=>role==="student"?t("孩子","孩子"):role==="parent"?t("家长","家長"):t("教师","教師");
  const sources=report.sources.map(source=>report.staged?`${e(source.label?text(source.label,locale):sourceName(source.role))} · ${e(t("提交","提交"))} ${e(fmt(source.submittedAt))}${source.visitDate?` · ${e(t("到访","到訪"))} ${e(source.visitDate)}`:""}`:`${e(sourceName(source.role))} ${e(fmt(source.submittedAt))}`).join(" · ");
  const observationLabel=(role:RespondentRole)=>{
    const source=report.sources.find(source=>source.role===role);
    return source?.label?text(source.label,locale):respondentLabel(role,locale);
  };
  const hasStudent=report.sources.some(source=>source.role==="student"),hasObservation=report.sources.some(source=>source.role==="teacher");
  const sourceScope=!hasStudent&&!hasObservation?t("当前资料仅来自家长。尚未收到学生资料和 TOPE 现场观察。","目前資料僅來自家長。尚未收到學生資料和 TOPE 現場觀察。")
    :!hasObservation?t("本版已新增学生资料，尚未收到 TOPE 现场观察。","本版已新增學生資料，尚未收到 TOPE 現場觀察。")
      :!hasStudent?t("本版已新增观察资料，尚未收到学生资料。","本版已新增觀察資料，尚未收到學生資料。")
        :t("本版已收录列明的各方资料；各来源只代表所注明的情境与时间。","本版已收錄列明的各方資料；各來源只代表所註明的情境與時間。");
  const intro=report.staged?t("这份报告按当前已经提交的来源整理困难、已有支持和下一步。学生普通答案不会展示；只有学生明确选择并确认的支持句子可以分享。不同来源追加时不计算分数或变化，也不代表完成全面评估。","這份報告按目前已經提交的來源整理困難、已有支持和下一步。學生普通答案不會展示；只有學生明確選擇並確認的支持句子可以分享。不同來源追加時不計算分數或變化，也不代表完成全面評估。")
    :t("这份报告整理家长和教师对当前困难、已有支持与下一步的观察，帮助共同商定一项具体行动。简版问卷不计分，不形成完整画像，也不用于诊断。","這份報告整理家長和教師對當前困難、已有支持與下一步的觀察，幫助共同商定一項具體行動。簡版問卷不計分，不形成完整畫像，也不用於診斷。");
  const revision=report.staged&&p.revision?`<p class="meta report-revision">${e(t("报告版本","報告版本"))} ${e(p.revision.version)} · ${e(t("生成日期","產生日期"))} ${e(fmt(p.revision.generatedAt))}</p>`:"";
  const sections=([
    {id:"report-concerns",label:t("当前关注与困难","當前關注與困難"),icon:"words",rows:intake.concerns},
    {id:"report-supports",label:t("现有支持与日常安排","現有支持與日常安排"),icon:"family",rows:intake.supports},
    {id:"report-actions",label:t("希望获得的支持与下一步目标","希望獲得的支持與下一步目標"),icon:"compass",rows:intake.actions}
  ] satisfies {id:string;label:string;icon:GardenIconKey;rows:SupportIntakeObservation[]}[]).filter(section=>section.rows.length>0);
  const observations=sections.map(section=>`<section class="support-intake-section">${reportHeading(section.label,section.id,section.icon)}${section.rows.map(row=>`<div class="content-note" data-role="${row.role}"><p class="meta">${e(observationLabel(row.role))} · ${e(text(row.period,locale))}${row.informationSource?` · ${e(t("信息来源","資料來源"))}：${e(text(row.informationSource,locale))}`:""}</p><p><strong>${e(text(row.prompt,locale))}</strong></p><p>${row.responses.map(response=>e(text(response,locale))).join("、")}</p></div>`).join("")}</section>`).join("");
  const shared=intake.studentShared?.sentences.length?`<section class="student-shared-support">${reportHeading(t("学生愿意分享的支持需要","學生願意分享的支持需要"),"report-student-sharing","words")}<p class="meta">${e(t("以下仅为学生主动选择并确认分享的句子，不概括其他答案。","以下僅為學生主動選擇並確認分享的句子，不概括其他答案。"))}</p><ul>${intake.studentShared.sentences.map(sentence=>`<li>${e(text(sentence,locale))}</li>`).join("")}</ul></section>`:"";
  const safety=report.safety.length?`<section class="risk">${reportHeading(t("请先关注安全","請先關注安全"),"report-safety","shield")}${report.safety.map(message=>`<p>${e(text(message,locale))}</p>`).join("")}<p>${e(t("报告仍然发给家长。工作人员也会同时看到安全提示。如有眼前危险，请联系当地紧急服务。","報告仍然發給家長。工作人員也會同時看到安全提示。如有眼前危險，請聯絡當地緊急服務。"))}</p></section>`:"";
  const directory:DirectoryEntry[]=[...sections.map(({id,label,icon})=>({id,label,icon})),...(shared?[{id:"report-student-sharing",label:t("学生愿意分享的支持需要","學生願意分享的支持需要"),icon:"words" as const}]:[]),{id:"report-next-step",label:t("共同商定一项行动","共同商定一項行動"),icon:"compass"}];
  const footer=report.staged?t("根据本版列出的已提交资料自动生成；后续新增来源会生成新版本，既有版本保留。家庭私密报告，请妥善保管。","根據本版列出的已提交資料自動產生；後續新增來源會產生新版本，既有版本保留。家庭私密報告，請妥善保管。")
    :t("三份都交齐后自动生成。家庭私密报告，请妥善保管。","三份都交齊後自動產生。家庭私密報告，請妥善保管。");
  return `<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(text(report.title,locale))} · TopE 心理助手</title><style>${reportGardenStyle}${report.staged?"@media print{.support-intake-report .content-note{padding:8px 12px;margin:6px 0}.support-intake-report .report-close{break-inside:avoid;page-break-inside:avoid}}":""}</style></head><body><article class="garden-report support-intake-report" data-report-layout="garden-v1"><header><div class="brand">TopE 心理助手</div>${reportArtwork()}<h1>${e(text(report.title,locale))}</h1><p>${e(p.childName)} · ${e(p.grade)}</p>${revision}<p class="meta">${sources}</p><p>${e(intro)}</p>${report.staged?`<p class="source-scope">${e(sourceScope)}</p>`:""}</header>
  ${syntheticTestNotice(p,locale)}${reportShowsDemo(p)?`<div class="demo"><strong>${e(t("非临床试用报告 · 尚无经过验证的临床常模","非臨床試用報告 · 尚無經過驗證的臨床常模"))}</strong><br>${e(t("仅供成长支持与沟通参考，不能用于临床诊断，也不能替代专业评估。","僅供成長支持與溝通參考，不能用於臨床診斷，也不能替代專業評估。"))}</div>`:""}
  ${safety}${reportDirectory(directory,locale)}${observations}${shared}
  <div class="report-close"><section class="advice">${reportHeading(t("共同商定一项行动","共同商定一項行動"),"report-next-step","compass")}<p>${e(text(intake.nextStep,locale))}</p></section>
  <p class="limitation">${e(t("观察来自不同情境和时间范围，请结合具体情况沟通。孩子的普通作答及工作人员专用记录不会在这份家长报告中展示。未触发安全提示也不代表没有风险。","觀察來自不同情境和時間範圍，請結合具體情況溝通。孩子的普通作答及工作人員專用紀錄不會在這份家長報告中展示。未觸發安全提示也不代表沒有風險。"))}</p><footer>${e(t("规则模板生成","規則模板產生"))}<br>TopE 心理助手 · ${e(footer)}</footer></div></article></body></html>`;
}
function triadReportHtml(p:ReportPayload,locale:Locale):string{
  const report=p.triad as TriadReport;
  if(report.resultMode==="support-intake")return supportIntakeReportHtml(p,locale);
  const hk=locale==="zh-HK",t=(cn:string,tw=cn)=>hk?tw:cn,e=escapeHtml;
  const fmt=(iso:string)=>new Intl.DateTimeFormat(locale,{timeZone:"Asia/Hong_Kong",year:"numeric",month:"long",day:"numeric"}).format(new Date(iso));
  const roleName=(role:RespondentRole)=>role==="student"?t("孩子","孩子"):role==="parent"?t("家长","家長"):t("老师","老師");
  const sources=report.sources.map(source=>`${e(roleName(source.role))} ${e(fmt(source.submittedAt))}`).join(" · ");
  const advice=p.selectedAdviceIds.map(id=>p.advice.content.blocks.find(block=>block.id===id)).filter(block=>block!==undefined);
  const safety=report.safety.length?`<section class="risk">${reportHeading(t("请先关注安全","請先關注安全"),"report-safety","shield")}${report.safety.map(message=>`<p>${e(text(message,locale))}</p>`).join("")}<p>${e(t("报告仍然发给家长。工作人员也会同时看到安全提示。如有眼前危险，请联系当地紧急服务。","報告仍然發給家長。工作人員也會同時看到安全提示。如有眼前危險，請聯絡當地緊急服務。"))}</p></section>`:"";
  const domains=report.domains.map((domain,index)=>{
    const roles=[...new Set(domain.views.map(view=>view.role))];
    const roleLabel=(role:RespondentRole)=>role==="student"?t("孩子自己","孩子自己"):role==="parent"?t("家长看到的","家長看到的"):t("老师看到的","老師看到的");
    const views=roles.map(role=>`<div class="observation-view" data-role="${role}"><h4 class="observation-role">${e(roleLabel(role))}</h4>${domain.views.filter(view=>view.role===role).map(view=>`<p><strong>${e(text(view.label,locale))}</strong> ${e(text(view.body,locale))}</p>`).join("")}</div>`).join("");
    return `<section class="dimension">${reportHeading(text(domain.label,locale),`report-domain-${index+1}`,gardenIconForSection(domain.key),3)}${domain.note?`<p class="band">${e(text(domain.note,locale))}</p>`:""}<div class="observation-views observation-count-${roles.length}">${views}</div></section>`;
  }).join("");
  const portrait=report.portrait.length?`<section class="portrait">${reportHeading(t("家长通常会怎样处理","家長通常會怎樣處理"),"report-portrait","family")}<p class="meta">${e(t("这里用平实的话描述您自己的回答，不给家长打分，也不划分等级。","這裏用平實的話描述您自己的回答，不給家長打分，也不劃分等級。"))}</p>${report.portrait.map(item=>`<div class="content-note"><p><strong>${e(text(item.heading,locale))}</strong> ${e(text(item.body,locale))}</p></div>`).join("")}</section>`:"";
  const situations=report.situations.length?`<section class="situations">${reportHeading(t("遇到这些情况时，各方通常会怎么做","遇到這些情況時，各方通常會怎麼做"),"report-situations","words")}<p class="meta">${e(t("情境题不记入分数，只用来看实际会怎么处理。","情境題不計入分數，只用來看實際會怎麼處理。"))}</p>${report.situations.map(item=>`<div class="content-note"><p><strong>${e(roleName(item.role))}</strong> ${e(text(item.prompt,locale))}</p><p>${e(text(item.choice,locale))}</p></div>`).join("")}</section>`:"";
  const priorities=report.priorities.length?`<section class="priorities">${reportHeading(t("这次最希望得到的帮助","這次最希望得到的幫助"),"report-priorities","compass")}${report.priorities.map(item=>`<div class="content-note"><p><strong>${e(roleName(item.role))}</strong> ${e(text(item.prompt,locale))}</p><p>${e(item.choices.map(choice=>text(choice,locale)).join("、"))}</p></div>`).join("")}</section>`:"";
  const words=report.legacyWritingOmitted?`<section class="words">${reportHeading(t("他们写下的话","他們寫下的話"),"report-words","words")}<p>${e(t("为保护隐私，这份历史报告中的文字回答已隐藏。原有评分、安全提示和前后比较保持不变。","為保護私隱，這份歷史報告中的文字回答已隱藏。原有評分、安全提示和前後比較保持不變。"))}</p></section>`:report.words.length?`<section class="words">${reportHeading(t("他们写下的话","他們寫下的話"),"report-words","words")}${report.words.map(item=>`<div class="content-note"><p><strong>${e(roleName(item.role))} · ${e(text(item.prompt,locale))}</strong></p><p>${e(item.value)}</p></div>`).join("")}</section>`:"";
  const directory:DirectoryEntry[]=[
    ...report.domains.map((domain,index)=>({id:`report-domain-${index+1}`,label:text(domain.label,locale),icon:gardenIconForSection(domain.key)})),
    ...(!report.domains.length?[{id:"report-observations",label:t("三方看到的情况","三方看到的情況"),icon:"family" as const}]:[]),
    ...(portrait?[{id:"report-portrait",label:t("家长通常会怎样处理","家長通常會怎樣處理"),icon:"family" as const}]:[]),
    ...(situations?[{id:"report-situations",label:t("遇到这些情况时，各方通常会怎么做","遇到這些情況時，各方通常會怎麼做"),icon:"words" as const}]:[]),
    ...(priorities?[{id:"report-priorities",label:t("这次最希望得到的帮助","這次最希望得到的幫助"),icon:"compass" as const}]:[]),
    ...(words?[{id:"report-words",label:t("他们写下的话","他們寫下的話"),icon:"words" as const}]:[]),
    {id:"report-comparison",label:t("和上一轮相比","和上一輪相比"),icon:"comparison"},
    {id:"report-advice",label:t("家长可以尝试的下一步","家長可以嘗試的下一步"),icon:"compass"},
  ];
  return `<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(text(report.title,locale))} · TopE 心理助手</title><style>${reportGardenStyle}</style></head><body><article class="garden-report" data-report-layout="garden-v1"><header><div class="brand">TopE 心理助手</div>${reportArtwork()}<h1>${e(text(report.title,locale))}</h1><p>${e(p.childName)} · ${e(p.grade)}</p><p class="meta">${sources}</p><p>${e(t("这份报告把孩子、家长和老师各自的回答放在一起读。它不合成一个总分，也不做诊断。三方看到的不一样时，先把它当成不同情境里的观察。","這份報告把孩子、家長和老師各自的回答放在一起讀。它不合成一個總分，也不做診斷。三方看到的不一樣時，先把它當成不同情境裏的觀察。"))}</p></header>
  ${syntheticTestNotice(p,locale)}${reportShowsDemo(p)?`<div class="demo"><strong>${e(t("非临床试用报告 · 尚无经过验证的临床常模","非臨床試用報告 · 尚無經過驗證的臨床常模"))}</strong><br>${e(t("本报告整理本次填写的观察，仅供成长支持与沟通参考，不能用于临床诊断，也不能替代专业评估。","本報告整理本次填寫的觀察，僅供成長支持與溝通參考，不能用於臨床診斷，也不能替代專業評估。"))}</div>`:""}
  ${safety}${reportDirectory(directory,locale)}${reportHeading(t("三方看到的情况","三方看到的情況"),"report-observations","family")}${domains||`<p>${e(t("这几个方面的有效回答还不够，这里先不概括。","這幾個方面的有效回答還不夠，這裏先不概括。"))}</p>`}${portrait}${situations}${priorities}${words}
  ${triadComparisonHtml(report,locale)}
  ${reportHeading(t("家长可以尝试的下一步","家長可以嘗試的下一步"),"report-advice","compass")}${advice.length?advice.map((block,index)=>`<section class="advice"><h3>${reportIcon("compass")}<span>${index+1}. ${e(text(block.title,locale))}</span></h3><p>${e(text(block.body,locale))}</p><p class="meta">${e(block.source)}</p></section>`).join(""):`<p>${e(t("本次报告未附加支持建议。","本次報告未附加支持建議。"))}</p>`}
  <p class="limitation">${e(text(p.template.content.limitation,locale))}</p><footer>${e(p.generationMode==="ai"?t("AI 辅助排序建议","AI 輔助排序建議"):t("规则模板生成","規則模板產生"))} · ${e(t("建议库版本","建議庫版本"))} ${e(p.advice.version)}<br>TopE 心理助手 · ${e(t("三份都交齐后自动生成。家庭私密报告，请妥善保管。","三份都交齊後自動產生。家庭私密報告，請妥善保管。"))}</footer></article></body></html>`;
}
export function reportHtml(p:ReportPayload,locale:Locale):string{
  if(p.triad)return triadReportHtml(p,locale);
  const hk=locale==="zh-HK",t=(cn:string,tw=cn)=>hk?tw:cn,e=escapeHtml;
  const fmt=(iso:string)=>new Intl.DateTimeFormat(locale,{timeZone:"Asia/Hong_Kong",year:"numeric",month:"long",day:"numeric"}).format(new Date(iso));
  const date=fmt(p.submittedAt);
  const advice=p.selectedAdviceIds.map(id=>p.advice.content.blocks.find(b=>b.id===id)).filter(b=>b!==undefined);
  const nextStep=p.score.risk?t("请优先帮助孩子获得安全、可信任的成人及专业支持。如有眼前危险，请联系当地紧急服务。普通家庭建议不能替代对即时安全问题的处理。","請優先幫助孩子獲得安全、可信任的成人及專業支持。如有眼前危險，請聯絡當地緊急服務。普通家庭建議不能替代對即時安全問題的處理。"):advice.length?text(p.template.content.nextStep,locale):t("先确认量表是否适用，以及哪些必要信息尚未完成，再决定是否补充作答。当前资料不足的部分暂不解释。","先確認量表是否適用，以及哪些必要資料尚未完成，再決定是否補充作答。目前資料不足的部分暫不解釋。");
  const dimensions=p.score.dimensions.map((d,index)=>{
    const ratio=d.raw===null?0:Math.max(0,Math.min(100,100*(d.raw-d.min)/(d.max-d.min||1)));
    return `<section class="dimension scored-dimension"><div class="dim-head">${reportHeading(text(d.label,locale),`report-dimension-${index+1}`,gardenIconForSection(d.key),3)}<span class="score">${d.raw===null?"—":e(d.raw)} <small>/ ${e(d.max)}</small></span></div><div class="meter"><span style="width:${ratio}%"></span></div><p class="band">${e(d.band?text(d.band.label,locale):t("资料不足，暂不解释","資料不足，暫不解釋"))}</p><p>${e(d.band?text(d.band.explanation,locale):t("本维度缺少必要答案，系统没有补零或推测得分。","本維度缺少必要答案，系統沒有補零或推測得分。"))}</p><p class="meta">${e(t("已回答","已回答"))} ${d.answered}/${d.totalItems}${d.prorated?` · ${e(t("按本量表规则折算","按本量表規則折算"))}`:""} · ${e(t("原始分数，非人群百分位","原始分數，非人群百分位"))}</p></section>`;
  }).join("");
  const higherMeaning=(means:"more_support"|"more_strength")=>means==="more_support"?t("分数越高表示需要更多支持。","分數越高表示需要更多支持。"):t("分数越高表示该方面的优势更明显。","分數越高表示該方面的優勢更明顯。");
  const rawChange=(delta:number)=>delta>0?t("原始分较上次升高","原始分較上次升高"):delta<0?t("原始分较上次降低","原始分較上次降低"):t("原始分较上次没有变化","原始分較上次沒有變化");
  const comparison=p.comparison.available?`<div class="comparison">${p.comparison.previousDate?`<p class="meta">${e(t("对比的上次测评日期","對比的上次測評日期"))} ${e(fmt(p.comparison.previousDate))}</p>`:""}${p.comparison.changes!.map(c=>`<p><strong>${e(text(c.label,locale))}</strong> ${e(rawChange(c.delta))} · ${e(t("较上次原始分变化","較上次原始分變化"))} <strong>${c.delta>0?"+":""}${e(c.delta)}</strong></p><p class="meta">${e(higherMeaning(c.higherMeans))}</p>`).join("")}<p class="meta">${e(t("仅比较相同填答者与相同量表版本。变化本身不证明辅导疗效。","僅比較相同填答者與相同量表版本。變化本身不證明輔導療效。"))}</p></div>`:`<p>${e(t("目前没有适合直接比较的同版本、同填答者记录。不同填答者的观察分别保留，不计算合并总分。","目前沒有適合直接比較的同版本、同填答者紀錄。不同填答者的觀察分別保留，不計算合併總分。"))}</p>`;
  const directory:DirectoryEntry[]=[
    ...p.score.dimensions.map((dimension,index)=>({id:`report-dimension-${index+1}`,label:text(dimension.label,locale),icon:gardenIconForSection(dimension.key)})),
    ...(!p.score.dimensions.length?[{id:"report-observations",label:t("理解这一次的观察","理解這一次的觀察"),icon:"book" as const}]:[]),
    {id:"report-advice",label:t("家长可以尝试的下一步","家長可以嘗試的下一步"),icon:"compass"},
    {id:"report-comparison",label:t("和上一次相比","和上一次相比"),icon:"comparison"},
    {id:"report-next",label:p.score.risk?t("先获得适合的支持","先獲得適合的支持"):t("把理解带回日常","把理解帶回日常"),icon:"leaf"},
  ];
  return `<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(text(p.template.content.title,locale))} · TopE 心理助手</title><style>${reportGardenStyle}</style></head><body><article class="garden-report" data-report-layout="garden-v1"><header><div class="brand">TopE 心理助手</div>${reportArtwork()}<h1>${e(text(p.template.content.title,locale))}</h1><div class="facts"><span>${e(p.childName)}</span><span>${e(p.grade)}</span><span>${e(respondentLabel(p.score.respondentRole,locale))}</span><span>${e(date)}</span></div><p class="intro">${e(text(p.template.content.introduction,locale))}</p></header>
  ${syntheticTestNotice(p,locale)}${reportShowsDemo(p)?`<div class="demo"><strong>${e(t("演示报告 · 使用虚构题目与合成数据","示範報告 · 使用虛構題目與合成資料"))}</strong><br>${e(t("本示例没有临床常模，不代表任何真实孩子的心理健康评估结果。","本示例沒有臨床常模，不代表任何真實孩子的心理健康評估結果。"))}</div>`:""}
  ${p.score.risk?`<section class="risk">${reportHeading(t("请先关注安全","請先關注安全"),"report-safety","shield")}${p.score.riskMessages.map(m=>`<p>${e(text(m,locale))}</p>`).join("")}</section>`:""}
  ${p.score.status!=="valid"?`<p class="empty">${e(t("本次资料不完整。可以查看已具备必要答案的维度；未完成的部分不作结论。","本次資料不完整。可以查看已具備必要答案的維度；未完成的部分不作結論。"))}</p>`:""}
  ${reportDirectory(directory,locale)}${reportHeading(t("理解这一次的观察","理解這一次的觀察"),"report-observations","book")}<p class="meta">${e(text(p.scale.title,locale))} · ${e(text(p.score.norm.label,locale))}</p>${dimensions}
  ${reportHeading(t("家长可以尝试的下一步","家長可以嘗試的下一步"),"report-advice","compass")}${advice.length?advice.map((b,i)=>`<section class="advice"><h3>${reportIcon("compass")}<span>${i+1}. ${e(text(b.title,locale))}</span></h3><p>${e(text(b.body,locale))}</p><p class="meta">${e(t("依据维度","依據維度"))}：${e(b.dimensionKeys.map(key=>p.score.dimensions.find(d=>d.key===key)).filter(Boolean).map(d=>text(d!.label,locale)).join("、"))} · ${e(b.source)}</p></section>`).join(""):`<p>${e(t("资料不足，暂不生成个性化建议。可以先与服务人员一起确认测评是否完整。","資料不足，暫不生成個人化建議。可以先與服務人員一起確認測評是否完整。"))}</p>`}
  ${reportHeading(t("和上一次相比","和上一次相比"),"report-comparison","comparison")}${comparison}
  <section class="next">${reportHeading(p.score.risk?t("先获得适合的支持","先獲得適合的支持"):t("把理解带回日常","把理解帶回日常"),"report-next","leaf")}<p>${e(nextStep)}</p></section>
  <p class="limitation">${e(text(p.template.content.limitation,locale))}</p><footer>TopE 心理助手 · ${e(t("家庭私密报告，请妥善保管","家庭私密報告，請妥善保管"))}<br>${e(t("量表版本","量表版本"))} ${e(p.scale.version)} · ${e(t("建议库","建議庫"))} ${e(p.advice.version)} · ${e(t("报告模板","報告模板"))} ${e(p.template.version)} · ${e(p.generationMode==="ai"?t("AI 辅助组织建议，规则计分，自动发布","AI 輔助組織建議，規則計分，自動發佈"):t("专业规则模板，自动发布","專業規則模板，自動發佈"))}</footer></article></body></html>`;
}
