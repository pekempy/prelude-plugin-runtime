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
  let _cachedMyId = null;

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
    const all = Array.isArray(item) ? item : [item];
    // Only filter for the current user's own badges (they hide on their own profile)
    const myId = _getMyUserId();
    if (myId && String(userId) === myId) {
      return all.filter(b => !_isBadgeHidden(b.id || b.tooltip));
    }
    return all;
  }

  // --- Per-user badge visibility prefs (localStorage) ---
  function _getMyUserId() {
    if (_cachedMyId) return _cachedMyId;
    try {
      const fiber = document.querySelector('[class*="avatar_"]')?.__reactFiber$ ||
        [...document.querySelectorAll('*')].map(el => {
          const k = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
          return k ? el[k] : null;
        }).find(f => {
          let n = f; let d = 0;
          while (n && d++ < 30) {
            if (n.memoizedProps?.currentUser?.id) return true;
            n = n.return;
          }
        });
      if (!fiber) return null;
      let n = fiber; let d = 0;
      while (n && d++ < 30) {
        if (n.memoizedProps?.currentUser?.id) return String(n.memoizedProps.currentUser.id);
        n = n.return;
      }
    } catch {}
    return null;
  }
  function _badgePrefsKey() { const uid = _getMyUserId(); return uid ? `encora_badge_hidden_${uid}` : null; }
  const _hiddenMem = new Map(); // in-memory fallback when localStorage unavailable
  function _getHidden() {
    const k = _badgePrefsKey();
    if (!k) return [];
    try { return JSON.parse((window.localStorage || localStorage).getItem(k) || '[]'); } catch {}
    return _hiddenMem.get(k) || [];
  }
  function _setHidden(arr) {
    const k = _badgePrefsKey();
    if (!k) return;
    _hiddenMem.set(k, arr);
    try { (window.localStorage || localStorage).setItem(k, JSON.stringify(arr)); } catch {}
  }
  function _isBadgeHidden(badgeId) { return _getHidden().includes(String(badgeId)); }
  function _toggleBadgeHidden(badgeId) {
    const h = _getHidden(), id = String(badgeId);
    _setHidden(h.includes(id) ? h.filter(x => x !== id) : [...h, id]);
  }

  // --- Settings page injection ---
  function injectSettingsBadges() {
    const list = document.querySelector('[data-flx="user.profile-badge-settings.list"]');
    if (!list) return;
    if (list.querySelector('[data-encora-settings-injected]')) return;

    let myId = _getMyUserId();

    if (!myId) {
      // Fallback 1: avatar img src on the page contains userId
      // e.g. /api/v1/users/1234567890/avatar or /avatars/1234567890/hash.webp
      try {
        const imgs = document.querySelectorAll('img[src*="/users/"], img[src*="/avatars/"]');
        for (const img of imgs) {
          const m = img.src.match(/\/(?:users|avatars)\/(\d{15,20})\//);
          if (m && badgeMap.has(m[1])) { myId = m[1]; _cachedMyId = myId; break; }
        }
      } catch {}
    }

    if (!myId) {
      // Fallback 2: scan webpack modules for auth/user store
      try {
        const chunks = window.webpackChunkfluxer || window.webpackChunk || [];
        // webpack exposes require via modules cache
        const req = window.__webpack_require__;
        if (req?.c) {
          for (const mod of Object.values(req.c)) {
            const exp = mod?.exports;
            if (!exp) continue;
            const check = (o) => {
              if (!o || typeof o !== 'object') return null;
              if (o.id && typeof o.id === 'string' && /^\d{15,20}$/.test(o.id) && o.username) return o.id;
              return null;
            };
            const id = check(exp) || check(exp?.default) || check(exp?.getCurrentUser?.()) || check(exp?.getUser?.());
            if (id && badgeMap.has(id)) { myId = id; _cachedMyId = myId; break; }
          }
        }
      } catch {}
    }

    if (!myId) {
      // Fallback 3: fiber walk from list element
      try {
        const fKey = Object.keys(list).find(k => k.startsWith('__reactFiber$'));
        if (fKey) {
          let f = list[fKey]; let d = 0;
          while (f && d++ < 80) {
            const p = f.memoizedProps || {};
            const u = p.currentUser || p.user || p.viewer || p.me;
            if (u?.id && badgeMap.has(String(u.id))) { myId = String(u.id); _cachedMyId = myId; break; }
            const s = f.memoizedState;
            if (s?.queue === null && s?.memoizedState?.id && badgeMap.has(String(s.memoizedState.id))) {
              myId = String(s.memoizedState.id); _cachedMyId = myId; break;
            }
            f = f.return;
          }
        }
      } catch {}
    }

    if (!myId) { setTimeout(injectSettingsBadges, 800); return; }
    const raw = badgeMap.get(String(myId));
    const myBadges = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    if (!myBadges.length) return;

    // Steal classes from the native item for pixel-perfect match
    const nativeItem = list.querySelector('[data-flx="user.profile-badge-settings.item"]');
    const cls = {
      item:    nativeItem ? nativeItem.className : '',
      row:     nativeItem ? (nativeItem.querySelector('[data-flx="user.profile-badge-settings.row"]')?.className || '') : '',
      label:   nativeItem ? (nativeItem.querySelector('[data-flx="user.profile-badge-settings.row-label"]')?.className || '') : '',
      artSlot: nativeItem ? (nativeItem.querySelector('[data-flx="user.profile-badge-settings.art-slot"]')?.className || '') : '',
      art:     nativeItem ? (nativeItem.querySelector('[data-flx="user.profile-badge-settings.art"]')?.className || '') : '',
      lbl:     nativeItem ? (nativeItem.querySelector('[data-flx="user.profile-badge-settings.label"]')?.className || '') : '',
      swCont:  nativeItem ? (nativeItem.querySelector('[data-flx="ui.form.switch.container"]')?.className || '') : '',
      swRoot:  nativeItem ? (nativeItem.querySelector('[data-flx="ui.form.switch.switch-root"]')?.className || '') : '',
      swThumb: nativeItem ? (nativeItem.querySelector('[data-flx="ui.form.switch.switch-thumb"]')?.className || '') : '',
    };

    const checkSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true"><path d="M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z"></path></svg>';

    myBadges.forEach((badge, idx) => {
      const id = String(badge.id || badge.tooltip);
      const uid = `_encora_badge_${idx}`;
      const isHidden = _isBadgeHidden(id);
      const checked = !isHidden;
      const state = checked ? 'checked' : 'unchecked';

      const li = document.createElement('li');
      li.className = cls.item;
      li.setAttribute('data-flx', 'user.profile-badge-settings.item');
      li.setAttribute('data-encora-settings-injected', '');

      const row = document.createElement('div');
      row.className = cls.row;
      row.setAttribute('data-flx', 'user.profile-badge-settings.row');

      const lbl = document.createElement('label');
      lbl.className = cls.label;
      lbl.setAttribute('for', uid);
      lbl.setAttribute('data-flx', 'user.profile-badge-settings.row-label');

      const artSlot = document.createElement('span');
      artSlot.className = cls.artSlot;
      artSlot.setAttribute('data-flx', 'user.profile-badge-settings.art-slot');
      const img = document.createElement('img');
      img.src = `/custom-badges/image-proxy?url=${encodeURIComponent(badge.icon || badge.url || '')}`;
      img.alt = '';
      img.decoding = 'async';
      img.className = cls.art;
      img.setAttribute('data-flx', 'user.profile-badge-settings.art');
      artSlot.appendChild(img);

      const labelText = document.createElement('span');
      labelText.className = cls.lbl;
      labelText.dir = 'auto';
      labelText.setAttribute('data-flx', 'user.profile-badge-settings.label');
      labelText.textContent = badge.tooltip || badge.name || 'Badge';

      lbl.append(artSlot, labelText);

      const swCont = document.createElement('div');
      swCont.className = cls.swCont;
      swCont.setAttribute('data-flx', 'ui.form.switch.container');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.role = 'switch';
      btn.setAttribute('aria-checked', String(checked));
      btn.setAttribute('data-state', state);
      btn.value = 'on';
      btn.id = uid;
      btn.className = cls.swRoot;
      btn.setAttribute('data-flx', 'ui.form.switch.switch-root');
      btn.setAttribute('data-focus-ring-managed', 'true');

      const thumb = document.createElement('span');
      thumb.setAttribute('data-state', state);
      thumb.className = cls.swThumb;
      thumb.setAttribute('data-flx', 'ui.form.switch.switch-thumb');
      if (checked) thumb.innerHTML = checkSvg;
      btn.appendChild(thumb);

      btn.addEventListener('click', () => {
        _toggleBadgeHidden(id);
        const nowHidden = _isBadgeHidden(id);
        const nowChecked = !nowHidden;
        const nowState = nowChecked ? 'checked' : 'unchecked';
        btn.setAttribute('aria-checked', String(nowChecked));
        btn.setAttribute('data-state', nowState);
        thumb.setAttribute('data-state', nowState);
        thumb.innerHTML = nowChecked ? checkSvg : '';
      });

      swCont.appendChild(btn);
      row.append(lbl, swCont);
      li.appendChild(row);
      list.appendChild(li);
    });
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

      const editBtn = container.querySelector('[data-flx*="edit-button"], [class*="editButton"]');
      for (const badge of badges) {
        const badgeEl = createBadgeElement(badge, container);
        editBtn ? container.insertBefore(badgeEl, editBtn) : container.appendChild(badgeEl);
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
        injectSettingsBadges();
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

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url);
      if (url && /\/users\/@me$/.test(url) && res.ok) {
        res.clone().json().then(d => { const id = d?.id||d?.user?.id; if (id) { _cachedMyId = String(id); injectSettingsBadges(); } }).catch(() => {});
      }
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
    remoteLog,
    injectSettings: injectSettingsBadges,
    get cachedMyId() { return _cachedMyId; },
  };

})();
