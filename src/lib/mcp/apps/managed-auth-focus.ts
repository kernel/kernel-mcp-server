import { useEffect } from "react";

const EDITABLE_FIELD_SELECTOR = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])',
  "textarea:not([disabled]):not([readonly])",
  "select:not([disabled])",
].join(",");

export function useManagedAuthAutofocus(rootId = "root") {
  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root || typeof MutationObserver === "undefined") return;

    let focusFrame: number | null = null;
    const focusFirstEditableField = () => {
      focusFrame = null;
      const active = document.activeElement;
      if (
        active instanceof Element &&
        root.contains(active) &&
        active.matches(EDITABLE_FIELD_SELECTOR)
      ) {
        return;
      }
      const fields = root.querySelectorAll<HTMLElement>(
        EDITABLE_FIELD_SELECTOR,
      );
      const firstVisible = [...fields].find(
        (field) => field.getClientRects().length > 0,
      );
      firstVisible?.focus({ preventScroll: true });
    };

    const observer = new MutationObserver((mutations) => {
      const addedEditableField = mutations.some((mutation) =>
        [...mutation.addedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches(EDITABLE_FIELD_SELECTOR) ||
              node.querySelector(EDITABLE_FIELD_SELECTOR) !== null),
        ),
      );
      if (addedEditableField && focusFrame === null) {
        focusFrame = window.requestAnimationFrame(focusFirstEditableField);
      }
    });
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    };
  }, [rootId]);
}
