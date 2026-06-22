// ==UserScript==
// @name         Trakt Uncapped Trending
// @namespace    https://github.com/vishal/trakt-uncapped
// @version      1.5.0
// @description  Browse Trakt's most-watched shows (no 50-watcher floor) — paginated, jump-to-page, posters + ratings with IMDb links, optionally hide shows you've already watched.
// @author       vishal
// @match        https://app.trakt.tv/*
// @match        https://trakt.tv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @connect      api.trakt.tv
// @connect      www.omdbapi.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============================ CONFIG ============================
  const CONFIG = {
    // ⚠️ Keep these BLANK in the committed file. Set your keys at runtime via the Violentmonkey
    //    menu (monkey icon) -> "Set Trakt / OMDb API keys" — stored in Violentmonkey, never in this
    //    file, so it's safe to push. (Only hardcode here for throwaway local use, then don't commit.)
    CLIENT_ID: '',
    CLIENT_SECRET: '',     // only needed for "Hide watched"
    OMDB_API_KEY: '',      // optional — real IMDb rating numbers (free key at omdbapi.com)
    PERIOD: 'daily',       // default window: daily | weekly | monthly | yearly | all
    PER_PAGE: 24,          // cards per page (also = how many shows fetched per request)
    POSTER_SIZE: 'medium', // thumb | medium | full  (posters come straight from Trakt's CDN)
    DEBUG: false,          // set true to log the first card's data to the console (F12)
  };
  // ================================================================

  // Credentials resolved from Violentmonkey storage first (set via the menu command), CONFIG fallback.
  const CLIENT_ID = GM_getValue('client_id', '') || CONFIG['CLIENT_ID'];
  const CLIENT_SECRET = GM_getValue('client_secret', '') || CONFIG['CLIENT_SECRET'];
  const OMDB_KEY = GM_getValue('omdb_key', '') || CONFIG['OMDB_API_KEY'];

  if (typeof GM_registerMenuCommand !== 'undefined') {
    GM_registerMenuCommand('Set Trakt / OMDb API keys', () => {
      const id = prompt('Trakt Client ID:', GM_getValue('client_id', ''));
      if (id !== null) GM_setValue('client_id', id.trim());
      const sec = prompt('Trakt Client Secret (only for "Hide watched"; blank if unused):', GM_getValue('client_secret', ''));
      if (sec !== null) GM_setValue('client_secret', sec.trim());
      const omdb = prompt('OMDb API key (optional, for IMDb rating numbers):', GM_getValue('omdb_key', ''));
      if (omdb !== null) GM_setValue('omdb_key', omdb.trim());
      alert('Saved to Violentmonkey storage. Reload the page to apply.');
    });
  }

  const API = 'https://api.trakt.tv';
  const REDIRECT = 'urn:ietf:wg:oauth:2.0:oob'; // PIN-style OAuth (no server needed)

  // ---- GM request -> Promise<{status, json, headers}> (bypasses CORS, exposes pagination headers) ----
  function gm(url, headers) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, headers: headers || {},
        onload: (r) => {
          let json = null;
          try { json = JSON.parse(r.responseText); } catch (e) { /* non-JSON */ }
          const h = {};
          (r.responseHeaders || '').split(/\r?\n/).forEach((line) => {
            const i = line.indexOf(':');
            if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
          });
          resolve({ status: r.status, json, headers: h });
        },
        onerror: reject,
      });
    });
  }

  const traktHeaders = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': CLIENT_ID,
  };

  // ---- POST helper (OAuth token exchange) ----
  function gmPost(url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        onload: (r) => {
          let j = null;
          try { j = JSON.parse(r.responseText); } catch (e) { /* non-JSON */ }
          resolve({ status: r.status, json: j });
        },
        onerror: reject,
      });
    });
  }

  // ---- OAuth — only used by "Hide watched" (reads YOUR watch history) ----
  let token = null;
  function loadToken() {
    if (token) return token;
    const raw = GM_getValue('trakt_token', '');
    if (raw) { try { token = JSON.parse(raw); } catch (e) { /* ignore */ } }
    return token;
  }
  function saveToken(t) {
    token = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: (t.created_at + t.expires_in) * 1000,
    };
    GM_setValue('trakt_token', JSON.stringify(token));
  }
  function clearToken() { token = null; GM_setValue('trakt_token', ''); }

  async function refreshToken(t) {
    const res = await gmPost(`${API}/oauth/token`, {
      refresh_token: t.refresh_token, client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'refresh_token',
    });
    if (res.status === 200 && res.json) { saveToken(res.json); return token; }
    clearToken();
    return null;
  }
  async function validAccessToken() {
    let t = loadToken();
    if (!t) return null;
    if (Date.now() > t.expires_at - 60000) t = await refreshToken(t);
    return t ? t.access_token : null;
  }
  async function authenticate() {
    const url = `https://trakt.tv/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}`;
    GM_openInTab(url, { active: true, insert: true });
    const pin = prompt('A Trakt tab just opened — click "Yes" to authorize, then paste the PIN code here:');
    if (!pin) throw new Error('cancelled');
    const res = await gmPost(`${API}/oauth/token`, {
      code: pin.trim(), client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT, grant_type: 'authorization_code',
    });
    if (res.status !== 200 || !res.json || !res.json.access_token) throw new Error('PIN exchange failed');
    saveToken(res.json);
    return res.json.access_token;
  }

  // ---- your watched shows: Set of trakt IDs for every show you've watched >=1 episode of ----
  let watchedSet = null;
  async function loadWatchedSet(access) {
    const set = new Set();
    let p = 1, pc = 1;
    do {
      const res = await gm(`${API}/sync/watched/shows?limit=1000&page=${p}`,
        Object.assign({}, traktHeaders, { Authorization: `Bearer ${access}` }));
      if (res.status === 401) { clearToken(); throw new Error('session expired — toggle again to re-login'); }
      if (res.status !== 200) throw new Error('Trakt sync ' + res.status);
      (res.json || []).forEach((e) => { if (e.show && e.show.ids) set.add(e.show.ids.trakt); });
      pc = parseInt(res.headers['x-pagination-page-count'] || '1', 10) || 1;
      p++;
    } while (p <= pc);
    return set;
  }
  async function ensureWatchedSet() {
    if (watchedSet) return watchedSet;
    let access = await validAccessToken();
    if (!access) access = await authenticate();
    watchedSet = await loadWatchedSet(access);
    return watchedSet;
  }

  // ---- state ----
  let page = 1, pageCount = 1, period = CONFIG.PERIOD, loading = false, hideWatched = false;

  async function fetchPage(p) {
    // Source = shows/watched/{period}: ranked by unique watchers, NO floor (goes down to 1).
    // extended=full,images returns posters + Trakt rating + imdb id inline — no extra requests.
    // Swap to `${API}/shows/trending?...` if you ever want the capped-at-50 official list.
    const url = `${API}/shows/watched/${period}?page=${p}&limit=${CONFIG.PER_PAGE}&extended=full,images`;
    const res = await gm(url, traktHeaders);
    if (res.status !== 200) throw new Error(`Trakt API ${res.status}`);
    pageCount = parseInt(res.headers['x-pagination-page-count'] || '1', 10) || 1;
    return res.json || [];
  }

  // ---- helpers ----
  // Posters come straight from Trakt's CDN (extended=images). URLs arrive scheme-less and at
  // /thumb/ size; we add https:// and bump the size segment to whatever POSTER_SIZE is set to.
  function posterUrl(show) {
    const p = show && show.images && show.images.poster && show.images.poster[0];
    return p ? 'https://' + p.replace('/posters/thumb/', `/posters/${CONFIG.POSTER_SIZE}/`) : null;
  }
  const posterColor = (show) => (show && show.colors && show.colors.poster && show.colors.poster[0]) || null;
  const watchersOf = (it) => (it.watcher_count != null ? it.watcher_count : (it.watchers != null ? it.watchers : 0));
  const imdbUrl = (imdb) => (imdb ? `https://www.imdb.com/title/${imdb}/` : null);
  const traktRating = (show) => (show && typeof show.rating === 'number' && show.rating > 0 ? show.rating.toFixed(1) : null);

  // optional IMDb ratings via OMDb (cached in GM storage — ratings are stable)
  let omdbCache = null;
  function omdbLoad() {
    if (omdbCache) return omdbCache;
    try { omdbCache = JSON.parse(GM_getValue('omdb_cache', '') || '{}'); } catch (e) { omdbCache = {}; }
    return omdbCache;
  }
  async function imdbRating(imdb) {
    if (!OMDB_KEY || !imdb) return null;
    const cache = omdbLoad();
    if (imdb in cache) return cache[imdb];
    let rating = null;
    try {
      const res = await gm(`https://www.omdbapi.com/?i=${imdb}&apikey=${OMDB_KEY}`, {});
      if (res.json && res.json.imdbRating && res.json.imdbRating !== 'N/A') rating = res.json.imdbRating;
    } catch (e) { /* ignore */ }
    cache[imdb] = rating;
    GM_setValue('omdb_cache', JSON.stringify(cache));
    return rating;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ============================ UI ============================
  GM_addStyle(`
    #tut-fab{position:fixed;right:18px;bottom:18px;z-index:99998;background:#ed1c24;color:#fff;
      border:none;border-radius:24px;padding:10px 16px;font:600 13px/1 system-ui,sans-serif;
      cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)}
    #tut-fab:hover{filter:brightness(1.1)}
    #tut-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);
      display:none;align-items:center;justify-content:center}
    #tut-overlay.open{display:flex}
    #tut-panel{width:min(1100px,94vw);height:88vh;background:#0b0b0d;color:#eee;border-radius:12px;
      display:flex;flex-direction:column;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.6);
      font-family:system-ui,sans-serif}
    #tut-head,#tut-foot{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#141417}
    #tut-head{border-bottom:1px solid #222}
    #tut-foot{border-top:1px solid #222;justify-content:center}
    #tut-head h2{margin:0;font-size:15px;font-weight:700;flex:0 0 auto}
    #tut-head .tut-tag{font-size:11px;color:#9a9a9a}
    #tut-period{margin-left:auto;background:#222;color:#eee;border:1px solid #333;border-radius:6px;padding:6px 8px}
    #tut-hide-lbl{display:flex;align-items:center;gap:5px;font-size:12px;color:#cfcfcf;cursor:pointer;white-space:nowrap}
    #tut-hide{cursor:pointer;margin:0}
    #tut-close{background:none;border:none;color:#999;font-size:22px;cursor:pointer;line-height:1}
    #tut-close:hover{color:#fff}
    #tut-grid{flex:1;overflow:auto;display:flex;flex-wrap:wrap;gap:14px;padding:16px;
      align-content:flex-start;justify-content:flex-start}
    .tut-card{flex:0 0 150px;box-sizing:border-box;text-decoration:none;color:#eee !important;display:block !important;border-radius:8px;
      overflow:hidden;background:#16161a;transition:transform .12s}
    .tut-card:hover{transform:translateY(-3px)}
    .tut-poster{box-sizing:border-box;width:100%;height:225px;position:relative;border-radius:8px 8px 0 0;overflow:hidden;background:linear-gradient(135deg,#2a2a33,#16161a);
      background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;
      text-align:center;padding:8px}
    .tut-poster .tut-fallback{font-size:12px;font-weight:600;color:#cfcfcf}
    .tut-poster.has-img .tut-fallback{display:none}
    .tut-rank{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.7);color:#fff;font-size:11px;
      font-weight:700;padding:2px 6px;border-radius:4px}
    .tut-watch{position:absolute;bottom:6px;right:6px;background:rgba(237,28,36,.92);color:#fff;font-size:11px;
      font-weight:700;padding:2px 6px;border-radius:4px}
    .tut-meta{padding:8px 9px;display:block !important;flex:0 0 auto;background:#16161a}
    .tut-title{display:block !important;font-size:12.5px;font-weight:600;color:#eee !important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tut-stats{display:flex !important;visibility:visible !important;align-items:center;flex-wrap:wrap;gap:8px;font-size:11px;color:#9a9a9a;margin-top:5px}
    .tut-stat{display:inline-flex !important;align-items:center;gap:2px;white-space:nowrap}
    .tut-trakt{color:#e0c64a !important;font-weight:700}
    .tut-watchers{color:#bdbdbd !important}
    .tut-imdb{font-weight:700;color:#f5c518 !important}
    .tut-imdb.link{cursor:pointer}
    .tut-imdb.link:hover{text-decoration:underline}
    .tut-imdb.has-rating{color:#000 !important;background:#f5c518;padding:1px 5px;border-radius:3px}
    #tut-foot button{background:#222;color:#eee;border:1px solid #333;border-radius:6px;padding:7px 14px;
      cursor:pointer;font-size:13px}
    #tut-foot button:disabled{opacity:.35;cursor:default}
    #tut-pageinfo{min-width:160px;text-align:center;font-size:13px;color:#bbb}
    #tut-pagenum{width:62px;background:#222;color:#eee;border:1px solid #333;border-radius:6px;padding:5px 6px;text-align:center;font-size:13px}
    #tut-status{font-size:12px;color:#ed6c6c}
  `);

  const overlay = document.createElement('div');
  overlay.id = 'tut-overlay';
  overlay.innerHTML = `
    <div id="tut-panel">
      <div id="tut-head">
        <h2>⚡ Uncapped Trending</h2>
        <span class="tut-tag">most-watched · no 50-floor · <span id="tut-ver"></span></span>
        <select id="tut-period">
          <option value="daily">Today</option>
          <option value="weekly">This week</option>
          <option value="monthly">This month</option>
          <option value="yearly">This year</option>
          <option value="all">All time</option>
        </select>
        <label id="tut-hide-lbl" title="Hide shows already in your Trakt history (one-time login)"><input type="checkbox" id="tut-hide"> Hide watched</label>
        <button id="tut-close" title="Close">×</button>
      </div>
      <div id="tut-grid"></div>
      <div id="tut-foot">
        <button id="tut-prev">◀ Prev</button>
        <span id="tut-pageinfo">Page <input id="tut-pagenum" type="number" min="1" value="1"> / <span id="tut-pagecount">—</span></span>
        <button id="tut-next">Next ▶</button>
        <span id="tut-status"></span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const fab = document.createElement('button');
  fab.id = 'tut-fab';
  fab.textContent = '⚡ Uncapped';
  document.body.appendChild(fab);

  const $ = (id) => document.getElementById(id);
  const grid = $('tut-grid'), status = $('tut-status'), pageinfo = $('tut-pageinfo');
  const setStatus = (m) => { status.textContent = m || ''; };
  $('tut-ver').textContent = 'v' + (typeof GM_info !== 'undefined' && GM_info.script ? GM_info.script.version : '?');
  $('tut-period').value = period;

  async function render() {
    if (loading) return;
    loading = true;
    status.textContent = '';
    grid.style.opacity = '.4';
    if (!CLIENT_ID) {
      grid.innerHTML = '';
      grid.style.opacity = '1';
      loading = false;
      setStatus('No Trakt Client ID set. Open the Violentmonkey menu (monkey icon) -> "Set Trakt / OMDb API keys", enter your Client ID, then reload.');
      return;
    }
    try {
      let items = await fetchPage(page);
      items.forEach((it, i) => { it.__rank = (page - 1) * CONFIG.PER_PAGE + i + 1; });
      let hidden = 0;
      if (hideWatched && watchedSet) {
        const before = items.length;
        items = items.filter((it) => !(it.show && it.show.ids && watchedSet.has(it.show.ids.trakt)));
        hidden = before - items.length;
      }
      grid.innerHTML = '';
      items.forEach((it, idx) => {
        const s = it.show || {};
        const ids = s.ids || {};
        const rank = it.__rank;
        const tr = traktRating(s);
        const imdb = ids.imdb;
        if (CONFIG.DEBUG && idx === 0) {
          console.log('[TUT] sample card →', s.title, '| trakt rating:', s.rating,
            '| imdb:', imdb, '| watchers:', watchersOf(it), '| hasImages:', !!s.images);
        }
        const a = document.createElement('a');
        a.className = 'tut-card';
        a.href = ids.slug ? `https://trakt.tv/shows/${ids.slug}` : '#';
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = `
          <div class="tut-poster">
            <span class="tut-rank">#${rank}</span>
            <span class="tut-fallback">${esc(s.title)}</span>
          </div>
          <div class="tut-meta">
            <span class="tut-title">${esc(s.title)}</span>
            <div class="tut-stats">
              <span class="tut-stat tut-trakt" title="Trakt rating">⭐ ${tr || '–'}</span>
              <span class="tut-stat tut-watchers" title="Watchers in this window">👁 ${watchersOf(it).toLocaleString()}</span>
              <span class="tut-stat tut-imdb" title="${imdb ? 'Open on IMDb' : 'No IMDb id'}">IMDb${imdb ? ' ↗' : ' –'}</span>
            </div>
          </div>`;
        // poster (CSP-safe: set via JS property, not inline style attr)
        const pe = a.querySelector('.tut-poster');
        const img = posterUrl(s), col = posterColor(s);
        if (img) { pe.style.backgroundImage = `url('${img}')`; pe.classList.add('has-img'); }
        else if (col) { pe.style.background = col; }
        // IMDb stat → clickable link; show the real IMDb rating if an OMDb key is configured
        const im = a.querySelector('.tut-imdb');
        if (imdb) {
          im.classList.add('link');
          im.addEventListener('click', (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            GM_openInTab(imdbUrl(imdb), { active: true, insert: true });
          });
          if (OMDB_KEY) {
            imdbRating(imdb).then((r) => {
              if (r) { im.textContent = `IMDb ${r}`; im.classList.add('has-rating'); im.title = `IMDb ${r} · open on IMDb`; }
            });
          }
        }
        grid.appendChild(a);
      });
      $('tut-pagenum').value = page;
      $('tut-pagenum').max = pageCount;
      $('tut-pagecount').textContent = pageCount.toLocaleString();
      $('tut-prev').disabled = page <= 1;
      $('tut-next').disabled = page >= pageCount;
      grid.scrollTop = 0;
      if (CONFIG.DEBUG) {
        const cards = Array.prototype.slice.call(grid.querySelectorAll('.tut-card'));
        const gs = getComputedStyle(grid);
        console.log('[TUT] cards:', cards.length, '| cols:', gs.gridTemplateColumns,
          '| auto-rows:', gs.gridAutoRows, '| align-items:', gs.alignItems);
        cards.slice(0, 8).forEach((c, i) => {
          const r = c.getBoundingClientRect();
          console.log(`[TUT] card#${i + 1} -> T/B: ${Math.round(r.top)}/${Math.round(r.bottom)} | L/R: ${Math.round(r.left)}/${Math.round(r.right)} | ${Math.round(r.width)}x${Math.round(r.height)}`);
        });
      }
      setStatus(hideWatched && watchedSet && hidden ? `${hidden} watched hidden here` : '');
    } catch (e) {
      status.textContent = String(e.message || e);
    } finally {
      grid.style.opacity = '1';
      loading = false;
    }
  }

  // ---- wiring ----
  function goToPage(n) {
    const target = Math.max(1, Math.min(pageCount, parseInt(n, 10) || 1));
    $('tut-pagenum').value = target;
    if (target !== page) { page = target; render(); }
  }

  fab.addEventListener('click', () => { overlay.classList.add('open'); if (!grid.children.length) render(); });
  $('tut-close').addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });
  $('tut-prev').addEventListener('click', () => { if (page > 1) { page--; render(); } });
  $('tut-next').addEventListener('click', () => { if (page < pageCount) { page++; render(); } });
  $('tut-pagenum').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); goToPage(e.target.value); e.target.blur(); }
  });
  $('tut-period').addEventListener('change', (e) => { period = e.target.value; page = 1; render(); });
  $('tut-hide').addEventListener('change', async (e) => {
    hideWatched = e.target.checked;
    if (hideWatched && !watchedSet) {
      e.target.disabled = true;
      setStatus('Connecting to Trakt…');
      try {
        await ensureWatchedSet();
        setStatus(`Loaded ${watchedSet.size} watched shows — filtering…`);
      } catch (err) {
        hideWatched = false; e.target.checked = false; e.target.disabled = false;
        setStatus('Could not enable: ' + (err.message || err));
        return;
      }
      e.target.disabled = false;
    }
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (!overlay.classList.contains('open')) return;
    if (e.key === 'Escape') { overlay.classList.remove('open'); return; }
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return; // typing a page #
    if (e.key === 'ArrowRight' && page < pageCount) { page++; render(); }
    else if (e.key === 'ArrowLeft' && page > 1) { page--; render(); }
  });
})();
