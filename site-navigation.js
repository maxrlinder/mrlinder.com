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
    id: "blog",
    label: "Blog",
    href: "/blog/",
    accent: "orange",
    children: [{ label: "2026", href: "/blog/#2026" }],
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

// The trash can and the tired rat living in it, drawn as pixel sprites.
// Each sprite row is a string; every character is one pixel from the palette.
const ratPalette = {
  k: "#000",
  g: "#a9a9a9",
  l: "#dedede",
  d: "#6e6e6e",
  p: "#f3a3b4",
  w: "#fff",
};

const ratHead = [
  "....kkk........kkk....",
  "...kpppk......kpppk...",
  "...kpppkkkkkkkkpppk...",
  "...kppkggggggggkppk...",
  "....kkggggggggggkk....",
  "....kggggggggggggk....",
  "...kggggggggggggggk...",
  "...kggggggggggggggk...",
  "...kggggggggggggggk...",
  "...kgggllllllllgggk...",
  "kkkkkgllllllllllgkkkkk",
  "...kgllllllllllllgk...",
  "kk..kgllllppllllgk..kk",
  "....kllllkkkkllllk....",
  "....kgllllllllllgk....",
  "...kggggggggggggggk...",
  "...kggggggggggggggk...",
];

const ratEyesTired = [
  "ddd......ddd",
  ".kk......kk.",
  "..d......d..",
];

const ratEyesOpen = [
  ".kw......wk.",
  ".kk......kk.",
  ".kk......kk.",
  "..d......d..",
];

const ratPaws = [
  ".kk........kk.",
  "kggk......kggk",
  "k.k.k....k.k.k",
];

const spriteMarkup = (rows, x, y) =>
  rows
    .flatMap((row, dy) =>
      [...row.matchAll(/([^.])\1*/g)].map(
        (run) =>
          `<rect x="${x + run.index}" y="${y + dy}" width="${run[0].length}" height="1" fill="${ratPalette[run[1]]}"/>`,
      ),
    )
    .join("");

const trashMarkup = `
  <svg class="desktop-icon-image trash-art" width="32" height="32" viewBox="0 0 32 32" shape-rendering="crispEdges">
    <clipPath id="trash-rim"><rect x="-8" y="-16" width="48" height="25"/></clipPath>
    <g clip-path="url(#trash-rim)">
      <g class="trash-rat">
        <g class="trash-rat-head">
          ${spriteMarkup(ratHead, 5, -4)}
          <g class="trash-rat-eyes is-tired">${spriteMarkup(ratEyesTired, 10, 2)}</g>
          <g class="trash-rat-eyes is-open">${spriteMarkup(ratEyesOpen, 10, 1)}</g>
        </g>
      </g>
    </g>
    <path d="M7.5 9.5h17v21h-17z" fill="#fff" stroke="#000"/>
    <path d="M11.5 12v16M16.5 12v16M20.5 12v16" stroke="#000"/>
    <g class="trash-paws">${spriteMarkup(ratPaws, 9, 8)}</g>
    <g class="trash-lid">
      <path d="M12.5 6.5v-3h7v3" fill="none" stroke="#000"/>
      <rect x="5.5" y="6.5" width="21" height="3" fill="#fff" stroke="#000"/>
    </g>
  </svg>
`;

// Hover or click the trash and the rat peeks out, judges you, and goes back in.
const wireTrash = (trash) => {
  const motionAllowed = () =>
    document.documentElement.dataset.animations !== "off" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const peek = () => {
    if (!motionAllowed() || trash.classList.contains("is-peeking")) return;
    trash.classList.add("is-peeking");
  };

  trash.addEventListener("mouseenter", peek);
  trash.addEventListener("click", peek);
  trash.addEventListener("animationend", (event) => {
    if (event.animationName === "trash-lid") {
      trash.classList.remove("is-peeking");
    }
  });
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
          ${trashMarkup}
          <span class="desktop-icon-label">Trash</span>
        </span>
      </div>
    `;

    wireTrash(this.querySelector(".desktop-trash"));
  }
}

customElements.define("site-sidebar", SiteSidebar);
