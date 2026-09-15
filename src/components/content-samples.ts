type ContentKind = "advice" | "template";
const emptyText = () => ({ "zh-CN": "", "zh-HK": "" });

// Empty required fields deliberately fail validation until an administrator
// enters the actual professional content. This is a structure, not advice.
export function firstContentStructure(kind: ContentKind) {
  if (kind === "advice") {
    return {
      title: emptyText(),
      blocks: [{ id: "", title: emptyText(), body: emptyText(), source: "", dimensionKeys: [] }],
    };
  }
  return {
    title: emptyText(),
    introduction: emptyText(),
    limitation: emptyText(),
    nextStep: emptyText(),
  };
}
