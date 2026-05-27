(function () {
  const root = document.documentElement;
  const body = document.body;
  const story = document.querySelector(".workflow-section");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stageSteps = Array.from(document.querySelectorAll("[data-stage-target]"));
  const revealItems = Array.from(document.querySelectorAll("[data-reveal]"));
  const stageTitle = document.querySelector("[data-stage-title]");
  const stageSubtitle = document.querySelector("[data-stage-subtitle]");
  const stageStatus = document.querySelector("[data-stage-status]");
  const stagePermission = document.querySelector("[data-stage-permission]");

  const stageCopy = {
    select: {
      title: "选择 Fellow",
      subtitle: "Model, owner and permission mode are visible",
      status: "Ready",
      permission: "identity visible"
    },
    route: {
      title: "路由任务",
      subtitle: "Cloud conversation mention routes back to owner desktop",
      status: "Routing",
      permission: "owner desktop"
    },
    approve: {
      title: "权限确认",
      subtitle: "Claude Sonnet 4.6 / Codex",
      status: "Bridge online",
      permission: "ask before shell"
    },
    reply: {
      title: "同步结果",
      subtitle: "Reply returns to the same cloud conversation",
      status: "Synced",
      permission: "conversation message"
    }
  };

  let scrollFrame = 0;
  let pointerFrame = 0;
  let pendingPointer = null;

  root.classList.add("js-enabled");

  function updateScrollProgress() {
    scrollFrame = 0;
    const maxScroll = Math.max(1, root.scrollHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, window.scrollY / maxScroll));
    body.style.setProperty("--landing-scroll", progress.toFixed(4));
    updateScrollStageFromPosition();
  }

  function requestScrollUpdate() {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(updateScrollProgress);
  }

  function activateStage(target) {
    const copy = stageCopy[target] || stageCopy.approve;
    stageSteps.forEach((step) => {
      step.classList.toggle("is-active", step.dataset.stageTarget === target);
    });
    if (stageTitle) stageTitle.textContent = copy.title;
    if (stageSubtitle) stageSubtitle.textContent = copy.subtitle;
    if (stageStatus) stageStatus.textContent = copy.status;
    if (stagePermission) stagePermission.textContent = copy.permission;
  }

  function updateScrollStageFromPosition() {
    if (!story || stageSteps.length === 0) return;
    const start = story.offsetTop - window.innerHeight * 0.48;
    const end = story.offsetTop + story.offsetHeight + window.innerHeight * 0.42;
    const range = Math.max(1, end - start);
    const progress = Math.min(0.999, Math.max(0, (window.scrollY - start) / range));
    const index = Math.min(stageSteps.length - 1, Math.floor(progress * stageSteps.length));
    activateStage(stageSteps[index].dataset.stageTarget);
  }

  function setupStageObserver() {
    if (!story || !("IntersectionObserver" in window)) {
      updateScrollStageFromPosition();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) updateScrollStageFromPosition();
      },
      { rootMargin: "-24% 0px -46% 0px", threshold: [0.2, 0.45, 0.7] }
    );

    observer.observe(story);
  }

  function setupRevealObserver() {
    if (!("IntersectionObserver" in window)) {
      revealItems.forEach((item) => item.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.16 }
    );

    revealItems.forEach((item) => observer.observe(item));
  }

  function applyPointer() {
    pointerFrame = 0;
    if (!pendingPointer) return;
    body.style.setProperty("--pointer-x", pendingPointer.x.toFixed(4));
    body.style.setProperty("--pointer-y", pendingPointer.y.toFixed(4));
  }

  function onPointerMove(event) {
    if (reduceMotion.matches) return;
    const x = event.clientX / Math.max(1, window.innerWidth) - 0.5;
    const y = event.clientY / Math.max(1, window.innerHeight) - 0.5;
    pendingPointer = { x, y };
    if (!pointerFrame) pointerFrame = window.requestAnimationFrame(applyPointer);
  }

  window.addEventListener("scroll", requestScrollUpdate, { passive: true });
  window.addEventListener("resize", requestScrollUpdate);
  window.addEventListener("pointermove", onPointerMove, { passive: true });

  updateScrollProgress();
  updateScrollStageFromPosition();
  setupStageObserver();
  setupRevealObserver();
})();
