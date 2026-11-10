/**
 * Prelude Custom Badges Runtime v2.3.0
 * Supports multiple custom badges per user, auto-proxying of icons,
 * React Fiber & DOM user-id inspection, dynamic badge injection into profile popouts and modals,
 * and sync with Postgres backend.
 */
(() => {
  if (window.__preludeBadgesLoaded) return;
  window.__preludeBadgesLoaded = true;

  // --- Native-style tooltip (steals Fluxer's tooltip class at runtime) ---
  let _ttEl = null, _ttArrow = null;
  function _getTooltipClass() {
    // Find an existing Fluxer tooltip element to steal its class
    const existing = document.querySelector('[class*="tooltip_"][class*="tooltipContent"]') ||
                     document.querySelector('[class*="Tooltip_tooltip"]') ||
                     document.querySelector('[class*="tooltip__"]');
    return existing ? existing.className : null;
  }
  function _ensureTooltip() {
    if (_ttEl) return;
    _ttEl = document.createElement('div');
    _ttEl.setAttribute('data-encora-tooltip', '');
    // Arrow element
    _ttArrow = document.createElement('div');
    Object.assign(_ttArrow.style, {
      position: 'absolute', bottom: '-4px', left: '50%', transform: 'translateX(-50%)',
      width: '0', height: '0',
      borderLeft: '5px solid transparent',
      borderRight: '5px solid transparent',
      borderTop: '5px solid var(--background-floating, #18191c)',
    });
    _ttEl.appendChild(_ttArrow);
    Object.assign(_ttEl.style, {
      position: 'fixed', zIndex: '99999', pointerEvents: 'none',
      backgroundColor: 'var(--background-floating, #18191c)',
      color: 'var(--header-primary, #f2f3f5)',
      fontSize: '14px', lineHeight: '20px', fontWeight: '500',
      padding: '8px 12px', borderRadius: '5px',
      boxShadow: 'var(--shadow-high, 0 4px 12px rgba(0,0,0,.35))',
      whiteSpace: 'nowrap', fontFamily: 'var(--font-primary, inherit)',
      opacity: '0', transition: 'opacity .15s ease',
    });
    document.body.appendChild(_ttEl);
  }
  function _showTooltip(text, anchor) {
    _ensureTooltip();
    _ttEl.childNodes[0] !== _ttArrow && _ttEl.prepend(_ttArrow);
    // Try to steal native class for pixel-perfect match
    const nativeClass = _getTooltipClass();
    if (nativeClass) _ttEl.className = nativeClass;
    // Set text (after class steal since that may clear children)
    const textNode = _ttEl.querySelector('[data-encora-text]') || (() => {
      const n = document.createElement('span');
      n.setAttribute('data-encora-text', '');
      _ttEl.appendChild(n);
      return n;
    })();
    textNode.textContent = text;
    _ttEl.style.display = 'block';
    requestAnimationFrame(() => {
      const r = anchor.getBoundingClientRect(), t = _ttEl.getBoundingClientRect();
      const top = r.top - t.height - 10;
      const left = r.left + r.width / 2 - t.width / 2;
      _ttEl.style.top = Math.max(4, top) + 'px';
      _ttEl.style.left = Math.max(4, Math.min(left, window.innerWidth - t.width - 4)) + 'px';
      _ttEl.style.opacity = '1';
    });
  }
  function _hideTooltip() {
    if (_ttEl) { _ttEl.style.opacity = '0'; setTimeout(() => { if (_ttEl) _ttEl.style.display = 'none'; }, 150); }
  }

  const badgeMap = new Map(); // userId -> Array<Badge>
  const usernameMap = new Map(); // lowercase username/display name -> userId
  let isLoaded = false;

  function remoteLog(action, details) {
    try {
      fetch('/custom-badges/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, details, url: window.location.href, ts: Date.now() })
      }).catch(() => {});
    } catch (e) {}
  }

  remoteLog('SCRIPT_INIT_V2_3', { ua: navigator.userAgent });

  async function loadBadges() {
    try {
      const res = await fetch('/custom-badges/badges.json?t=' + Date.now(), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      badgeMap.clear();
      usernameMap.clear();

      for (const [userId, badges] of Object.entries(data)) {
        const badgeList = Array.isArray(badges) ? badges : [badges];
        badgeMap.set(String(userId), badgeList);
        for (const b of badgeList) {
          if (b.username) {
            usernameMap.set(b.username.toLowerCase(), String(userId));
          }
        }
      }
      isLoaded = true;
      remoteLog('BADGES_LOADED', { count: badgeMap.size });
      processAll();
    } catch (err) {
      remoteLog('LOAD_ERROR', { error: err.message });
      setTimeout(loadBadges, 10000);
    }
  }

  // --- Discovery Categories Synchronization ---
  const categoryMap = new Map(); // id -> { id, name, isDefault, hidden }
  const visibleCategoryIds = new Set();
  let categoriesLoaded = false;

  const DEFAULT_CATEGORIES = [
    { id: 0, defaultName: 'Gaming', aliases: ['gaming'] },
    { id: 1, defaultName: 'Music', aliases: ['music'] },
    { id: 2, defaultName: 'Entertainment', aliases: ['entertainment'] },
    { id: 3, defaultName: 'Education', aliases: ['education'] },
    { id: 4, defaultName: 'Science & technology', aliases: ['science & technology', 'science and technology'] },
    { id: 5, defaultName: 'Content creator', aliases: ['content creator'] },
    { id: 6, defaultName: 'Anime & manga', aliases: ['anime & manga', 'anime and manga'] },
    { id: 7, defaultName: 'Movies & TV', aliases: ['movies & tv', 'movies and tv', 'movies & television'] },
    { id: 8, defaultName: 'Other', aliases: ['other'] }
  ];

  async function loadDiscoveryCategories() {
    try {
      const res = await fetch('/custom-badges/categories.json?t=' + Date.now(), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (Array.isArray(data)) {
        categoryMap.clear();
        visibleCategoryIds.clear();
        for (const cat of data) {
          categoryMap.set(cat.id, cat);
          if (!cat.hidden) {
            visibleCategoryIds.add(cat.id);
          }
        }
        categoriesLoaded = true;
        syncDiscoveryCategoriesInDOM();
      }
    } catch (e) {
      setTimeout(loadDiscoveryCategories, 10000);
    }
  }

  function matchCategoryIdFromText(rawText) {
    if (!rawText) return null;
    const clean = rawText.trim().toLowerCase();

    // Check custom/renamed categories first
    for (const [id, cat] of categoryMap.entries()) {
      if (cat.name && cat.name.trim().toLowerCase() === clean) {
        return id;
      }
    }

    // Check defaults
    for (const spec of DEFAULT_CATEGORIES) {
      if (spec.aliases.includes(clean)) {
        return spec.id;
      }
    }
    return null;
  }

  function syncDiscoveryCategoriesInDOM() {
    if (!categoriesLoaded) return;

    // 1. Sync closed Combobox Input and Value Overlay in Guild Settings -> Discovery tab
    const categoryLabel = document.querySelector('[data-flx="guild.guild-tabs.guild-discovery-tab.field-label--2"]');
    if (categoryLabel) {
      const container = categoryLabel.closest('[data-flx="guild.guild-tabs.guild-discovery-tab.div--2"]') || categoryLabel.parentElement;
      if (container) {
        const input = container.querySelector('[data-flx="ui.form.combobox.input"]');
        const overlay = container.querySelector('[data-flx="ui.form.combobox.value-overlay"]');

        const currentText = (overlay && overlay.textContent.trim()) || (input && input.value.trim()) || '';
        const catId = matchCategoryIdFromText(currentText);
        if (catId !== null && categoryMap.has(catId)) {
          const targetName = categoryMap.get(catId).name;
          if (overlay && overlay.textContent !== targetName) {
            overlay.textContent = targetName;
          }
          if (input && input.value !== targetName) {
            input.value = targetName;
          }
        }
      }
    }

    // 2. Sync any open Combobox Popups (dropdown options list)
    const popups = document.querySelectorAll('[data-flx="ui.form.combobox.popup"]');
    for (const popup of popups) {
      const items = popup.querySelectorAll('[data-flx="ui.form.combobox.item"]');
      if (items.length === 0) continue;

      // Verify if this popup is for discovery categories
      let isCategoryPopup = false;
      for (const item of items) {
        const textEl = item.querySelector('[data-flx="ui.form.combobox.item-text"]');
        const text = textEl ? textEl.textContent.trim() : item.textContent.trim();
        if (matchCategoryIdFromText(text) !== null) {
          isCategoryPopup = true;
          break;
        }
      }
      if (!isCategoryPopup) continue;

      // Process and filter each item in the category combobox
      for (const item of items) {
        const textEl = item.querySelector('[data-flx="ui.form.combobox.item-text"]');
        if (!textEl) continue;
        const text = textEl.textContent.trim();
        const catId = matchCategoryIdFromText(text);
        if (catId === null) continue;

        if (!visibleCategoryIds.has(catId)) {
          // Category is hidden: hide it from the dropdown options
          item.style.setProperty('display', 'none', 'important');
        } else {
          // Category is visible: ensure visible and apply custom rename
          item.style.removeProperty('display');
          const targetName = categoryMap.get(catId).name;
          if (textEl.textContent !== targetName) {
            textEl.textContent = targetName;
          }
        }
      }
    }
  }


  function processAll() {
    try {
      syncDiscoveryCategoriesInDOM();
    } catch (e) {
      console.warn('[encora] Discovery category sync error:', e);
    }
    if (!isLoaded) return;
    try {
      injectBadgesIntoProfileCards();
    } catch (e) {
      console.warn('[encora] Profile card badge injection error:', e);
    }
  }

  // --- Profile card (preview popout) badge injection ---
  // The preview card uses cached React state, not a fresh profile fetch, so the backend
  // injection doesn't reach it. We inject directly into the badge container.
  function injectBadgesIntoProfileCards() {
    const containers = document.querySelectorAll(
      '[data-flx="user.profile.profile-card.profile-card-user-info.badge-container"]'
    );
    for (const container of containers) {
      if (container.dataset.encoraInjected) continue;
      // User ID lives on the avatar element within the same card
      const card = container.closest('[data-flx="user.profile.profile-card.profile-card-layout.profile-card"]');
      if (!card) continue;
      const avatarEl = card.querySelector('[data-flx-user-id]');
      if (!avatarEl) continue;
      const userId = avatarEl.dataset.flxUserId;
      if (!userId) continue;
      const badges = badgeMap.get(userId);
      if (!badges || badges.length === 0) continue;

      for (const badge of badges) {
        if (!badge.icon) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.flx = 'ui.profile-badge.badge-button';
        btn.dataset.encoraCustomBadge = badge.id;
        btn.style.cssText = 'background:none;border:none;padding:1px;cursor:default;display:inline-flex;align-items:center;justify-content:center;';
        const img = document.createElement('img');
        img.src = `/custom-badges/image-proxy?url=${encodeURIComponent(badge.icon)}`;
        img.alt = badge.tooltip || badge.name || '';
        img.decoding = 'async';
        img.dataset.flx = 'ui.profile-badge.badge-art';
        img.style.cssText = 'width:20px;height:20px;object-fit:contain;';
        btn.addEventListener('mouseenter', () => _showTooltip(badge.tooltip || badge.name || badge.id, btn));
        btn.addEventListener('mouseleave', _hideTooltip);
        btn.appendChild(img);
        container.appendChild(btn);
      }
      container.dataset.encoraInjected = '1';
    }
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        processAll();
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('pointerdown', (e) => {
    if (e.target && e.target.closest && (
      e.target.closest('[data-flx="guild.guild-tabs.guild-discovery-tab.div--2"]') ||
      e.target.closest('[data-flx="ui.form.combobox.control-wrap"]') ||
      e.target.closest('[data-flx="ui.form.combobox.popup"]')
    )) {
      requestAnimationFrame(syncDiscoveryCategoriesInDOM);
      setTimeout(syncDiscoveryCategoriesInDOM, 20);
      setTimeout(syncDiscoveryCategoriesInDOM, 50);
      setTimeout(syncDiscoveryCategoriesInDOM, 100);
    }
  }, true);

  loadBadges();
  loadDiscoveryCategories();
  window.__preludeBadges = {
    badgeMap,
    usernameMap,
    processAll,
    remoteLog,
    clearPrefs() {
      document.querySelectorAll('[data-encora-settings-injected]').forEach(el => el.remove());
      console.log('[encora-badges] clearPrefs: settings managed by backend');
    },
  };

})();
