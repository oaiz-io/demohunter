(() => {
  const sections = Array.from(document.querySelectorAll("[data-section-id]"));

  if (sections.length === 0) {
    return;
  }

  document.documentElement.classList.add("motion-ready");
  const ratios = new Map();

  function updateCurrentSection() {
    let current = null;
    let bestRatio = 0;
    for (const section of sections) {
      const ratio = ratios.get(section) ?? 0;
      if (ratio > bestRatio) {
        current = section;
        bestRatio = ratio;
      }
    }
    for (const section of sections) {
      section.setAttribute("data-current", section === current ? "true" : "false");
    }
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      ratios.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
      if (entry.isIntersecting && entry.intersectionRatio >= 0.18) {
        entry.target.setAttribute("data-reveal-state", "visible");
      }
    }
    updateCurrentSection();
  }, {
    root: null,
    rootMargin: "-12% 0px -12% 0px",
    threshold: [0, 0.18, 0.35, 0.6],
  });

  for (const section of sections) {
    ratios.set(section, 0);
    observer.observe(section);
  }
})();
