/*
 * Global presentation controls.
 * Set animations to false to disable every animation on the site.
 */
window.MRLINDER_CONFIG = Object.freeze({
  animations: true,
  bootAnimation: true,
  bootOnMobile: false,
  bootDurationMs: 900,
});

document.documentElement.dataset.animations =
  window.MRLINDER_CONFIG.animations === false ? "off" : "on";
