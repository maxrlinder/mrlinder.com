const siteConfig = window.MRLINDER_CONFIG || {};
const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
const mobileSidebar = window.matchMedia("(max-width: 760px)");
const animationsEnabled = siteConfig.animations !== false && !reduceMotion;
const skipBootKey = "mrlinder:skip-next-boot";

document.documentElement.dataset.animations = animationsEnabled ? "on" : "off";

let skipBoot = false;

try {
  skipBoot = window.sessionStorage.getItem(skipBootKey) === "true";
  if (skipBoot) window.sessionStorage.removeItem(skipBootKey);
} catch {
  skipBoot = false;
}

document.querySelectorAll("[data-skip-boot]").forEach((link) => {
  link.addEventListener("click", () => {
    try {
      window.sessionStorage.setItem(skipBootKey, "true");
    } catch {
      // Navigation still works when session storage is unavailable.
    }
  });
});

const bootScreen = document.querySelector("[data-boot-screen]");
const skipMobileBoot =
  mobileSidebar.matches && siteConfig.bootOnMobile === false;

if (bootScreen) {
  if (
    !animationsEnabled ||
    siteConfig.bootAnimation === false ||
    skipBoot ||
    skipMobileBoot
  ) {
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

document.querySelectorAll("[data-tree-toggle]").forEach((button) => {
  const target = document.getElementById(button.getAttribute("aria-controls"));

  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    if (target) target.hidden = expanded;
  });
});

const sidebar = document.querySelector(".site-sidebar");
const sidebarToggle = document.querySelector("[data-sidebar-toggle]");
const sidebarBackdrop = document.querySelector("[data-sidebar-backdrop]");

const syncSidebarAvailability = (open) => {
  if (!sidebar) return;

  const hiddenOnMobile = mobileSidebar.matches && !open;
  sidebar.inert = hiddenOnMobile;

  if (mobileSidebar.matches) {
    sidebar.setAttribute("aria-hidden", String(hiddenOnMobile));
  } else {
    sidebar.removeAttribute("aria-hidden");
  }
};

const setSidebarOpen = (open) => {
  document.body.classList.toggle("sidebar-open", open);
  sidebarToggle?.setAttribute("aria-expanded", String(open));
  syncSidebarAvailability(open);
};

sidebarToggle?.addEventListener("click", () => {
  setSidebarOpen(!document.body.classList.contains("sidebar-open"));
});

sidebarBackdrop?.addEventListener("click", () => setSidebarOpen(false));

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    document.body.classList.contains("sidebar-open")
  ) {
    setSidebarOpen(false);
    sidebarToggle?.focus();
  }
});

sidebar?.querySelectorAll(".tree-link").forEach((link) => {
  link.addEventListener("click", () => {
    if (mobileSidebar.matches) setSidebarOpen(false);
  });
});

mobileSidebar.addEventListener("change", () => {
  setSidebarOpen(false);
});

syncSidebarAvailability(false);

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
