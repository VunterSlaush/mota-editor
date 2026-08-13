import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type HostRect, tooltipPlacement } from "./tooltipPlacement";

/**
 * How long the pointer must rest before a tooltip appears. The native
 * one waits about a second — long enough that the app feels unhelpful on
 * every icon-only button it has.
 */
const SHOW_DELAY_MS = 150;

/** Where the title goes while we are showing it ourselves. */
const STASH_ATTRIBUTE = "data-mota-title";
const STASH_KEY = "motaTitle";

interface Tip {
  readonly text: string;
  readonly host: HostRect;
}

/**
 * UI — draws every `title` in the app itself, instead of waiting on the
 * platform's own tooltip.
 *
 * Mounted once, at the root: it watches the pointer and takes over any
 * element carrying a `title`, so the sixty-odd controls that already
 * have one need no change and none can be forgotten. The attribute is
 * moved out of the way while the tooltip is up (or the platform would
 * draw a second one on top of ours) and put back the moment the pointer
 * leaves, which keeps it available to assistive technology the rest of
 * the time.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const release = () => {
      clearTimeout(timer);
      restoreTitle(hostRef.current);
      hostRef.current = null;
      setTip(null);
    };

    const onPointerMove = (event: MouseEvent) => {
      // elementFromPoint, not event.target: a disabled button fires no
      // pointer events, and those are exactly the controls whose title
      // explains why they are disabled.
      const under = document.elementFromPoint(event.clientX, event.clientY);
      if (hostRef.current?.contains(under)) return; // still on the same host
      const host = titledAncestor(under);
      if (host === hostRef.current) return;
      release();
      if (!host) return;
      hostRef.current = host;
      timer = setTimeout(() => {
        const text = stashTitle(host);
        if (text) setTip({ text, host: host.getBoundingClientRect() });
      }, SHOW_DELAY_MS);
    };

    document.addEventListener("mousemove", onPointerMove);
    // A click, a scroll or the pointer leaving the window all mean the
    // thing the tooltip described may no longer be under it.
    document.addEventListener("mousedown", release);
    document.addEventListener("mouseleave", release);
    window.addEventListener("scroll", release, true);
    window.addEventListener("blur", release);
    return () => {
      release();
      document.removeEventListener("mousemove", onPointerMove);
      document.removeEventListener("mousedown", release);
      document.removeEventListener("mouseleave", release);
      window.removeEventListener("scroll", release, true);
      window.removeEventListener("blur", release);
    };
  }, []);

  // Placed after it is drawn, because where it goes depends on how big
  // it turned out — measured, then positioned, before the browser paints.
  useLayoutEffect(() => {
    const element = tipRef.current;
    if (!tip || !element) return;
    const { left, top } = tooltipPlacement(
      tip.host,
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.visibility = "visible";
  }, [tip]);

  if (!tip) return null;
  return (
    <div className="tooltip" role="tooltip" ref={tipRef}>
      {tip.text}
    </div>
  );
}

/** The nearest thing with something to say, ours or not yet ours. */
function titledAncestor(element: Element | null): HTMLElement | null {
  const found = element?.closest(`[title], [${STASH_ATTRIBUTE}]`);
  return found instanceof HTMLElement ? found : null;
}

/** Take the title off the element and hand it over. */
function stashTitle(host: HTMLElement): string {
  const title = host.getAttribute("title") ?? host.dataset[STASH_KEY] ?? "";
  if (!title) return "";
  host.dataset[STASH_KEY] = title;
  host.removeAttribute("title");
  return title;
}

function restoreTitle(host: HTMLElement | null) {
  const stashed = host?.dataset[STASH_KEY];
  if (!host || stashed === undefined) return;
  host.setAttribute("title", stashed);
  delete host.dataset[STASH_KEY];
}
