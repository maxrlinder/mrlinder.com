const sections = {
  work: {
    title: "Selected Work is still filing itself.",
    copy: "Projects, papers, and prototypes will live here once the folder has learned some manners.",
  },
  notes: {
    title: "The notebook is still blank.",
    copy: "Short notes, longer ideas, and the occasional useful diagram will arrive in a future update.",
  },
  lab: {
    title: "The Lab is warming up.",
    copy: "Small experiments and interactive oddities are being assembled behind this window.",
  },
  photos: {
    title: "The film is still developing.",
    copy: "A small photo archive will appear here. For now, imagine boats, Stockholm, and questionable framing.",
  },
  links: {
    title: "Bookmarks are being sorted.",
    copy: "A deliberately small collection of useful and interesting corners of the web is coming soon.",
  },
  contact: {
    title: "The desk is open by email.",
    copy: "A proper contact page is coming. Until then: max.r.linder@hotmail.com.",
  },
};

const colours = {
  orange: "#ef8b2c",
  yellow: "#f2cf42",
  green: "#51a469",
  blue: "#4589bd",
  violet: "#8062a7",
  brown: "#775043",
};

const dialog = document.querySelector(".placeholder-dialog");

if (dialog) {
  const title = dialog.querySelector("#dialog-title");
  const copy = dialog.querySelector("[data-dialog-copy]");
  const closeButtons = dialog.querySelectorAll(".dialog-close, .dialog-ok");

  document.querySelectorAll("[data-panel]").forEach((button) => {
    button.addEventListener("click", () => {
      const section = sections[button.dataset.panel];
      title.textContent = section.title;
      copy.textContent = section.copy;
      dialog.style.setProperty(
        "--dialog-colour",
        colours[button.dataset.colour],
      );
      dialog.showModal();
    });
  });

  closeButtons.forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });

  dialog.addEventListener("click", (event) => {
    const bounds = dialog.getBoundingClientRect();
    const isOutside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom;

    if (isOutside) dialog.close();
  });
}

document.querySelectorAll("[data-current-year]").forEach((node) => {
  node.textContent = new Date().getFullYear();
});

const timeNodes = document.querySelectorAll("[data-local-time]");

const updateClock = () => {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

  timeNodes.forEach((node) => {
    node.textContent = time;
  });
};

updateClock();
window.setInterval(updateClock, 60_000);
