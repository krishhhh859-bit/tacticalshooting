/**
 * PARA SF: FOREST ACCURACY - UI Collision Detection Diagnostic Utility
 * Inspects bounding rectangles of visible interactive elements to ensure
 * zero overlapping UI controls across all supported viewport resolutions.
 */

export function checkUICollisions(container = document.body) {
  const interactiveSelectors = [
    '#btn-hud-home',
    '#btn-mobile-home',
    '.hud-top-bar',
    '#hud-solo-actions',
    '#btn-finish-solo',
    '#camera-aim-widget',
    '.camera-aim-btn',
    '.hud-bottom-right',
    '.mobile-top-bar',
    '.btn-top-action',
    '.mobile-buttons-cluster',
    '.mobile-btn',
    '#joystick-zone',
    '#tutorial-panel',
    '#tutorial-complete-box',
    '.modal-card:not(.hidden)',
    '.lobby-actions',
    '#character-viewer-container'
  ];

  const elements = [];
  const seen = new Set();
  interactiveSelectors.forEach(sel => {
    const list = container.querySelectorAll(sel);
    list.forEach(el => {
      if (seen.has(el)) return;
      // Check if element is genuinely visible
      const style = window.getComputedStyle(el);
      if (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        !el.classList.contains('hidden') &&
        el.offsetParent !== null
      ) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 2 && rect.height > 2) {
          seen.add(el);
          elements.push({
            el,
            selector: sel,
            id: el.id || el.className.split(' ')[0],
            rect
          });
        }
      }
    });
  });

  const collisions = [];

  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i];
      const b = elements[j];

      // Ignore parent-child ancestors
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;

      // Check rectangle intersection
      const overlapX = Math.max(0, Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left));
      const overlapY = Math.max(0, Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top));

      // Consider it a real collision if overlap area is significant (> 10px)
      if (overlapX > 6 && overlapY > 6) {
        collisions.push({
          elementA: a.id,
          elementB: b.id,
          overlapX,
          overlapY,
          rectA: { left: a.rect.left, top: a.rect.top, width: a.rect.width, height: a.rect.height },
          rectB: { left: b.rect.left, top: b.rect.top, width: b.rect.width, height: b.rect.height }
        });
      }
    }
  }

  if (collisions.length > 0) {
    console.warn(`[UI COLLISION CHECK] Detected ${collisions.length} overlapping UI element(s):`, collisions);
  } else {
    console.log('[UI COLLISION CHECK] PASS: Zero overlapping UI elements detected.');
  }

  return collisions;
}

if (typeof window !== 'undefined') {
  window.checkUICollisions = checkUICollisions;
}
