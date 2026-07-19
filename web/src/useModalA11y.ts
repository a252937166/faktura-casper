import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Minimal dialog accessibility for the site's overlays: Escape closes, focus
 * moves in on open and returns to the opener on close, Tab cycles inside the
 * container, and the page behind stops scrolling. Attach the returned ref to
 * the dialog container and give it role="dialog" aria-modal="true".
 */
export function useModalA11y<T extends HTMLElement>(active: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;

    // Move focus in (prefer an explicit close button so Escape's sibling is
    // announced first; fall back to the first focusable, then the container).
    const focusables = () =>
      el ? [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((f) => f.offsetParent) : [];
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0] ?? el;
    first?.focus?.();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key === "Tab" && el) {
        const items = focusables();
        if (!items.length) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [active]);

  return ref;
}
