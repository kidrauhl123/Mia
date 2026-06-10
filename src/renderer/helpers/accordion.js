(function attachAccordionHelper(global) {
  "use strict";

  const runningAnimations = new WeakMap();
  const runningElementAnimations = new WeakMap();
  const ANIMATION_MS = 180;
  const EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";

  function prefersReducedMotion() {
    return Boolean(global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  }

  function accordionBody(details) {
    return details?.querySelector?.(":scope > .accordion-body") || null;
  }

  function managedDetailsFromEvent(event) {
    const summary = event.target?.closest?.("details.accordion-details > summary, details[data-accordion='true'] > summary");
    if (!summary) return null;
    return summary.parentElement;
  }

  function cleanup(details, body) {
    runningAnimations.delete(details);
    details.classList.remove("accordion-animating", "accordion-closing");
    if (!body) return;
    body.style.height = "";
    body.style.opacity = "";
    body.style.overflow = "";
  }

  function cleanupElement(element) {
    runningElementAnimations.delete(element);
    element.classList.remove("accordion-animating", "accordion-closing");
    element.style.height = "";
    element.style.opacity = "";
    element.style.overflow = "";
  }

  function setOpen(details, open) {
    const body = accordionBody(details);
    if (!details || !body) return;
    const nextOpen = Boolean(open);
    const previous = runningAnimations.get(details);
    if (previous) previous.cancel();
    if (prefersReducedMotion()) {
      details.open = nextOpen;
      cleanup(details, body);
      return;
    }

    if (nextOpen) {
      details.open = true;
      details.classList.add("accordion-animating");
      body.style.overflow = "hidden";
      body.style.height = "0px";
      body.style.opacity = "0";
      body.getBoundingClientRect();
      const endHeight = body.scrollHeight;
      const animation = body.animate(
        [
          { height: "0px", opacity: 0 },
          { height: `${endHeight}px`, opacity: 1 }
        ],
        { duration: ANIMATION_MS, easing: EASING }
      );
      runningAnimations.set(details, animation);
      animation.onfinish = () => cleanup(details, body);
      animation.oncancel = () => cleanup(details, body);
      return;
    }

    const startHeight = body.offsetHeight || body.scrollHeight;
    details.classList.add("accordion-animating", "accordion-closing");
    body.style.overflow = "hidden";
    body.style.height = `${startHeight}px`;
    body.style.opacity = "1";
    body.getBoundingClientRect();
    const animation = body.animate(
      [
        { height: `${startHeight}px`, opacity: 1 },
        { height: "0px", opacity: 0 }
      ],
      { duration: ANIMATION_MS, easing: EASING }
    );
    runningAnimations.set(details, animation);
    animation.onfinish = () => {
      details.open = false;
      cleanup(details, body);
    };
    animation.oncancel = () => cleanup(details, body);
  }

  function setElementOpen(element, open, options = {}) {
    if (!element) return;
    const hiddenClass = options.hiddenClass || "hidden";
    const nextOpen = Boolean(open);
    const previous = runningElementAnimations.get(element);
    if (previous) previous.cancel();
    if (prefersReducedMotion()) {
      element.classList.toggle(hiddenClass, !nextOpen);
      cleanupElement(element);
      return;
    }

    if (nextOpen) {
      element.classList.remove(hiddenClass);
      element.classList.add("accordion-animating");
      element.style.overflow = "hidden";
      element.style.height = "0px";
      element.style.opacity = "0";
      element.getBoundingClientRect();
      const endHeight = element.scrollHeight;
      const animation = element.animate(
        [
          { height: "0px", opacity: 0 },
          { height: `${endHeight}px`, opacity: 1 }
        ],
        { duration: ANIMATION_MS, easing: EASING }
      );
      runningElementAnimations.set(element, animation);
      animation.onfinish = () => cleanupElement(element);
      animation.oncancel = () => cleanupElement(element);
      return;
    }

    if (element.classList.contains(hiddenClass)) {
      cleanupElement(element);
      return;
    }
    const startHeight = element.offsetHeight || element.scrollHeight;
    element.classList.add("accordion-animating", "accordion-closing");
    element.style.overflow = "hidden";
    element.style.height = `${startHeight}px`;
    element.style.opacity = "1";
    element.getBoundingClientRect();
    const animation = element.animate(
      [
        { height: `${startHeight}px`, opacity: 1 },
        { height: "0px", opacity: 0 }
      ],
      { duration: ANIMATION_MS, easing: EASING }
    );
    runningElementAnimations.set(element, animation);
    animation.onfinish = () => {
      element.classList.add(hiddenClass);
      cleanupElement(element);
    };
    animation.oncancel = () => cleanupElement(element);
  }

  function onClick(event) {
    const details = managedDetailsFromEvent(event);
    if (!details || !accordionBody(details)) return;
    event.preventDefault();
    setOpen(details, !details.open);
  }

  document.addEventListener("click", onClick);

  global.miaAccordion = {
    setOpen,
    setElementOpen
  };
})(window);
