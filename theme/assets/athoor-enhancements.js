// Athoor London — Sticky Header + Mobile Marquee Fix + Enhancements
(function() {
  'use strict';

  // ---- Bulletproof Sticky Header ----
  function initStickyHeader() {
    var header = document.getElementById('shopify-section-headers');
    if (!header) return;
    var headerHeight = header.offsetHeight;
    var threshold = headerHeight;
    var isFixed = false;
    var spacer = null;

    function makeFixed() {
      if (isFixed) return;
      isFixed = true;
      headerHeight = header.offsetHeight;
      if (!spacer) {
        spacer = document.createElement('div');
        spacer.className = 'athoor-header-spacer';
        spacer.style.height = headerHeight + 'px';
        header.parentNode.insertBefore(spacer, header.nextSibling);
      }
      spacer.style.display = 'block';
      header.classList.add('athoor-fixed');
    }
    function makeNormal() {
      if (!isFixed) return;
      isFixed = false;
      if (spacer) spacer.style.display = 'none';
      header.classList.remove('athoor-fixed');
    }
    function onScroll() {
      var st = window.pageYOffset || document.documentElement.scrollTop;
      if (st > threshold) makeFixed(); else makeNormal();
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', function() { if (!isFixed) headerHeight = header.offsetHeight; }, { passive: true });
    onScroll();
  }

  // ---- Mobile Marquee: capture original, rebuild as clean 2x loop ----
  var marqueeOriginalHTML = null;

  function captureMarquee() {
    var wrapper = document.querySelector('.maqruee-section-wrapper .marquee-wrapper');
    if (wrapper && marqueeOriginalHTML === null) {
      marqueeOriginalHTML = wrapper.innerHTML;
    }
  }

  function buildMobileMarquee() {
    if (window.innerWidth > 749) return;
    var wrapper = document.querySelector('.maqruee-section-wrapper .marquee-wrapper');
    if (!wrapper || marqueeOriginalHTML === null) return;
    // Rebuild: original set duplicated exactly twice for seamless -50% scroll
    wrapper.innerHTML = marqueeOriginalHTML + marqueeOriginalHTML;
    wrapper.classList.add('athoor-marquee-mobile');
  }

  // ---- Smooth scroll to reviews ----
  function initReviewScroll() {
    var badges = document.querySelectorAll('.jdgm-prev-badge');
    badges.forEach(function(b) {
      b.style.cursor = 'pointer';
      b.addEventListener('click', function() {
        var w = document.querySelector('.jdgm-rev-widg');
        if (w) w.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }





  // ---- Mobile: Hide green notification bar that overlaps sticky header ----
  function hideGreenBarMobile() {
    if (window.innerWidth > 749) return;
    // Look for the green notification element at the top of the page
    // It's typically the first visible element before the rewards banner
    var body = document.body;
    var children = body.children;
    var rewardsBanner = body.querySelector('.athoor-rewards-banner');
    
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      // Skip known elements
      if (el.classList.contains('athoor-rewards-banner')) break;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') continue;
      if (el.id === 'shopify-section-headers' || el.id === 'MainContent') continue;
      if (el.classList.contains('skip-to-content-link')) continue;
      if (el.classList.contains('mobile-menu') || el.classList.contains('mobile-menu-overlay')) continue;
      if (el.classList.contains('wl-drawer') || el.id === 'WishlistDrawer') continue;
      if (el.id === 'club-popup' || el.id === 'horse-cursor') continue;
      if (el.id === 'preloader') continue;
      
      // Check if it's a small bar-like element with green/dark-green background
      var style = window.getComputedStyle(el);
      var bg = style.backgroundColor;
      var h = el.offsetHeight;
      
      // If it's a small element (under 60px tall) at the top, likely the notification bar
      if (h > 0 && h < 60 && el.offsetWidth > 100) {
        // Check for green-ish background
        if (bg && (bg.indexOf('34, 139') > -1 || bg.indexOf('46, 125') > -1 || bg.indexOf('76, 175') > -1 || bg.indexOf('56, 142') > -1 || bg.indexOf('30, 130') > -1 || bg.indexOf('40, 167') > -1 || bg.indexOf('0, 128') > -1 || bg.indexOf('34, 87') > -1 || bg.indexOf('27, 94') > -1)) {
          el.style.display = 'none';
          return;
        }
        // Also check if it has a green-colored child/descendant
        var innerBg = el.querySelector('div, span, p');
        if (innerBg) {
          var innerStyle = window.getComputedStyle(innerBg);
          var innerColor = innerStyle.backgroundColor;
          if (innerColor && (innerColor.indexOf('34, 139') > -1 || innerColor.indexOf('46, 125') > -1 || innerColor.indexOf('76, 175') > -1)) {
            el.style.display = 'none';
            return;
          }
        }
      }
    }
    
    // Fallback: find any fixed/absolute positioned element with green background at top
    var allFixed = document.querySelectorAll('div[style*="position"]');
    allFixed.forEach(function(el) {
      if (el.id === 'club-popup' || el.id === 'WishlistDrawer' || el.id === 'horse-cursor') return;
      var rect = el.getBoundingClientRect();
      if (rect.top < 5 && rect.height < 60 && rect.height > 0 && rect.width > 100) {
        var bg = window.getComputedStyle(el).backgroundColor;
        if (bg && (bg.indexOf('34, 139') > -1 || bg.indexOf('46, 125') > -1 || bg.indexOf('76, 175') > -1 || bg.indexOf('56, 142') > -1 || bg.indexOf('30, 130') > -1 || bg.indexOf('40, 167') > -1)) {
          el.style.display = 'none';
        }
      }
    });
  }

  function init() {
    captureMarquee();
    initStickyHeader();
    initReviewScroll();
    hideGreenBarMobile();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Rebuild marquee AFTER theme JS has run (theme clones on window load)
  window.addEventListener('load', function() {
    setTimeout(buildMobileMarquee, 400);
    // Re-check for green bar after apps have loaded
    setTimeout(hideGreenBarMobile, 1000);
    setTimeout(hideGreenBarMobile, 3000);
  });

})();
