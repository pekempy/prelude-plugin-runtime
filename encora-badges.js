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

    // Dedup: only skip if injected count already matches expected count
    const existing = list.querySelectorAll('[data-encora-settings-injected]');
    if (existing.length === myBadges.length) return;
    existing.forEach(el => el.remove());


    // Steal classes from the native item for pixel-perfect match
    const nativeItem = list.querySelector('[data-flx="user.profile-badge-settings.item"]');
    // Use getAttribute('class') — SVG .className returns SVGAnimatedString, not a string
    const gc = (el) => el?.getAttribute('class') || '';
    const cls = {
      item:    nativeItem ? nativeItem.className : '',
      row:     gc(nativeItem?.querySelector('[data-flx="user.profile-badge-settings.row"]')),
      label:   gc(nativeItem?.querySelector('[data-flx="user.profile-badge-settings.row-label"]')),
      artSlot: gc(nativeItem?.querySelector('[data-flx="user.profile-badge-settings.art-slot"]')),
      art:     gc(nativeItem?.querySelector('[data-flx="user.profile-badge-settings.art"]')),
      lbl:     gc(nativeItem?.querySelector('[data-flx="user.profile-badge-settings.label"]')),
      swCont:  gc(nativeItem?.querySelector('[data-flx="ui.form.switch.container"]')),
      swRoot:  gc(nativeItem?.querySelector('[data-flx="ui.form.switch.switch-root"]')),
      swThumb: gc(nativeItem?.querySelector('[data-flx="ui.form.switch.switch-thumb"]')),
      get iconChecked()   { return gc(nativeItem?.querySelector('[data-flx="ui.form.switch.icon-checked"]')); },
      get iconUnchecked() {
        const c = gc(nativeItem?.querySelector('[data-flx="ui.form.switch.icon-unchecked"]'));
        return c || this.iconChecked.replace('iconChecked', 'iconUnchecked');
      },
    };

    const checkSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true" class="${cls.iconChecked}" data-flx="ui.form.switch.icon-checked"><path d="M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z" data-flx="ui.form.switch.path"></path></svg>`;
    const crossSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true" class="${cls.iconUnchecked}" data-flx="ui.form.switch.icon-unchecked"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z" data-flx="ui.form.switch.path"></path></svg>`;

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
      thumb.innerHTML = checked ? checkSvg : crossSvg;
      btn.appendChild(thumb);

      btn.addEventListener('click', () => {
        _toggleBadgeHidden(id);
        const nowHidden = _isBadgeHidden(id);
        const nowChecked = !nowHidden;
        const nowState = nowChecked ? 'checked' : 'unchecked';
        btn.setAttribute('aria-checked', String(nowChecked));
        btn.setAttribute('data-state', nowState);
        thumb.setAttribute('data-state', nowState);
        thumb.innerHTML = nowChecked ? checkSvg : crossSvg;
      });

      swCont.appendChild(btn);
      row.append(lbl, swCont);
      li.appendChild(row);
      list.appendChild(li);
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
      injectSettingsBadges();
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
      // Capture own user ID for settings badge injection
      if (url && /\/users\/@me$/.test(url) && res.ok) {
        res.clone().json().then(d => { const id = d?.id||d?.user?.id; if (id) { _cachedMyId = String(id); injectSettingsBadges(); } }).catch(() => {});
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
    clearPrefs() {
      // Nuclear: wipe ALL encora badge hidden keys regardless of cached ID
      try {
        const ls = window.localStorage;
        Object.keys(ls).filter(k => k.startsWith('encora_badge_hidden_')).forEach(k => { ls.removeItem(k); _hiddenMem.delete(k); });
      } catch {}
      _hiddenMem.forEach((_, k) => { if (k.startsWith('encora_badge_hidden_')) _hiddenMem.delete(k); });
      document.querySelectorAll('[data-encora-settings-injected]').forEach(el => el.remove());
      injectSettingsBadges();
      processAll();
      console.log('[encora-badges] All hidden badge prefs cleared');
    },
  };

})();
