const navigationItems = [
  {
    id: "home",
    label: "Home",
    href: "/",
    icon: "mac",
    skipBoot: true,
    children: [],
  },
  {
    id: "cv",
    label: "Curriculum vitae",
    href: "/cv/",
    icon: "briefcase",
    children: [
      { label: "Experience", href: "/cv/#experience", icon: "briefcase" },
      { label: "Education", href: "/cv/#education", icon: "cap" },
      {
        label: "Publications, features & awards",
        href: "/cv/#selected",
        icon: "medal",
      },
      {
        label: "Download CV",
        href: "/resources/CV_Max_R_Linder.pdf",
        download: true,
        icon: "download",
      },
    ],
  },
  {
    id: "about",
    label: "About",
    href: "/about/",
    icon: "person",
    children: [
      { label: "Background", href: "/about/#background", icon: "picture" },
      { label: "Studies", href: "/about/#studies", icon: "book" },
      { label: "Current work", href: "/about/#current-work", icon: "monitor" },
    ],
  },
  {
    id: "rl-environment",
    label: "RL environment",
    href: "/RL-environment/",
    icon: "cards",
    children: [
      { label: "Plump", href: "/RL-environment/plump/", icon: "spade" },
      { label: "Rummy", href: "/RL-environment/rummy/", icon: "diamond" },
    ],
  },
  {
    id: "blog",
    label: "Blog",
    href: "/blog/",
    icon: "notepad",
    children: [{ label: "2026", href: "/blog/#2026", icon: "calendar" }],
  },
  {
    id: "contact",
    label: "Contact",
    href: "/contact/",
    icon: "envelope",
    children: [],
  },
];

// Pixel sprites: each row is a string, each character one pixel from the palette.
const pixelPalette = {
  k: "#000",
  w: "#fff",
  l: "#dedede",
  g: "#a9a9a9",
  d: "#6e6e6e",
  p: "#f3a3b4",
  r: "#c73b32",
  o: "#db7a25",
  y: "#d9b829",
  Y: "#f6e39a",
  G: "#3e8a50",
  M: "#9fd3a8",
  b: "#3276a7",
  B: "#a9cdea",
  v: "#725393",
  V: "#b7a2d4",
  n: "#6d4a3d",
  N: "#a8795f",
  s: "#f2c9a0",
  e: "#ebe5d3",
  L: "#ccccff",
  z: "#17351f",
};

const spriteMarkup = (rows, x, y) =>
  rows
    .flatMap((row, dy) =>
      [...row.matchAll(/([^.])\1*/g)].map(
        (run) =>
          `<rect x="${x + run.index}" y="${y + dy}" width="${run[0].length}" height="1" fill="${pixelPalette[run[1]]}"/>`,
      ),
    )
    .join("");

// One 16 × 16 icon per directory entry, in the spirit of the Mac OS 9 Apple menu.
const treeIcons = {
  mac: [
    "..kkkkkkkkkkkk..",
    "..keeeeeeeeeek..",
    "..kekkkkkkkkek..",
    "..kekLLLLLLkek..",
    "..kekLkLLkLkek..",
    "..kekLLLkLLkek..",
    "..kekLLkkLLkek..",
    "..kekLkLLkLkek..",
    "..kekLLkkLLkek..",
    "..kekkkkkkkkek..",
    "..keeeeeeeeeek..",
    "..keeeeeekkkek..",
    "..keeeeeeeeeek..",
    "..kkkkkkkkkkkk..",
    "...kggggggggk...",
    "...kkkkkkkkkk...",
  ],
  briefcase: [
    "................",
    "................",
    ".....kkkkkk.....",
    ".....k....k.....",
    ".kkkkkkkkkkkkkk.",
    ".kNNNNNNNNNNNNk.",
    ".knnnnnnnnnnnnk.",
    ".knnnnnnnnnnnnk.",
    ".kkkkkkyykkkkkk.",
    ".knnnnnyynnnnnk.",
    ".knnnnnnnnnnnnk.",
    ".knnnnnnnnnnnnk.",
    ".knnnnnnnnnnnnk.",
    ".kkkkkkkkkkkkkk.",
  ],
  person: [
    "................",
    "......kkkk......",
    ".....knnnnk.....",
    "....knnnnnnk....",
    "....knssssnk....",
    "....kskssksk....",
    "....kssssssk....",
    "....ksskkssk....",
    ".....kssssk.....",
    "......kssk......",
    "...kkkvvvvkkk...",
    "..kVVvvvvvvvvk..",
    ".kVvvvvvvvvvvvk.",
    ".kvvvvvvvvvvvvk.",
    ".kvvvvvvvvvvvvk.",
    ".kkkkkkkkkkkkkk.",
  ],
  cards: [
    "..kkkkkkk.......",
    "..kGMGMGk.......",
    "..kMGMGMk.......",
    "..kGMGkkkkkkkk..",
    "..kMGMkwwwwwwk..",
    "..kGMGkrwwwwwk..",
    "..kMGMkwwwwwwk..",
    "..kGMGkwrwrwwk..",
    "..kMGMkrrrrrwk..",
    "..kGMGkwrrrwwk..",
    "..kkkkkwwrwwwk..",
    "......kwwwwwwk..",
    "......kwwwwwrk..",
    "......kwwwwwwk..",
    "......kkkkkkkk..",
  ],
  notepad: [
    "................",
    ".kkkkkkkkkkk....",
    ".kdwdwdwdwdk....",
    ".kkkkkkkkkkk....",
    ".kYYYYYYYYYk....",
    ".kYBBBBBBBYk....",
    ".kYYYYYYYYYk....",
    ".kYBBBBBBBYk....",
    ".kYYYYYYYYYk....",
    ".kYBBBBBYYYk....",
    ".kYYYYYYYYYk....",
    ".kYBBBBYYYYk....",
    ".kYYYYYYYYYk....",
    ".kkkkkkkkkkk....",
  ],
  pencil: [
    "......kk",
    ".....kpk",
    "....kgk.",
    "...kyk..",
    "..kyk...",
    ".kyk....",
    "kNk.....",
    "kk......",
  ],
  envelope: [
    "................",
    "................",
    "................",
    ".kkkkkkkkkkkkkk.",
    ".kkeeeeeeeeeekk.",
    ".kekeeeeeeeekek.",
    ".keekeeeeeekeek.",
    ".keeekeeeekeeek.",
    ".keeeekeekeeeek.",
    ".keeeeerreeeeek.",
    ".keeeeerreeeeek.",
    ".keeeeeeeeeeeek.",
    ".kkkkkkkkkkkkkk.",
  ],
  cap: [
    "................",
    "................",
    "................",
    ".......kk.......",
    ".....kkddkk.....",
    "...kkddddddkk...",
    ".kkddddddddddkk.",
    "...kkddddddkky..",
    "....kkkddkkk.y..",
    "....kddddddk.y..",
    "....kddddddk.yy.",
    "....kkkkkkkk.yy.",
  ],
  medal: [
    "................",
    "...kkk....kkk...",
    "...krrk..kbbk...",
    "....krrkkbbk....",
    ".....krrbbk.....",
    "......kkkk......",
    ".....kyyyyk.....",
    "....kyYYYyyk....",
    "...kyYyyyyyyk...",
    "...kyYyyyyyyk...",
    "...kyyyyyyyyk...",
    "...kyyyyyyyok...",
    "....kyyyyook....",
    ".....kkkkkk.....",
  ],
  document: [
    "kkkkkkkk....",
    "kwwwwwwkk...",
    "kwwwwwwklk..",
    "kwwwwwwkllk.",
    "kwwwwwwkkkkk",
    "kwwwwwwwwwwk",
    "kwggggggggwk",
    "kwwwwwwwwwwk",
    "kwggggggggwk",
    "kwwwwwwwwwwk",
    "kwggggggggwk",
    "kwwwwwwwwwwk",
    "kwgggggwwwwk",
    "kwwwwwwwwwwk",
    "kkkkkkkkkkkk",
  ],
  arrow: [
    "..kkk..",
    "..kbk..",
    "..kbk..",
    "kkkbkkk",
    ".kbbbk.",
    "..kbk..",
    "...k...",
  ],
  picture: [
    "................",
    "................",
    ".kkkkkkkkkkkkkk.",
    ".kBBBBBBBByyBBk.",
    ".kBBBBBBBByyBBk.",
    ".kBBBBkBBBBBBBk.",
    ".kBBBkwkBBBBBBk.",
    ".kBBkgggkBBkBBk.",
    ".kBkgggggkkgkBk.",
    ".kkgggggggggggk.",
    ".kGGGGGGGGGGGGk.",
    ".kGGGGGGGGGGGGk.",
    ".kkkkkkkkkkkkkk.",
  ],
  book: [
    "................",
    "................",
    "................",
    "..kkkk....kkkk..",
    ".kwwwwkkkkwwwwk.",
    ".kwggwwkkwwggwk.",
    ".kwwwwwkkwwwwwk.",
    ".kwgggwkkwgggwk.",
    ".kwwwwwkkwwwwwk.",
    ".kwggwwkkwwggwk.",
    ".kwwwwwkkwwwwwk.",
    ".kkkkwwkkwwkkkk.",
    ".kbbbbkkkkbbbbk.",
    ".kkkkkkkkkkkkkk.",
  ],
  monitor: [
    "................",
    ".kkkkkkkkkkkkkk.",
    ".kllllllllllllk.",
    ".klkkkkkkkkkklk.",
    ".klkzzzzzzzzklk.",
    ".klkzMzzzzzzklk.",
    ".klkzzMzzzzzklk.",
    ".klkzMzzMMMzklk.",
    ".klkzzzzzzzzklk.",
    ".klkkkkkkkkkklk.",
    ".kllllllllllllk.",
    ".kkkkkkkkkkkkkk.",
    "......kllk......",
    "....kkkkkkkk....",
    "....kllllllk....",
    "....kkkkkkkk....",
  ],
  spade: [
    "................",
    "...kkkkkkkkkk...",
    "...kkwwwwwwwk...",
    "...kwwwwwwwwk...",
    "...kwwwkkwwwk...",
    "...kwwkkkkwwk...",
    "...kwkkkkkkwk...",
    "...kwkkkkkkwk...",
    "...kwkkwwkkwk...",
    "...kwwwkkwwwk...",
    "...kwwkkkkwwk...",
    "...kwwwwwwwwk...",
    "...kwwwwwwwwk...",
    "...kwwwwwwwkk...",
    "...kkkkkkkkkk...",
  ],
  diamond: [
    "................",
    "...kkkkkkkkkk...",
    "...krwwwwwwwk...",
    "...kwwwwwwwwk...",
    "...kwwwrrwwwk...",
    "...kwwrrrrwwk...",
    "...kwrrrrrrwk...",
    "...kwrrrrrrwk...",
    "...kwwrrrrwwk...",
    "...kwwwrrwwwk...",
    "...kwwwwwwwwk...",
    "...kwwwwwwwwk...",
    "...kwwwwwwwwk...",
    "...kwwwwwwwrk...",
    "...kkkkkkkkkk...",
  ],
  calendar: [
    "................",
    "....k......k....",
    ".kkkkkkkkkkkkkk.",
    ".krrrrrrrrrrrrk.",
    ".krrrrrrrrrrrrk.",
    ".kkkkkkkkkkkkkk.",
    ".kwwwwwwwwwwwwk.",
    ".kwgwgwgwgwgwwk.",
    ".kwwwwwwwwwwwwk.",
    ".kwgwgwgwrwgwwk.",
    ".kwwwwwwwwwwwwk.",
    ".kwgwgwgwgwwwwk.",
    ".kwwwwwwwwwwwwk.",
    ".kkkkkkkkkkkkkk.",
  ],
};

// Icons built from more than one sprite: [sprite, x, y] layers, back to front.
const treeIconLayers = {
  notepad: [["notepad", 0, 0], ["pencil", 8, 5]],
  download: [["document", 1, 1], ["arrow", 9, 9]],
};

const treeIconMarkup = (name) => {
  const layers = treeIconLayers[name] || [[name, 0, 0]];
  const pixels = layers
    .map(([sprite, x, y]) => spriteMarkup(treeIcons[sprite], x, y))
    .join("");

  return `<svg class="tree-icon" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">${pixels}</svg>`;
};

const childMarkup = (child) => {
  const download = child.download ? " download" : "";

  return `
    <li>
      <a class="tree-link tree-child-link" href="${child.href}"${download}>
        ${treeIconMarkup(child.icon)}
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
          ${treeIconMarkup(item.icon)}
          <span>${item.label}</span>
        </a>
      </div>
      ${children}
    </li>
  `;
};

// The trash can and the tired rat living in it, drawn with the same pixel sprites.
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
