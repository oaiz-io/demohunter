(() => {
  const slides = Array.from(document.querySelectorAll(".slide"));
  const prevButton = document.querySelector('[data-nav="prev"]');
  const nextButton = document.querySelector('[data-nav="next"]');

  if (slides.length === 0 || !(prevButton instanceof HTMLButtonElement) || !(nextButton instanceof HTMLButtonElement)) {
    return;
  }

  let activeIndex = 0;

  function setActive(nextIndex) {
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= slides.length) {
      return;
    }

    activeIndex = nextIndex;

    for (const [index, slide] of slides.entries()) {
      const isActive = index === activeIndex;
      slide.classList.toggle("active", isActive);
      slide.setAttribute("data-active", isActive ? "true" : "false");
      slide.setAttribute("aria-hidden", isActive ? "false" : "true");
    }

    prevButton.disabled = activeIndex === 0;
    nextButton.disabled = activeIndex === slides.length - 1;
    prevButton.setAttribute("aria-disabled", prevButton.disabled ? "true" : "false");
    nextButton.setAttribute("aria-disabled", nextButton.disabled ? "true" : "false");
  }

  prevButton.addEventListener("click", () => {
    setActive(activeIndex - 1);
  });

  nextButton.addEventListener("click", () => {
    setActive(activeIndex + 1);
  });

  setActive(0);
})();
