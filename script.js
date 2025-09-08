(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    // 1) Keyboard focus style toggle
    let usingKeyboard = false;
    const setMode = (flag) => {
      usingKeyboard = flag;
      document.documentElement.classList.toggle('using-keyboard', usingKeyboard);
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') setMode(true);
    });
    document.addEventListener('mousedown', () => setMode(false));
    document.addEventListener('touchstart', () => setMode(false), { passive: true });

    // 2) Prefetch support
    const prefetched = new Set();
    const supportsPrefetch = (() => {
      const link = document.createElement('link');
      try { return link.relList && link.relList.supports && link.relList.supports('prefetch'); }
      catch { return false; }
    })();

    function prefetch(href) {
      if (!supportsPrefetch || !href || prefetched.has(href)) return;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = href;
      link.as = 'document';
      document.head.appendChild(link);
      prefetched.add(href);
    }

    // If we're on the homepage, opportunistically prefetch the two main targets.
    const isHome = !!document.querySelector('.cta-grid');
    if (isHome) {
      prefetch('talk.html');
      prefetch('lounge.html');
    }

    // 3) Make the big CTAs feel like buttons (Space triggers)
    const ctas = document.querySelectorAll('a.cta');
    ctas.forEach((a) => {
      // Prefetch on hover/focus
      const target = a.getAttribute('href');
      a.addEventListener('mouseenter', () => prefetch(target));
      a.addEventListener('focus', () => prefetch(target), true);

      // Space to "click" (Enter already works natively on anchors)
      a.addEventListener('keydown', (e) => {
        const isSpace = e.code === 'Space' || e.key === ' ';
        if (isSpace) {
          e.preventDefault();
          a.click();
        }
      });
    });

    // 4) Segmented Message/Video switch keyboard UX (left/right arrows)
    //    This does NOT sync state itself; your talk.html inline script handles that.
    const seg = document.querySelector('.segSwitch');
    if (seg) {
      const modeMsg = document.getElementById('modeMsg');
      const modeVid = document.getElementById('modeVid');

      seg.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();

        // Determine current and toggle accordingly
        const msgActive = modeMsg && modeMsg.checked;
        if (e.key === 'ArrowRight' && msgActive && modeVid) {
          modeVid.click();
          modeVid.focus();
        } else if (e.key === 'ArrowLeft' && !msgActive && modeMsg) {
          modeMsg.click();
          modeMsg.focus();
        }
      });
    }
  });
})();