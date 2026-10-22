/** Keep questionnaire controls in the visible area when a phone keyboard
 * shrinks VisualViewport without resizing the page's layout viewport. */
export function bindSurveyViewport(root: HTMLElement, onKeyboardChange: (open: boolean) => void): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => undefined;
  let frame = 0, reveal = false, open = false;
  let observedActions: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  const properties = ["--survey-keyboard-inset", "--survey-visual-height", "--survey-actions-height"];
  const clear = (notify = true) => {
    observer?.disconnect(); observedActions = null;
    delete root.dataset.keyboardOpen;
    for (const name of properties) root.style.removeProperty(name);
    if (open && notify) onKeyboardChange(false);
    open = false;
  };
  const update = () => {
    frame = 0;
    const focused = document.activeElement;
    const editable = root.contains(focused) && (focused instanceof HTMLTextAreaElement ||
      (focused instanceof HTMLInputElement && /^(text|search|tel|email|url|password|number)$/.test(focused.type))) && !focused.readOnly && !focused.disabled;
    const actions = root.querySelector<HTMLElement>("[data-survey-actions]");
    const layoutHeight = document.documentElement.clientHeight;
    const keyboard = window.matchMedia("(max-width: 1023px)").matches && Math.abs(viewport.scale - 1) < 0.01 &&
      layoutHeight - viewport.height > 120 && (editable || open);
    if (!keyboard || !actions) { clear(); reveal = false; return; }
    // Retain the toolbar through focusout/pointerup so tapping Next cannot
    // move its hit target before the click is delivered. Viewport restoration
    // clears it; pinch zoom and small browser-chrome changes do not opt in.
    root.dataset.keyboardOpen = "true";
    if (observedActions !== actions) { observer?.disconnect(); observer?.observe(actions); observedActions = actions; }
    root.style.setProperty("--survey-keyboard-inset", `${Math.max(0, layoutHeight - viewport.offsetTop - viewport.height)}px`);
    root.style.setProperty("--survey-visual-height", `${viewport.height}px`);
    root.style.setProperty("--survey-actions-height", `${actions.getBoundingClientRect().height}px`);
    if (!open) { open = true; onKeyboardChange(true); schedule(true); }
    if (reveal && editable) {
      const top = viewport.offsetTop + 12;
      const bottom = viewport.offsetTop + viewport.height - actions.getBoundingClientRect().height - 12;
      const control = focused.closest(".sd-comment")?.getBoundingClientRect();
      const box = control && control.height <= bottom - top ? control : focused.getBoundingClientRect();
      const delta = box.top < top ? box.top - top : box.bottom > bottom ? box.bottom - bottom : 0;
      if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: "instant" });
    }
    reveal = false;
  };
  const schedule = (showInput: boolean) => {
    reveal ||= showInput;
    if (!frame) frame = requestAnimationFrame(update);
  };
  const resize = () => schedule(true);
  const scroll = () => schedule(false);
  if (typeof ResizeObserver !== "undefined") observer = new ResizeObserver(resize);
  root.addEventListener("focusin", resize);
  viewport.addEventListener("resize", resize);
  viewport.addEventListener("scroll", scroll);
  window.addEventListener("resize", resize);
  schedule(false);
  return () => {
    cancelAnimationFrame(frame);
    root.removeEventListener("focusin", resize);
    viewport.removeEventListener("resize", resize);
    viewport.removeEventListener("scroll", scroll);
    window.removeEventListener("resize", resize);
    clear(false);
  };
}
