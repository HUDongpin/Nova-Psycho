import type { AdviceBlock, TriadDomainKey } from "./types";
import { parseAdvice } from "./validation";
import { pair } from "./zh-pair";

// General prompts for a family conversation, not clinical interpretations or treatment.
// The content is frozen with each submitted assessment; AI may only order its IDs.
function block(domain: TriadDomainKey, title: string, body: string): AdviceBlock {
  return {
    id: `triad_${domain}`,
    title: pair(title),
    body: pair(body),
    source: "Nova original family-support examples, 2026-10 (nonclinical)",
    dimensionKeys: [],
    triadApplicability: { domainKeys: [domain], roles: ["student", "parent", "teacher"] }
  };
}

export const triadAdvice = parseAdvice({
  title: pair("三方了解说明"),
  blocks: [
    // Preserve this historical block without making it an ordering candidate.
    {
      id: "triad_context",
      title: pair("先看具体情境"),
      body: pair("这份报告把孩子、家长和老师的观察放在一起，不合成一个总分，也不做诊断。"),
      source: "Nova growth triad intake, 2026-10",
      dimensionKeys: ["cognition"]
    },
    block("cognition", "从一个容易开始的小任务谈起",
      "和孩子一起选一个具体的学习任务，问问哪一步容易开始、哪一步需要帮助。可以让孩子选择先试的一小步，再一起看看需要保留或调整什么，不把一次表现当成能力结论。"),
    block("connection", "留一段可以安心表达的时间",
      "选择双方都比较放松的时刻，先询问孩子是否愿意聊一聊。听完后，用自己的话确认是否理解，再询问孩子想要倾听、建议，还是一起解决一个具体问题；也允许孩子稍后再谈。"),
    block("guidance", "一起约定一个清楚的小安排",
      "围绕一件日常小事，和孩子一起说清楚要做什么、何时开始，以及需要什么帮助。给孩子可以选择的方式，事后一起回顾安排是否合适，不把讨论变成对孩子或家长的打分。"),
    block("curriculum", "一起查看任务与休息安排",
      "和孩子一起查看一天中学习、活动与休息的安排，选一个双方愿意讨论的地方。先听听哪些安排适合孩子，再商量是否需要调整一项任务或留出一段自主安排的时间。"),
    block("community", "确认可以联系的支持人",
      "和孩子一起确认，在家里、学校或日常活动中，遇到具体困难时可以找谁商量。需要家校沟通时，先说明要讨论的事情和希望得到的帮助，并在合适的范围内让孩子参与。"),
    block("state", "一起留意日常感受和休息",
      "在孩子愿意的时候，问问最近有哪些时刻感到轻松、疲惫或不舒服，以及希望大人怎样陪伴。可以一起记录简单的日常观察，避免仅凭一次回答作判断；如果困难持续或加重，联系合适的专业人员。"),
    block("impact", "把困难放回一个具体场景",
      "选一个日常生活中需要帮助的具体场景，听听孩子觉得哪里受到了影响，也分别了解家长和老师看到的情况。先商量一项可行的支持，再一起回顾是否合适，不急着把不同观察归为同一个原因。"),
    block("autonomy", "给孩子一个可以参与的决定",
      "选择一件适合孩子参与的日常决定，邀请孩子说出自己的想法、可选做法和需要的帮助。大人说明必要的边界，再一起商量可以尝试的下一步，不要求孩子一次确定所有未来方向。")
  ]
});
