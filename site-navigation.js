const navigationItems = [
  {
    id: "home",
    label: "Home",
    href: "/",
    kind: "file",
  },
  {
    id: "cv",
    label: "Curriculum vitae",
    href: "/cv/",
    kind: "file",
    accent: "red",
  },
  {
    label: "Work",
    kind: "folder",
    accent: "orange",
    children: [{ label: "Selected work", panel: "work" }],
  },
  {
    label: "Notes",
    kind: "folder",
    accent: "yellow",
    children: [{ label: "Notes & writing", panel: "notes" }],
  },
  {
    label: "Lab",
    kind: "folder",
    accent: "green",
    children: [{ label: "Experiments", panel: "lab" }],
  },
  {
    label: "Photographs",
    kind: "folder",
    accent: "blue",
    children: [{ label: "Photo archive", panel: "photos" }],
  },
  {
    label: "Links",
    kind: "folder",
    accent: "violet",
    children: [{ label: "Bookmarks", panel: "links" }],
  },
  {
    label: "Contact",
    kind: "folder",
    accent: "brown",
    children: [
      {
        label: "Email",
        href: "mailto:max.r.linder@hotmail.com",
      },
    ],
  },
];

const fileMarkup = (item, currentPage) => {
  const current = item.id === currentPage;
  const classes = ["tree-link", current ? "is-current" : ""]
    .filter(Boolean)
    .join(" ");
  const accent = item.accent ? ` tree-${item.accent}` : "";

  if (item.panel) {
    return `
      <li>
        <button class="${classes}" type="button" data-panel="${item.panel}">
          <span class="file-icon${accent}" aria-hidden="true"></span>
          <span>${item.label}</span>
        </button>
      </li>
    `;
  }

  return `
    <li>
      <a class="${classes}" href="${item.href}"${current ? ' aria-current="page"' : ""}>
        <span class="file-icon${accent}" aria-hidden="true"></span>
        <span>${item.label}</span>
      </a>
    </li>
  `;
};

const itemMarkup = (item, currentPage) => {
  if (item.kind !== "folder") return fileMarkup(item, currentPage);

  const children = item.children
    .map((child) => fileMarkup(child, currentPage))
    .join("");

  return `
    <li>
      <details class="tree-folder">
        <summary>
          <span class="disclosure" aria-hidden="true"></span>
          <span class="folder-icon tree-${item.accent}" aria-hidden="true"></span>
          <span>${item.label}</span>
        </summary>
        <ul>${children}</ul>
      </details>
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
      <div class="sidebar-backdrop" data-sidebar-backdrop></div>
      <aside class="site-sidebar" id="site-directory" aria-label="Site directory">
        <div class="sidebar-menubar">
          <span class="system-mark" aria-hidden="true"></span>
          <strong>mrlinder.com</strong>
        </div>
        <div class="window-titlebar">
          <span class="window-control"></span>
          <strong>Directory</strong>
          <span class="window-control window-control-double"></span>
        </div>
        <nav class="directory-tree" aria-label="Directory tree">
          <ul class="tree-root">
            <li>
              <details class="tree-folder root-folder" open>
                <summary>
                  <span class="disclosure" aria-hidden="true"></span>
                  <span class="drive-icon" aria-hidden="true"></span>
                  <span>mrlinder.com</span>
                </summary>
                <ul>${items}</ul>
              </details>
            </li>
          </ul>
        </nav>
        <div class="sidebar-status">
          <span><span class="status-light" aria-hidden="true"></span>online</span>
          <span data-local-time>--:--</span>
        </div>
      </aside>
      <dialog class="placeholder-dialog" aria-labelledby="dialog-title">
        <div class="dialog-bar">
          <span>mrlinder.com</span>
          <button class="dialog-close" type="button" aria-label="Close">×</button>
        </div>
        <div class="dialog-body">
          <span class="dialog-icon" aria-hidden="true">i</span>
          <div>
            <h2 id="dialog-title">This page is not online yet.</h2>
            <p data-dialog-copy>
              This section is reserved for a later version of the website.
            </p>
            <button class="dialog-ok" type="button">OK</button>
          </div>
        </div>
      </dialog>
    `;
  }
}

customElements.define("site-sidebar", SiteSidebar);
