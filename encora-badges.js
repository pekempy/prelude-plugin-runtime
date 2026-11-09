/**
 * Prelude Custom Badges Runtime v2.3.0
 * Supports multiple custom badges per user, auto-proxying of icons,
 * React Fiber & DOM user-id inspection, dynamic badge injection into profile popouts and modals,
 * and sync with Postgres backend.
 */
(() => {
  if (window.__preludeBadgesLoaded) return;
  window.__preludeBadgesLoaded = true;

  // --- Native-style tooltip ---
  let _ttEl = null;
  function _showTooltip(text, anchor) {
    if (!_ttEl) {
      _ttEl = document.createElement('div');
      _ttEl.setAttribute('data-encora-tooltip', '');
      Object.assign(_ttEl.style, {
        position: 'fixed', zIndex: '99999', pointerEvents: 'none',
        backgroundColor: 'var(--background-floating, #111827)',
        color: 'var(--text-normal, #fff)',
        fontSize: '14px', lineHeight: '16px', fontWeight: '500',
        padding: '8px 12px', borderRadius: '4px',
        boxShadow: 'var(--shadow-high, 0 8px 16px rgba(0,0,0,.24))',
        whiteSpace: 'nowrap', fontFamily: 'inherit',
        opacity: '0', transition: 'opacity .1s',
      });
      document.body.appendChild(_ttEl);
    }
    _ttEl.textContent = text;
    _ttEl.style.display = 'block';
    requestAnimationFrame(() => {
      const r = anchor.getBoundingClientRect(), t = _ttEl.getBoundingClientRect();
      _ttEl.style.top = Math.max(4, r.top - t.height - 8) + 'px';
      _ttEl.style.left = Math.max(4, r.left + r.width / 2 - t.width / 2) + 'px';
      _ttEl.style.opacity = '1';
    });
  }
  function _hideTooltip() { if (_ttEl) { _ttEl.style.opacity = '0'; _ttEl.style.display = 'none'; } }

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

  function getBadgesForUser(userId) {
    if (!userId) return [];
    const item = badgeMap.get(String(userId));
    if (!item) return [];
    return Array.isArray(item) ? item : [item];
  }

  function createBadgeElement(badge, container) {
    const a = document.createElement('a');
    a.href = badge.link || '#';
    if (badge.link && badge.link !== '#') {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    a.setAttribute('data-encora-badge', 'true');
    a.setAttribute('data-badge-id', badge.id || 'custom');
    a.addEventListener('mouseenter', () => _showTooltip(badge.tooltip || badge.name || 'Badge', a));
    a.addEventListener('mouseleave', _hideTooltip);
    a.className = 'FocusRing_focusRing___rKjT link___y9d1D';
    Object.assign(a.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: badge.link && badge.link !== '#' ? 'pointer' : 'default',
      textDecoration: 'none'
    });

    const img = document.createElement('img');
    const rawIcon = badge.icon || badge.url || '';
    const proxiedSrc = rawIcon.startsWith('http')
      ? `/custom-badges/image-proxy?url=${encodeURIComponent(rawIcon)}`
      : rawIcon;
    img.src = proxiedSrc;
    img.alt = badge.tooltip || badge.name || 'Badge';

    if (container) {
      const siblingImg = container.querySelector('img');
      if (siblingImg && siblingImg.className) {
        img.className = siblingImg.className;
      }
    }

    Object.assign(img.style, {
      width: '1.25rem',
      height: '1.25rem',
      minWidth: '1.25rem',
      minHeight: '1.25rem',
      borderRadius: '3px',
      objectFit: 'contain',
      display: 'block'
    });

    img.onload = () => {
      remoteLog('BADGE_IMG_LOADED', { badgeId: badge.id, src: img.src });
    };
    img.onerror = () => {
      remoteLog('BADGE_IMG_ERROR', { badgeId: badge.id, src: img.src });
      img.remove();
      const badgePill = document.createElement('span');
      badgePill.textContent = badge.name || 'Badge';
      Object.assign(badgePill.style, {
        fontSize: '10px',
        fontWeight: 'bold',
        padding: '2px 6px',
        borderRadius: '4px',
        backgroundColor: '#4f46e5',
        color: '#fff',
        display: 'inline-block',
        lineHeight: '1.2'
      });
      a.appendChild(badgePill);
    };

    a.appendChild(img);
    return a;
  }

  function getUserIdFromFiber(element) {
    if (!element) return null;
    let curr = element;
    let depth = 0;
    while (curr && depth < 10) {
      const fiberKey = Object.keys(curr).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (fiberKey && curr[fiberKey]) {
        let fiber = curr[fiberKey];
        let fDepth = 0;
        while (fiber && fDepth < 20) {
          const props = fiber.memoizedProps;
          if (props) {
            if (props.user && props.user.id) return String(props.user.id);
            if (props.currentUser && props.currentUser.id) return String(props.currentUser.id);
            if (props.actionUser && props.actionUser.id) return String(props.actionUser.id);
            if (props.userId) return String(props.userId);
            if (props.user_id) return String(props.user_id);
          }
          fiber = fiber.return;
          fDepth++;
        }
      }
      curr = curr.parentElement;
      depth++;
    }
    return null;
  }

  function findUserIdForElement(container) {
    if (!container) return null;

    // 1. Direct attribute on container or parent
    const selfAttr = container.getAttribute && container.getAttribute('data-flx-user-id');
    if (selfAttr) return selfAttr;

    // 2. React Fiber property traversal
    const fiberId = getUserIdFromFiber(container);
    if (fiberId) return fiberId;

    // 3. Closest card, modal, or popout
    const card = container.closest(
      '[data-flx*="profile-card"], [class*="profileCard"], [class*="ProfileCardLayout"], [data-flx*="modal"], [data-flx*="popout"], [role="dialog"]'
    ) || container.parentElement;

    if (card) {
      // 3a. Check for element with data-flx-user-id
      const avatar = card.querySelector('[data-flx-user-id]');
      if (avatar && avatar.getAttribute('data-flx-user-id')) {
        return avatar.getAttribute('data-flx-user-id');
      }

      // 3b. React Fiber on card
      const cardFiberId = getUserIdFromFiber(card);
      if (cardFiberId) return cardFiberId;

      // 3c. Check image/banner URLs containing userId: /media/avatars/<id>/ or /media/banners/<id>/
      const urlMatch = card.innerHTML.match(/\/media\/(?:avatars|banners)\/([0-9]{15,22})\//);
      if (urlMatch) return urlMatch[1];

      // 3d. Check username button text
      const usernameBtn = card.querySelector('[class*="usernameButton"], [data-flx*="username-button"]');
      if (usernameBtn) {
        const uText = usernameBtn.textContent.replace(/#[0-9]+$/, '').trim().toLowerCase();
        if (uText && usernameMap.has(uText)) {
          return usernameMap.get(uText);
        }
      }

      // 3e. Check display name button text
      const nameBtn = card.querySelector('[class*="displayName"], [data-flx*="display-name"], [class*="nameButton"]');
      if (nameBtn) {
        const nText = nameBtn.textContent.trim().toLowerCase();
        if (nText && usernameMap.has(nText)) {
          return usernameMap.get(nText);
        }
      }
    }

    // 4. Fallback: Any visible profile card in the document
    const anyCardAvatar = document.querySelector('[class*="profileCard"] [data-flx-user-id], [data-flx*="profile-card"] [data-flx-user-id]');
    if (anyCardAvatar) {
      return anyCardAvatar.getAttribute('data-flx-user-id');
    }

    return null;
  }

  function injectIntoExistingBadgeContainers() {
    const containers = document.querySelectorAll(
      '[data-flx="user.user-profile-badges.div"], [class*="containerPopout"], [class*="containerModal"]'
    );
    containers.forEach((container, idx) => {
      const profileBadgeRow = container.closest('[data-flx="user.user-profile-modal.user-info.div--8"]');
      const inProfileModal = Boolean(container.closest('[data-flx="user.user-profile-modal.div"]'));
      const isProfileBadgeSlot = inProfileModal && Boolean(profileBadgeRow);

      if (inProfileModal && !isProfileBadgeSlot) {
        container.querySelectorAll('[data-encora-badge]').forEach(el => el.remove());
        if (container.hasAttribute('data-encora-injected-container')) {
          container.remove();
        }
        return;
      }

      const pluginAppBadgeGroup =
        container.querySelector('[data-encora-badge-source="plugin-app"]') ||
        profileBadgeRow?.querySelector('[data-encora-badge-source="plugin-app"]') ||
        container.parentElement?.querySelector('[data-encora-badge-source="plugin-app"]');
      if (pluginAppBadgeGroup) {
        container.querySelectorAll('[data-encora-badge]').forEach(el => el.remove());
        if (container.hasAttribute('data-encora-injected-container')) {
          container.remove();
        }
        return;
      }
      const userId = findUserIdForElement(container);
      if (!userId) return;

      const badges = getBadgesForUser(userId);
      if (!badges.length) return;

      const existingBadgeIds = Array.from(container.querySelectorAll('[data-encora-badge]'))
        .map(el => el.getAttribute('data-badge-id'));
      const requiredBadgeIds = badges.map(b => b.id || 'custom');

      if (JSON.stringify(existingBadgeIds) === JSON.stringify(requiredBadgeIds)) {
        return;
      }

      // Remove previously injected badges
      container.querySelectorAll('[data-encora-badge]').forEach(el => el.remove());

      for (const badge of badges) {
        const badgeEl = createBadgeElement(badge, container);
        container.appendChild(badgeEl);
      }
      remoteLog('BADGES_INJECTED_INTO_EXISTING', { userId, count: badges.length });
    });
  }

  function injectIntoCardsWithoutBadges() {
    const cards = document.querySelectorAll(
      '[data-flx="user.profile.profile-card.profile-card-layout.profile-card"], ' +
      '[class*="ProfileCardLayout_profileCard"], ' +
      '[class*="profileCard___"], ' +
      '[data-flx*="profile-card"]'
    );

    cards.forEach((card, idx) => {
      if (card.querySelector('[data-encora-badge]')) return;
      if (card.querySelector('[data-flx="user.user-profile-badges.div"], [class*="containerPopout"]')) return;

      const userId = findUserIdForElement(card);
      if (!userId) return;

      const badges = getBadgesForUser(userId);
      if (!badges.length) return;

      const header = card.querySelector('header, [class*="headerSection"], [data-flx*="banner"]');
      if (!header) return;

      remoteLog('CREATING_NEW_BADGE_CONTAINER', { idx, userId });

      const newContainer = document.createElement('div');
      newContainer.className = 'UserProfileBadges.module__containerPopout___bVZYRU';
      newContainer.setAttribute('data-flx', 'user.user-profile-badges.div');
      newContainer.setAttribute('data-encora-injected-container', 'true');
      Object.assign(newContainer.style, {
        position: 'absolute',
        top: '7.1875rem',
        right: '0.625rem',
        zIndex: '10',
        display: 'flex',
        gap: '0.25rem',
        borderRadius: '0.375rem',
        padding: '0.25rem',
        background: 'color-mix(in srgb, var(--background-secondary, #2b2d31) 80%, transparent)'
      });

      for (const badge of badges) {
        newContainer.appendChild(createBadgeElement(badge, newContainer));
      }

      if (header.nextSibling) {
        header.parentNode.insertBefore(newContainer, header.nextSibling);
      } else {
        header.parentNode.appendChild(newContainer);
      }
      remoteLog('BADGES_CONTAINER_INJECTED', { userId, count: badges.length });
    });
  }

  function injectIntoModalsWithoutBadges() {
    const modals = document.querySelectorAll(
      '[data-flx="user.user-profile-modal.div"]'
    );

    modals.forEach((modal, idx) => {
      const profileBadgeRow = modal.querySelector('[data-flx="user.user-profile-modal.user-info.div--8"]');
      const badgeSlot = profileBadgeRow?.querySelector(
        '[data-encora-badge], [data-encora-badge-source="plugin-app"], [data-flx="user.user-profile-badges.div"], [class*="containerModal"]'
      );
      if (!profileBadgeRow || badgeSlot) return;

      const userId = findUserIdForElement(modal);
      if (!userId) return;

      const badges = getBadgesForUser(userId);
      if (!badges.length) return;

      remoteLog('CREATING_MODAL_CONTAINER', { idx, userId });

      const newContainer = document.createElement('div');
      newContainer.setAttribute('data-flx', 'user.user-profile-badges.div');
      newContainer.setAttribute('data-encora-injected-container', 'true');
      Object.assign(newContainer.style, {
        position: 'static',
        display: 'flex',
        alignItems: 'center',
        gap: '0.25rem'
      });

      for (const badge of badges) {
        newContainer.appendChild(createBadgeElement(badge, newContainer));
      }

      profileBadgeRow.appendChild(newContainer);
      remoteLog('MODAL_BADGES_INJECTED', { userId, count: badges.length });
    });
  }

  function processAll() {
    try {
      syncDiscoveryCategoriesInDOM();
    } catch (e) {
      console.warn('[encora] Discovery category sync error:', e);
    }
    if (!isLoaded) return;
    try {
      injectIntoExistingBadgeContainers();
      injectIntoCardsWithoutBadges();
      injectIntoModalsWithoutBadges();
    } catch (e) {
      remoteLog('PROCESS_ALL_ERROR', { error: e.message, stack: e.stack });
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

  // Dynamic user profile connection hook
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
      if (url && url.includes('/profile') && res.ok) {
        res.clone().json().then(data => {
          if (data && data.user && data.user.id && data.connected_accounts) {
            const encora = data.connected_accounts.find(c => 
              c.type === 'domain' && c.name && c.name.toLowerCase().includes('encora')
            );
            const uid = String(data.user.id);
            if (encora && !badgeMap.has(uid)) {
              badgeMap.set(uid, [{
                id: 'encora_linked',
                name: 'Encora Trader',
                icon: 'https://encora.it/images/favicon.png',
                link: 'https://' + encora.name,
                tooltip: 'Encora: ' + encora.name.replace(/^encora\.it\/traders\//, '')
              }]);
              processAll();
            }
          }
        }).catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  window.__preludeBadges = {
    badgeMap,
    usernameMap,
    processAll,
    remoteLog
  };

})();
