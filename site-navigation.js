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
      <div class="mobile-toolbar">
        <a
          class="mobile-home-button"
          href="/"
          aria-label="Go to the home page"
          data-skip-boot
        >
          <span class="system-mark" aria-hidden="true"></span>
        </a>
        <button
          class="sidebar-toggle"
          type="button"
          aria-controls="site-directory"
          aria-expanded="false"
          data-sidebar-toggle
        >
          <span class="toggle-lines" aria-hidden="true"></span>
          Directory
        </button>
      </div>
      <div class="sidebar-backdrop" data-sidebar-backdrop></div>
      <aside class="site-sidebar" id="site-directory" aria-label="Site directory">
        <div class="sidebar-menubar">
          <a
            class="sidebar-home-link"
            href="/"
            aria-label="Go to the home page"
            data-skip-boot
          >
            <span class="system-mark" aria-hidden="true"></span>
          </a>
          <strong>mrlinder.com</strong>
        </div>
        <div class="window-titlebar">
          <span class="window-control"></span>
          <strong>Directory</strong>
          <span class="window-control window-control-double"></span>
        </div>
        <nav class="directory-tree" aria-label="Directory tree">
          <div class="tree-drive-row">
            <span class="drive-icon" aria-hidden="true"></span>
            <strong>mrlinder.com</strong>
          </div>
          <ul class="tree-root">${items}</ul>
        </nav>
        <div class="sidebar-status">
          <span><span class="status-light" aria-hidden="true"></span>online</span>
          <span data-local-time>--:--</span>
        </div>
      </aside>
    `;
  }
}

customElements.define("site-sidebar", SiteSidebar);
