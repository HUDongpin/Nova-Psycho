"use client";
import { useRef } from "react";
import { ArrowRight, ClipboardText } from "@phosphor-icons/react";
import { api, isStaff, retryReportJob, type Assessment, type Family, type Locale, type Report, type ReportJob, type Role, type Workspace } from "./api";
import { copy, formatDate } from "./copy";
import { Badge, ErrorNotice, SectionHeading, useMutation } from "./ui";
import type { Route } from "./workspace-views";

export function reportsNewestFirst(reports: readonly Report[]): Report[] {
  const groups=new Map<string,{at:number;reports:Report[]}>();
  for(const report of reports){
    const key=report.revision?`${report.familyId}:${report.revision.roundId}`:report.id;
    const at=Date.parse(report.revision?.roundCreatedAt??report.createdAt);
    const group=groups.get(key)??{at,reports:[]};
    group.at=Math.max(group.at,at);group.reports.push(report);groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>b.at-a.at).flatMap(group=>group.reports.sort((a,b)=>(b.revision?.version??0)-(a.revision?.version??0)||Date.parse(b.createdAt)-Date.parse(a.createdAt)));
}
export function reportSourceLabel(roles: ReportJob["sourceRoles"], locale: Locale): string {
  const t = copy(locale);
  const labels = { parent: "sourceParent", student: "sourceStudent", teacher: "sourceTope" } as const;
  return t("reportSources").replace("{sources}", [...new Set(roles)].map(role => t(labels[role])).join("、"));
}
export function ReportRevisionLabel({ report, locale, latest }: { report: Report; locale: Locale; latest?: boolean }) {
  if (!report.revision) return null;
  const t = copy(locale);
  return <div className="report-revision-label" data-report-version={report.revision.version}>
    <div className="report-card-meta"><Badge tone="sage">{t("reportVersion").replace("{version}", String(report.revision.version))}</Badge>{latest !== undefined && <span>{t(latest ? "latestReport" : "reportHistory")}</span>}</div>
    <p className="small-text muted">{reportSourceLabel(report.revision.sourceRoles, locale)}</p>
    <p className="small-text muted">{t("generated")} {formatDate(report.revision.generatedAt, locale, true)}</p>
  </div>;
}

export function ReportJobNotice({ job, role, locale, hasPublishedReport, onRefresh }: { job: ReportJob; role: Role; locale: Locale; hasPublishedReport: boolean; onRefresh: () => Promise<void> }) {
  const t = copy(locale), mutation = useMutation(), active = useRef(false);
  if (job.state === "done") return null;
  const key = job.state === "failed" ? "updateFailed" : job.state === "paused" ? "updatePaused" : "updateGenerating";
  return <div className={job.state === "failed" ? "warning-note staged-report-job" : "staged-report-job"} role="status" data-report-job={job.id}>
    <strong>{t(key).replace("{version}", String(job.version))}</strong>
    <p className="small-text">{reportSourceLabel(job.sourceRoles, locale)}</p>
    {hasPublishedReport && <p>{t("previousReportAvailable")}</p>}
    {mutation.error && <ErrorNotice message={mutation.error} locale={locale} />}
    {isStaff(role) && job.canRetry && job.state === "failed" && <button type="button" className="button secondary small" data-testid="retry-report-job" disabled={mutation.busy} onClick={() => {
      if (active.current) return;
      active.current = true;
      void mutation.run(async () => { await retryReportJob(job.id, locale); await onRefresh(); }).finally(() => { active.current = false; });
    }}>{t(mutation.busy ? "retrying" : "retryReport")}</button>}
  </div>;
}

export function StaffObservationEntry({ family, role, assessments, locale, navigate, onRefresh }: { family: Family; role: Role; assessments: Assessment[]; locale: Locale; navigate: (route: Route) => void; onRefresh: () => Promise<void> }) {
  const t = copy(locale), mutation = useMutation(), active = useRef(false);
  if (role !== "staff" || !family.canStartStaffObservation) return null;
  const pending = assessments.some(item => item.roundId === family.activeRoundId && item.respondentContext === "tope_staff" && item.status === "pending");
  return <div className="staged-staff-entry">
    <p className="small-text muted">{t("staffObservationNote")}</p>
    {mutation.error && <ErrorNotice message={mutation.error} locale={locale} />}
    <button type="button" className="button secondary" data-testid="start-staff-observation" disabled={mutation.busy} onClick={() => {
      if (active.current) return;
      active.current = true;
      void mutation.run(async () => {
        const result = await api<{ id: string }>(`/api/families/${encodeURIComponent(family.id)}/staff-observation`, locale, { method: "POST", body: {} });
        await onRefresh(); navigate({ page: "assessment", id: result.id });
      }).finally(() => { active.current = false; });
    }}><ClipboardText />{t(mutation.busy ? "saving" : pending ? "resumeStaffObservation" : "startStaffObservation")}<ArrowRight /></button>
  </div>;
}

export function FamilyReportProgress({ family, workspace, locale, navigate, onRefresh }: { family: Family; workspace: Workspace; locale: Locale; navigate: (route: Route) => void; onRefresh: () => Promise<void> }) {
  if (family.reportWorkflow !== "parent_first_v1") return null;
  const t = copy(locale);
  const assessments = workspace.assessments.filter(item => item.familyId === family.id && item.roundId === family.activeRoundId);
  const roles = [ ["parent", "parentResponse"], ["student", "studentSupplement"], ["teacher", "topeObservation"] ] as const;
  const latestJob = [...(workspace.reportJobs ?? [])].filter(job => job.familyId === family.id && job.roundId === family.activeRoundId).sort((a, b) => b.version - a.version)[0];
  const earlierFailures = isStaff(workspace.user.role) ? (workspace.reportJobs ?? []).filter(job => job.familyId === family.id && job.roundId === family.activeRoundId && job.state === "failed" && job.id !== latestJob?.id) : [];
  return <section className="panel staged-family-progress">
    <SectionHeading title={t("familyProgress")} subtitle={t("stagedProgressNote")} />
    <ol className="staged-progress-list">{roles.map(([role, label]) => {
      const matching = assessments.filter(item => item.respondentRole === role || (role === "teacher" && item.respondentContext === "tope_staff"));
      const submitted = matching.some(item => item.status !== "pending");
      return <li key={role}><strong>{t(label)}</strong><Badge tone={submitted ? "sage" : "neutral"}>{t(submitted ? "submitted" : role === "parent" ? "parentPending" : matching.length ? "optionalPending" : "optionalLater")}</Badge></li>;
    })}</ol>
    <StaffObservationEntry family={family} role={workspace.user.role} assessments={assessments} locale={locale} navigate={navigate} onRefresh={onRefresh} />
    {latestJob && <ReportJobNotice job={latestJob} role={workspace.user.role} locale={locale} hasPublishedReport={workspace.reports.some(report => report.familyId === family.id && !report.privacyRefreshRequired)} onRefresh={onRefresh} />}
    {earlierFailures.map(job => <ReportJobNotice key={job.id} job={job} role={workspace.user.role} locale={locale} hasPublishedReport={workspace.reports.some(report => report.familyId === family.id && !report.privacyRefreshRequired)} onRefresh={onRefresh} />)}
  </section>;
}

export function WorkspaceReportUpdates({ workspace, locale, onRefresh }: { workspace: Workspace; locale: Locale; onRefresh: () => Promise<void> }) {
  const latestByRound = new Map<string, ReportJob>();
  for (const job of workspace.reportJobs ?? []) {
    const current = latestByRound.get(job.roundId);
    if (!current || current.version < job.version) latestByRound.set(job.roundId, job);
  }
  const updates = (workspace.reportJobs ?? []).filter(job => job.state !== "done" && (latestByRound.get(job.roundId)?.id === job.id || (isStaff(workspace.user.role) && job.state === "failed")));
  if (!updates.length) return null;
  return <div className="staged-report-updates">{updates.map(job => <section key={job.id} aria-label={workspace.families.find(family => family.id === job.familyId)?.familyName}>
    <strong>{workspace.families.find(family => family.id === job.familyId)?.familyName}</strong>
    <ReportJobNotice job={job} role={workspace.user.role} locale={locale} hasPublishedReport={workspace.reports.some(report => report.familyId === job.familyId && !report.privacyRefreshRequired)} onRefresh={onRefresh} />
  </section>)}</div>;
}
