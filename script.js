const sections = {
  work: {
    title: "Selected work is not online yet.",
    copy: "This section has been reserved for projects, papers, and prototypes.",
  },
  notes: {
    title: "Notes are not online yet.",
    copy: "This section has been reserved for writing and shorter notes.",
  },
  lab: {
    title: "The lab is not online yet.",
    copy: "This section has been reserved for experiments and interactive work.",
  },
  photos: {
    title: "Photographs are not online yet.",
    copy: "This section has been reserved for a small photo archive.",
  },
  links: {
    title: "Links are not online yet.",
    copy: "This section has been reserved for a collection of links.",
  },
  contact: {
    title: "The contact page is not online yet.",
    copy: "For now, email max.r.linder@hotmail.com.",
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

const siteConfig = window.MRLINDER_CONFIG || {};
const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
const animationsEnabled = siteConfig.animations !== false && !reduceMotion;

document.documentElement.dataset.animations = animationsEnabled ? "on" : "off";

const bootScreen = document.querySelector("[data-boot-screen]");

if (bootScreen) {
  if (!animationsEnabled || siteConfig.bootAnimation === false) {
    bootScreen.remove();
  } else {
    const bootDuration = Number(siteConfig.bootDurationMs) || 900;

    window.requestAnimationFrame(() => {
      bootScreen.classList.add("is-running");
    });

    window.setTimeout(() => {
      bootScreen.classList.add("is-finished");
      window.setTimeout(() => bootScreen.remove(), 180);
    }, bootDuration);
  }
}

const sidebar = document.querySelector(".site-sidebar");
const sidebarToggle = document.querySelector("[data-sidebar-toggle]");
const sidebarBackdrop = document.querySelector("[data-sidebar-backdrop]");
const mobileSidebar = window.matchMedia("(max-width: 760px)");

const setSidebarOpen = (open) => {
  document.body.classList.toggle("sidebar-open", open);
  sidebarToggle?.setAttribute("aria-expanded", String(open));
};

sidebarToggle?.addEventListener("click", () => {
  setSidebarOpen(!document.body.classList.contains("sidebar-open"));
});

sidebarBackdrop?.addEventListener("click", () => setSidebarOpen(false));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("sidebar-open")) {
    setSidebarOpen(false);
    sidebarToggle?.focus();
  }
});

sidebar?.querySelectorAll(".tree-link").forEach((link) => {
  link.addEventListener("click", () => {
    if (mobileSidebar.matches) setSidebarOpen(false);
  });
});

mobileSidebar.addEventListener("change", (event) => {
  if (!event.matches) setSidebarOpen(false);
});

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
