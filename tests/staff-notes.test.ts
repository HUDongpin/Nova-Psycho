// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { Family, Workspace } from "../src/components/api";
import { FamilyView, staffNoteKey } from "../src/components/workspace-views";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const family: Family = {
  id: "f", familyName: "合成家庭", childName: "合成孩子", age: 12, birthDate: "2014-01-01", grade: "小学", region: "CN",
  guardianLabel: "家长", assignedTo: "other", createdAt: "2026-01-01T00:00:00Z", consent: true, members: [], canInviteMembers: false
};

function workspace(notes: Workspace["staffNotes"]): Workspace {
  return {
    user: { id: "staff", name: "工作人员", role: "staff", region: "CN" }, region: "CN", mode: "demo", families: [family],
    assessments: [], reports: [], scales: [], goals: [], observations: [], staff: [], contentVersions: [], alerts: [], staffNotes: notes, summary: {}
  };
}

function element(notes: Workspace["staffNotes"]) {
  return createElement(FamilyView, { family, workspace: workspace(notes), locale: "zh-CN", navigate() {}, openForm() {}, async onRefresh() {}, openPrivacy() {} });
}

function noteValues(host: ParentNode) {
  return [...host.querySelectorAll("article")].map(article => article.querySelectorAll("p")[1]?.textContent);
}

describe("staff notes", () => {
  let root: Root | undefined;
  afterEach(() => {
    root?.unmount();
    root = undefined;
    document.body.replaceChildren();
  });

  async function renderUpdated(notes: Workspace["staffNotes"], refreshed: Workspace["staffNotes"]) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createRoot(host);
    root = view;
    await act(async () => { view.render(element(notes)); });
    await act(async () => { view.render(element(refreshed)); });
    return noteValues(host);
  }

  it("renders both notes when a reassessment repeats the item stem", async () => {
    const label = "请记录客观事实、发生时间、频率、最近一次和已采取措施";
    const notes = [
      { familyId: "f", assessmentId: "round-1", itemId: "t16", label, value: "第一次客观记录" },
      { familyId: "f", assessmentId: "round-2", itemId: "t16", label, value: "第二次客观记录" }
    ];
    expect(staffNoteKey(notes[0], 0)).toBe("round-1:t16");
    expect(staffNoteKey(notes[1], 1)).toBe("round-2:t16");
    const html = renderToStaticMarkup(element(notes));
    expect(html.split(label).length - 1).toBe(2);
    expect(html).toContain("第一次客观记录");
    expect(html).toContain("第二次客观记录");
    const refreshed = [{ familyId: "f", assessmentId: "round-3", itemId: "q40", label: "联系方式", value: "新的工作人员备注" }, ...notes];
    await expect(renderUpdated(notes, refreshed)).resolves.toEqual(["新的工作人员备注", "第一次客观记录", "第二次客观记录"]);
  });

  it("renders both notes when the source id is missing and the label repeats", async () => {
    expect(staffNoteKey({ assessmentId: "", itemId: "" }, 0)).toBe("staff-note:0");
    expect(staffNoteKey({ assessmentId: "", itemId: "t16" }, 1)).toBe("staff-note:1");
    const label = "同一题干";
    const notes = [
      { familyId: "f", assessmentId: "", itemId: "", label, value: "甲记录" },
      { familyId: "f", assessmentId: "", itemId: "", label, value: "乙记录" }
    ];
    const refreshed = [{ familyId: "f", assessmentId: "round-3", itemId: "q40", label: "联系方式", value: "新的工作人员备注" }, ...notes];
    await expect(renderUpdated(notes, refreshed)).resolves.toEqual(["新的工作人员备注", "甲记录", "乙记录"]);
  });

  it("renders submitted intake responses grouped by respondent and period for staff",()=>{
    const data=workspace([]);
    data.staffIntakeResponses=[{familyId:"f",assessmentId:"short-1",role:"student",submittedAt:"2026-10-23T01:02:00Z",sections:[{title:"过去两周",items:[{itemId:"c13_1",label:"最近的感受",responses:["不愿回答"]},{itemId:"c22",label:"希望的小变化",responses:["PRIVATE_STUDENT_INTAKE"]}]}]}];
    const html=renderToStaticMarkup(createElement(FamilyView,{family,workspace:data,locale:"zh-CN",navigate(){},openForm(){},async onRefresh(){},openPrivacy(){}}));
    expect(html).toContain("问卷答复（仅工作人员可见）");
    expect(html).toContain("过去两周");
    expect(html).toContain("PRIVATE_STUDENT_INTAKE");
    expect(html).toContain("不愿回答");
    expect(html).toContain("<summary>");
    expect(html).not.toContain("textarea");
  });

  it("never renders private intake responses for a parent or a different family",()=>{
    const data=workspace([]);
    data.staffIntakeResponses=[{familyId:"other",assessmentId:"other-1",role:"student",submittedAt:"2026-10-23T01:02:00Z",sections:[{title:"Private",items:[{itemId:"c22",label:"Private",responses:["OTHER_FAMILY_INTAKE"]}]}]}];
    const render=()=>renderToStaticMarkup(createElement(FamilyView,{family,workspace:data,locale:"zh-CN",navigate(){},openForm(){},async onRefresh(){},openPrivacy(){}}));
    expect(render()).not.toContain("OTHER_FAMILY_INTAKE");
    data.user.role="parent";
    data.staffIntakeResponses[0].familyId="f";
    expect(render()).not.toContain("OTHER_FAMILY_INTAKE");
    expect(render()).not.toContain("问卷答复（仅工作人员可见）");
  });
});
