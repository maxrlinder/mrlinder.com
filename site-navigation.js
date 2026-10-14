const navigationItems = [
  {
    id: "home",
    label: "Home",
    href: "/",
    accent: "red",
    skipBoot: true,
    children: [],
  },
  {
    id: "cv",
    label: "Curriculum vitae",
    href: "/cv/",
    accent: "orange",
    children: [
      { label: "Experience", href: "/cv/#experience" },
      { label: "Education", href: "/cv/#education" },
      {
        label: "Publications, features & awards",
        href: "/cv/#selected",
      },
      {
        label: "Download CV",
        href: "/resources/CV_Max_R_Linder.pdf",
        download: true,
      },
    ],
  },
  {
    id: "about",
    label: "About",
    href: "/about/",
    accent: "violet",
    children: [
      { label: "Background", href: "/about/#background" },
      { label: "Studies", href: "/about/#studies" },
      { label: "Current work", href: "/about/#current-work" },
    ],
  },
  {
    id: "rl-environment",
    label: "RL environment",
    href: "/RL-environment/",
    accent: "green",
    children: [
      { label: "Plump", href: "/RL-environment/plump/" },
      { label: "Rummy", href: "/RL-environment/rummy/" },
    ],
  },
  {
    id: "contact",
    label: "Contact",
    href: "/contact/",
    accent: "red",
    children: [],
  },
];

const childMarkup = (child) => {
  const download = child.download ? " download" : "";

  return `
    <li>
      <a class="tree-link tree-child-link" href="${child.href}"${download}>
        <span class="file-icon" aria-hidden="true"></span>
        <span>${child.label}</span>
      </a>
    </li>
  `;
};

const itemMarkup = (item, currentPage) => {
  const current = item.id === currentPage;
  const hasChildren = item.children.length > 0;
  const submenuId = `tree-${item.id}-children`;
  const directLinkAttributes = [
    current ? 'aria-current="page"' : "",
    item.skipBoot ? "data-skip-boot" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const disclosure = hasChildren
    ? `
      <button
        class="tree-expander"
        type="button"
        aria-label="Show ${item.label} subcategories"
        aria-controls="${submenuId}"
        aria-expanded="${current ? "true" : "false"}"
        data-tree-toggle
      >
        <span aria-hidden="true">▸</span>
      </button>
    `
    : '<span class="tree-expander-spacer" aria-hidden="true"></span>';

  const children = hasChildren
    ? `
      <ul class="tree-children" id="${submenuId}"${current ? "" : " hidden"}>
        ${item.children.map(childMarkup).join("")}
      </ul>
    `
    : "";

  return `
    <li class="tree-entry">
      <div class="tree-row">
        ${disclosure}
        <a
          class="tree-link tree-parent-link${current ? " is-current" : ""}"
          href="${item.href}"
          ${directLinkAttributes}
        >
          <span class="folder-icon tree-${item.accent}" aria-hidden="true"></span>
          <span>${item.label}</span>
        </a>
      </div>
      ${children}
    </li>
  `;
};

class SiteSidebar extends HTMLElement {
  connectedCallback() {
    const currentPage = this.getAttribute("current") || "";
    const items = navigationItems
      .map((item) => itemMarkup(item, currentPage))
      .join("");

    this.innerHTML = `
      <header class="menubar">
        <a
          class="menubar-logo"
          href="/"
          aria-label="Go to the home page"
          data-skip-boot
        >
          <span class="system-mark" aria-hidden="true"></span>
        </a>
        <a class="menubar-title" href="/" data-skip-boot>mrlinder.com</a>
        <button
          class="menubar-toggle"
          type="button"
          aria-controls="site-directory"
          aria-expanded="false"
          data-sidebar-toggle
        >
          Directory
        </button>
        <span class="menubar-clock" title="Local time in Stockholm" data-local-time
          >--:--</span
        >
      </header>
      <div class="sidebar-backdrop" data-sidebar-backdrop></div>
      <aside class="site-sidebar" id="site-directory" aria-label="Site directory">
        <div class="window-titlebar">
          <span class="window-control"></span>
          <strong>mrlinder.com</strong>
          <span class="window-control window-control-double"></span>
        </div>
        <div class="finder-info">
          <span>${navigationItems.length} items</span>
          <span>Stockholm, SE</span>
        </div>
        <nav class="directory-tree" aria-label="Directory tree">
          <ul class="tree-root">${items}</ul>
        </nav>
      </aside>
      <div class="desktop-icons">
        <a class="desktop-icon" href="/" data-skip-boot>
          <span class="desktop-icon-image icon-disk" aria-hidden="true"></span>
          <span class="desktop-icon-label">mrlinder.com</span>
        </a>
        <a class="desktop-icon" href="/resources/CV_Max_R_Linder.pdf" download>
          <span class="desktop-icon-image icon-document" aria-hidden="true"></span>
          <span class="desktop-icon-label">CV.pdf</span>
        </a>
      </div>
      <div class="desktop-trash" aria-hidden="true">
        <span class="desktop-icon">
          <span class="desktop-icon-image icon-trash"></span>
          <span class="desktop-icon-label">Trash</span>
        </span>
      </div>
    `;
  }
}

customElements.define("site-sidebar", SiteSidebar);
