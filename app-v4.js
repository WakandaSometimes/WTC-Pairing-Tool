/* =====================================================================
   WTC Pairing Assistant - screen code (v4: shows each opposing player's rating)
   Data (teams/players/affiliations) comes from data.js
   Player ratings come from ratings.js
   Roster pictures come from cards.js + the cards/ folder
   The maths comes from engine.js
   ===================================================================== */
(function () {
  'use strict';
  const E = window.Engine;
  const DATA = window.WTC_DATA;
  const CARDS = window.WTC_CARDS || {};
  const RATINGS = window.WTC_PLAYER_RATINGS || {};
  const VERSION = 'v4 (+ player ratings)';   // shown under the title so you can tell which copy is running

  // ---------- teams ----------
  const US = DATA.teams.find(t => t.name === DATA.ourTeam);
  const OPP = DATA.teams.filter(t => t.name !== DATA.ourTeam).sort((a, b) => a.name.localeCompare(b.name));
  const ALL = [US].concat(OPP);

  // ---------- small helpers ----------
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s == null ? '' : s).replace(/[\ufeff\u00a0]/g, ' ').replace(/\\/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const alnum = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const pct = x => Math.round(x * 100) + '%';
  const clone = o => JSON.parse(JSON.stringify(o));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('wtc.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('wtc.' + k, JSON.stringify(v)); } catch (e) { /* storage full / blocked */ } }
  };

  // ---------- player ratings (static data from ratings.js) ----------
  // Every opposing player gets a .rating: a number, or null when the sheet had none.
  OPP.forEach(t => t.players.forEach(p => {
    const v = RATINGS[alnum(t.name) + '|' + alnum(p.name)];
    p.rating = typeof v === 'number' ? v : null;
  }));
  // Small badge shown next to an opposing player's name. Our own players get no badge.
  const ratingTag = p => {
    if (!p || p.rating === undefined) return '';
    return p.rating === null
      ? '<span class="elo na" title="No rating available for this player">no rating</span>'
      : `<span class="elo" title="Player rating (from your sheet)">Rating ${p.rating}</span>`;
  };

  // ---------- app state ----------
  const S = {
    tab: 'pairing',
    prevTab: null,
    setup: { team: 0, role: null },
    ratingsTeam: 0,
    session: store.get('session', null),
    sel: [],                                   // ticked opponent players while entering a nomination
    local: store.get('local', {}),             // ratings typed into the app (override the sheet)
    sheet: store.get('sheetCache', { ratings: {}, ts: null, rows: 0 }),
    sheetMsg: '',
    url: store.get('url', ''),
    tabName: store.get('tabName', ''),
    map: store.get('map', E.DEFAULT_MAP),
    view: store.get('view', 'pair'),           // pairing screen: 'pair' or 'lists'
    lmode: store.get('lmode', 'glance'),       // lists: 'glance' (portraits) or 'full'
    listsTeam: 1,                              // index into ALL (0 = us)
    listsPicked: false,
    modal: null                                // { team, i, zoom }
  };
  for (let i = 1; i <= 5; i++) if (typeof S.map[i] !== 'number') S.map = clone(E.DEFAULT_MAP);
  if (S.view !== 'pair' && S.view !== 'lists') S.view = 'pair';
  if (S.lmode !== 'glance' && S.lmode !== 'full') S.lmode = 'glance';

  // ---------- ratings ----------
  const rkey = (team, theirName, ourName) => [norm(team), norm(theirName), norm(ourName)].join('|');
  function getRating(oi, w, t) {
    const k = rkey(OPP[oi].name, OPP[oi].players[t].name, US.players[w].name);
    if (S.local[k] != null) return S.local[k];
    if (S.sheet.ratings[k] != null) return S.sheet.ratings[k];
    return null;
  }
  function isLocal(oi, w, t) {
    return S.local[rkey(OPP[oi].name, OPP[oi].players[t].name, US.players[w].name)] != null;
  }
  function matrix(oi) {
    const P = [], R = [];
    let missing = 0;
    for (let w = 0; w < 5; w++) {
      P.push([]); R.push([]);
      for (let t = 0; t < 5; t++) {
        const r = getRating(oi, w, t);
        if (r == null) missing++;
        R[w].push(r);
        P[w].push(S.map[r == null ? 3 : r]);
      }
    }
    return { P, R, missing };
  }
  function filledCount(oi) { return 25 - matrix(oi).missing; }

  // ---------- Google Sheet loading ----------
  function parseCSV(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f.length || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  // Turns whatever link the user pasted into one or more CSV links to try, in order.
  function sheetUrlCandidates(u) {
    u = u.trim();
    if (!u) return [];
    if (/\/spreadsheets\/d\/e\//.test(u)) {                       // "published to the web" link
      if (/output=csv/.test(u)) return [u];
      return [u.replace('/pubhtml', '/pub') + (u.includes('?') ? '&' : '?') + 'output=csv'];
    }
    const m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);     // normal share link
    if (m) {
      const base = 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv&';
      const out = [];
      out.push(base + 'sheet=' + encodeURIComponent(S.tabName.trim() || 'Ratings'));   // the tab by name
      const g = u.match(/[?&#]gid=(\d+)/);
      if (g) out.push(base + 'gid=' + g[1]);                                            // the tab the link points at
      return out;
    }
    return [u];                                                    // assume it is already a CSV link
  }
  function ingestCSV(text) {
    const rows = parseCSV(text);
    let h = -1;
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      const low = rows[i].map(norm);
      if (low.includes('team') && low.some(x => x.startsWith('opponent'))) { h = i; break; }
    }
    if (h < 0) {
      const seen = rows.filter(r => r.some(c => String(c).trim())).slice(0, 2)
        .map(r => r.filter(c => String(c).trim()).slice(0, 6).join(' | ')).join('  //  ');
      throw new Error('Could not find the header row (needs "Team" and "Opponent player"). First rows received: ' + (seen || '(empty)'));
    }
    const head = rows[h].map(norm);
    const ci = { team: head.indexOf('team'), opp: head.findIndex(x => x.startsWith('opponent')) };
    // our five players' columns: match by name, and never mistake the extra "Their Rating"/"affiliations" columns for one
    const notOurs = x => x === 'team' || x.startsWith('opponent') || x.includes('affil') || x.includes('rating');
    const ourCols = US.players.map(p => {
      const n = norm(p.name);
      let idx = head.indexOf(n);
      if (idx < 0) idx = head.findIndex(x => x && !notOurs(x) && (x.includes(n) || n.includes(x)));
      return idx;
    });
    const lacking = US.players.filter((p, i) => ourCols[i] < 0).map(p => p.name);
    if (lacking.length) throw new Error('No column found for: ' + lacking.join(', ') + '. Columns received: ' + rows[h].filter(c => String(c).trim()).join(' | '));
    const ratings = {}; let n = 0, rowsRead = 0;
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i]; if (!r[ci.team] || !r[ci.opp]) continue;
      rowsRead++;
      US.players.forEach((p, w) => {
        const v = parseInt(String(r[ourCols[w]] || '').trim(), 10);
        if (v >= 1 && v <= 5) { ratings[rkey(r[ci.team], r[ci.opp], p.name)] = v; n++; }
      });
    }
    S.sheet = { ratings, ts: Date.now(), rows: rowsRead, count: n };
    store.set('sheetCache', S.sheet);
    return n;
  }
  async function fetchCsv(url) {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 9000);
    try {
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('Google returned ' + res.status + ' - the sheet must be shared as "Anyone with the link can view" or published to the web.');
      const txt = await res.text();
      if (/^\s*<(!doctype|html)/i.test(txt)) throw new Error('Google sent a sign-in page instead of data - set sharing to "Anyone with the link can view" or use Publish to web.');
      return txt;
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'timed out' : e.message);
    } finally { clearTimeout(to); }
  }
  async function refreshSheet(silent) {
    const urls = sheetUrlCandidates(S.url);
    if (!urls.length) { S.sheetMsg = ''; render(); return; }
    if (!silent) { S.sheetMsg = 'Loading…'; renderStatus(); }
    const problems = [];
    for (const u of urls) {
      try {
        const n = ingestCSV(await fetchCsv(u));
        S.sheetMsg = 'ok:' + n; render(); return;
      } catch (e) {
        const label = /sheet=/.test(u) ? 'tab "' + decodeURIComponent(u.split('sheet=')[1]) + '"' : /gid=/.test(u) ? 'tab from link' : 'link';
        problems.push(label + ': ' + e.message);
      }
    }
    S.sheetMsg = 'err:' + problems.join('  ||  ') + (S.sheet.ts ? ' — using the last saved copy.' : '');
    render();
  }

  // ---------- header status ----------
  function renderStatus() {
    let s = 'Team: ' + esc(US.name) + ' · ';
    if (!S.url) s += 'no Google Sheet connected (local ratings only)';
    else if (S.sheetMsg.startsWith('err:')) s += 'sheet problem (see Settings)';
    else if (S.sheetMsg === 'Loading…') s += 'loading ratings…';
    else if (S.sheet.ts) s += S.sheet.count + ' ratings from sheet (' + new Date(S.sheet.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')';
    else s += 'sheet not loaded yet';
    $('status').innerHTML = s + ' · <b>' + VERSION + '</b>';
  }

  // ---------- tabs ----------
  function renderNav() {
    const tabs = [['pairing', 'Pairing'], ['lists', 'Lists'], ['ratings', 'Ratings'], ['settings', 'Settings']];
    $('nav').innerHTML = tabs.map(([k, l]) => `<button data-action="tab" data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('');
  }

  // ---------- shared bits ----------
  const chip = r => `<span class="rt r${r == null ? 0 : r}" title="${r == null ? 'not rated yet (treated as 3)' : 'rating ' + r}">${r == null ? '–' : r}</span>`;
  const affTags = p => (p.affiliations || []).map(a => `<span class="tag">${esc(a)}</span>`).join('');
  const outlook = v => `<div class="outlook"><b>${pct(v.p3)}</b><small>${v.e.toFixed(1)} wins avg</small></div>`;

  // =====================================================================
  //  ROSTER PICTURES
  //  cards.js holds ONE tall image per team (the 5 players stacked). A
  //  "crop" is a box that shows just one player's slice of that image:
  //    kind 's' = name + portraits only ("at a glance")
  //    kind 'f' = the whole card (crisis cards, tactic cards, MCT code)
  // =====================================================================
  function cardCrop(team, i, kind, opts) {
    opts = opts || {};
    const d = CARDS[alnum(team.name)];
    if (!d || !d.p[i]) return '<div class="banner warn">No roster picture found for this player.</div>';
    const p = d.p[i];
    const h = kind === 's' ? p.sh : p.h;
    const pos = d.h - h > 0 ? (p.y / (d.h - h)) * 100 : 0;
    const width = opts.zoom ? `width:${d.w}px;` : 'width:100%;';
    const act = opts.nolink ? '' : ` data-action="openCard" data-team="${esc(team.name)}" data-i="${i}"`;
    return `<div class="cc"${act} role="img" aria-label="${esc(team.players[i].name)} – roster" style="${width}aspect-ratio:${d.w} / ${h};background-image:url('${esc(d.file)}');background-size:100% auto;background-position:0 ${pos.toFixed(4)}%"></div>`;
  }
  const modeSeg = () => `<div class="seg tight" style="margin-top:10px">
      <button data-action="lmode" data-m="glance" class="${S.lmode === 'glance' ? 'on' : ''}">At a glance</button>
      <button data-action="lmode" data-m="full" class="${S.lmode === 'full' ? 'on' : ''}">Full lists</button>
    </div>`;
  const kindOf = () => (S.lmode === 'full' ? 'f' : 's');

  function renderModal() {
    const m = $('modal');
    if (!m) return;
    if (!S.modal) { m.hidden = true; m.innerHTML = ''; return; }
    const team = ALL.find(t => t.name === S.modal.team);
    if (!team) { S.modal = null; m.hidden = true; return; }
    m.hidden = false;
    const pl = team.players[S.modal.i];
    m.innerHTML = `
      <div class="mbar">
        <div><b>${esc(pl.name)}</b>${ratingTag(pl)}<div style="opacity:.8;font-size:.75rem">${esc(team.name)} · player ${S.modal.i + 1} of 5</div></div>
        <div class="row">
          <button type="button" data-action="mPrev" aria-label="Previous player">‹</button>
          <button type="button" data-action="mNext" aria-label="Next player">›</button>
          <button type="button" data-action="mZoom">${S.modal.zoom ? 'Fit' : 'Zoom'}</button>
          <button type="button" data-action="mClose" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="mbody">${cardCrop(team, S.modal.i, 'f', { zoom: S.modal.zoom, nolink: true })}</div>`;
  }

  // =====================================================================
  //  PAIRING TAB
  // =====================================================================
  function newSession(oi, role) {
    const st = E.freshState();
    return { team: oi, role, st, phase: 'first', nominated: null, history: [] };
  }
  function saveSession() { store.set('session', S.session); }
  function pushHistory() {
    const s = S.session;
    s.history.push(clone({ st: s.st, phase: s.phase, nominated: s.nominated }));
  }
  function nameOf(who, id, oi) { return who === 'we' ? US.players[id].name : OPP[oi].players[id].name; }

  function renderPairing() {
    if (!S.session) return renderSetup();
    return renderSession();
  }

  function renderSetup() {
    const opts = OPP.map((t, i) => `<option value="${i}" ${S.setup.team === i ? 'selected' : ''}>${esc(t.name)} — ${filledCount(i)}/25 rated</option>`).join('');
    const m = matrix(S.setup.team);
    const ready = S.setup.role != null;
    return `
    <div class="card">
      <h2>New pairing</h2>
      <p class="muted">Pick the team you're facing and which side you won in the roll-off.</p>
      <h3>Opponent</h3>
      <select data-change="setupTeam" style="width:100%">${opts}</select>
      ${m.missing ? `<div class="banner warn">${m.missing} of 25 ratings for this team are empty — they'll be treated as a neutral 3. Add them in the <b>Ratings</b> tab, or refresh from the sheet.</div>` : `<div class="banner ok">All 25 ratings for this team are filled in.</div>`}
      <h3 style="margin-top:14px">We are…</h3>
      <div class="seg">
        <button data-action="role" data-role="B" class="${S.setup.role === 'B' ? 'on' : ''}">Team B<br><small class="muted">we put down first</small></button>
        <button data-action="role" data-role="A" class="${S.setup.role === 'A' ? 'on' : ''}">Team A<br><small class="muted">they put down first</small></button>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn" data-action="start" ${ready ? '' : 'disabled'}>Start pairing</button>
        ${S.url ? '<button class="btn ghost" data-action="refresh">Refresh ratings from sheet</button>' : ''}
      </div>
    </div>`;
  }

  function currentValue(s, P) {
    const st = s.st;
    if (s.phase === 'done') return E.finish(P, st.pairs);
    if (s.phase === 'first') {
      const who = s.role === 'B' ? 'we' : 'they';
      return E.rankFirstPicks(P, st, who)[0].v;
    }
    if (s.phase === 'nominate') return E.stateValue(P, st);
    return E.afterNominate(P, st, s.nominated);
  }

  function renderSession() {
    const s = S.session, oi = s.team, st = s.st;
    const { P, R, missing } = matrix(oi);
    const opp = OPP[oi];
    const v = currentValue(s, P);

    let html = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div><h2>vs ${esc(opp.name)}</h2><div class="muted">You are Team ${s.role} · ${s.phase === 'done' ? 'all 5 matchups set' : 'matchup ' + Math.min(st.step, 5) + ' of 5'}</div></div>
        <div class="row">
          <button class="btn ghost" data-action="undo" ${s.history.length ? '' : 'disabled'}>↶ Undo</button>
          <button class="btn ghost" data-action="reset">New pairing</button>
        </div>
      </div>
      <div class="bar"><i style="width:${Math.round(v.p3 * 100)}%"></i></div>
      <div><b>${pct(v.p3)}</b> chance to win 3+ of 5 games <span class="muted">· ${v.e.toFixed(1)} expected wins, if both sides play well from here</span></div>
      ${missing ? `<div class="banner warn">${missing} ratings for this team are empty (counted as 3). Fix them in the Ratings tab — this screen updates straight away.</div>` : ''}
      <div class="seg tight" style="margin-top:10px">
        <button data-action="view" data-view="pair" class="${S.view === 'pair' ? 'on' : ''}">Pairing</button>
        <button data-action="view" data-view="lists" class="${S.view === 'lists' ? 'on' : ''}">Their lists</button>
      </div>
    </div>`;

    if (S.view === 'lists') {
      html += renderSessionLists(s, opp);
      html += renderMatchups(s, R, P, opp);
    } else {
      html += renderAction(s, P, R, opp);
      html += renderMatchups(s, R, P, opp);
      html += renderRosters(s, opp);
    }
    return html;
  }

  function renderAction(s, P, R, opp) {
    const st = s.st, oi = s.team, weB = s.role === 'B';
    if (s.phase === 'done') {
      return `<div class="card"><h2>✅ Pairings complete</h2><p class="muted">Final matchups are listed below. Use Undo if something was entered wrongly.</p></div>`;
    }

    // ---- Step 1: Team B puts down the first player
    if (s.phase === 'first') {
      const who = weB ? 'we' : 'they';
      const rows = E.rankFirstPicks(P, st, who);
      if (weB) {
        const items = rows.map((r, i) => `
          <button class="opt ${i === 0 ? 'best' : ''}" data-action="first" data-who="we" data-id="${r.id}">
            <div><div class="nm">${esc(US.players[r.id].name)}${i === 0 ? '<span class="badge">Suggested</span>' : ''}</div>
            <div class="sub">Team outlook if you lead with this player (opponent responds as well as they can)</div></div>${outlook(r.v)}
          </button>`).join('');
        return `<div class="card"><h2>Put down your first player</h2><p class="muted">As Team B you nominate first. Tap the player you actually put down.</p><div class="opts">${items}</div></div>`;
      }
      const items = st.they.map(id => {
        const r = rows.find(x => x.id === id);
        return `<button class="opt" data-action="first" data-who="they" data-id="${id}">
          <div><div class="nm">${esc(opp.players[id].name)}${ratingTag(opp.players[id])}</div><div>${affTags(opp.players[id])}</div></div>${outlook(r.v)}</button>`;
      }).join('');
      return `<div class="card"><h2>Which player did ${esc(opp.name)} put down first?</h2><p class="muted">Tap their player. The % shows how we'd stand if they lead with that player.</p><div class="opts">${items}</div></div>`;
    }

    const t = st.target, X = t.who, Y = X === 'we' ? 'they' : 'we';
    const tName = nameOf(X, t.id, oi);
    const tDesc = st.step === 1 ? `${tName}` : `${tName} (left on the table)`;
    const tAff = X === 'they' ? `<div>${affTags(opp.players[t.id])}${ratingTag(opp.players[t.id])}</div>` : '';

    // ---- Nominate: Y offers two players
    if (s.phase === 'nominate') {
      if (Y === 'we') {
        const rows = E.rankNominations(P, st);
        const items = rows.map((r, i) => {
          const [a, b] = r.pair;
          const ch = r.choices.map(c => `${esc(US.players[c.id].name.split(' ')[0])} → ${pct(c.v.p3)}`).join(' · ');
          const ra = rt(R, 'we', a, X, t.id), rb = rt(R, 'we', b, X, t.id);
          return `<button class="opt ${i === 0 ? 'best' : ''}" data-action="nominateWe" data-a="${a}" data-b="${b}">
            <div><div class="nm">${esc(US.players[a].name)} ${ra} &nbsp;+&nbsp; ${esc(US.players[b].name)} ${rb}${i === 0 ? '<span class="badge">Suggested</span>' : ''}</div>
            <div class="sub">If they pick: ${ch}</div></div>${outlook(r.v)}</button>`;
        }).join('');
        const forced = st.step === 4 ? '<p class="muted">Only two players left, so this one is forced.</p>' : '';
        return `<div class="card"><h2>Nominate two players to face ${esc(tDesc)}</h2>${tAff}
          <p class="muted">Ratings shown are your player vs ${esc(tName)}. The opponent will pick whichever of the two is worse for you, so pairs are ranked by that worst case.</p>${forced}
          <div class="opts">${items}</div></div>`;
      }
      const items = st.they.map(id => `
        <label class="opt ${S.sel.includes(id) ? 'sel' : ''}" style="cursor:pointer">
          <input type="checkbox" data-change="sel" data-id="${id}" ${S.sel.includes(id) ? 'checked' : ''} style="width:20px;height:20px">
          <div style="flex:1"><div class="nm">${esc(opp.players[id].name)}${ratingTag(opp.players[id])}</div><div>${affTags(opp.players[id])}</div></div>
        </label>`).join('');
      const ok = S.sel.length === 2;
      return `<div class="card"><h2>Which two players did ${esc(opp.name)} nominate?</h2>
        <p class="muted">They are offering two players to face <b>${esc(tDesc)}</b>. Tick the two.</p>
        <div class="opts">${items}</div>
        <div class="row" style="margin-top:12px"><button class="btn" data-action="confirmThey" ${ok ? '' : 'disabled'}>Confirm these two</button></div></div>`;
    }

    // ---- Choose: X picks one of the two offered
    if (s.phase === 'choose') {
      const pair = s.nominated;
      if (X === 'we') {
        const rows = E.rankChoices(P, st, pair);
        const items = rows.map((r, i) => `
          <button class="opt ${i === 0 ? 'best' : ''}" data-action="choose" data-id="${r.id}">
            <div><div class="nm">${esc(opp.players[r.id].name)}${ratingTag(opp.players[r.id])}${i === 0 ? '<span class="badge">Suggested</span>' : ''}</div>
            <div>${affTags(opp.players[r.id])}</div>
            <div class="sub">${esc(tName)} vs this player: ${chip(R[t.id][r.id])} (${pct(P[t.id][r.id])} to win)</div></div>${outlook(r.v)}</button>`).join('');
        return `<div class="card"><h2>Choose who ${esc(tName)} plays</h2>
          <p class="muted">Pick one of the two players offered. The other stays on the table. Tap the one you choose.</p><div class="opts">${items}</div></div>`;
      }
      const rows = E.rankChoices(P, st, pair);
      const predicted = rows[0].id;
      const items = pair.map(id => {
        const r = rows.find(x => x.id === id);
        return `<button class="opt" data-action="choose" data-id="${id}">
          <div><div class="nm">${esc(US.players[id].name)}${id === predicted ? ' <span class="tag">their likely pick</span>' : ''}</div>
          <div class="sub">vs ${esc(tName)}${ratingTag(opp.players[t.id])}: ${chip(R[id][t.id])} (${pct(P[id][t.id])} to win)</div></div>${outlook(r.v)}</button>`;
      }).join('');
      return `<div class="card"><h2>Which of your two did ${esc(opp.name)} choose?</h2>
        <p class="muted">You offered ${esc(US.players[pair[0]].name)} and ${esc(US.players[pair[1]].name)} to face ${esc(tDesc)}. Tap the one they chose; the other stays on the table.</p><div class="opts">${items}</div></div>`;
    }
    return '';
  }
  // rating chip for (candidate side/id) vs (target side/id), from our perspective
  function rt(R, candWho, cid, tWho, tid) {
    const w = candWho === 'we' ? cid : tid, th = candWho === 'we' ? tid : cid;
    return chip(R[w][th]);
  }

  function renderMatchups(s, R, P, opp) {
    const pairs = s.st.pairs;
    if (!pairs.length) return '';
    const rows = pairs.map(([w, t], i) => `<tr><td>${i + 1}</td><td>${esc(US.players[w].name)}</td><td>${esc(opp.players[t].name)}${ratingTag(opp.players[t])}</td><td>${chip(R[w][t])}</td><td>${pct(P[w][t])}</td></tr>`).join('');
    return `<div class="card"><h2>Matchups so far</h2><div class="scroll"><table><tr><th>#</th><th>Us</th><th>Them</th><th>Rating</th><th>Win chance</th></tr>${rows}</table></div></div>`;
  }

  // where is each player in the pairing process?  returns [cssClass, text]
  function playerStatus(s, opp, who, id) {
    const st = s.st;
    const idx = st.pairs.findIndex(p => p[who === 'we' ? 0 : 1] === id);
    if (idx >= 0) return ['paired', 'Matchup ' + (idx + 1) + ' → ' + (who === 'we' ? opp.players[st.pairs[idx][1]].name : US.players[st.pairs[idx][0]].name)];
    if (st.target && st.target.who === who && st.target.id === id) return ['table', (st.step === 1 ? 'put down – waiting for an opponent' : 'left on the table – waiting for an opponent')];
    if (s.nominated && s.nominated.includes(id) && st.target && st.target.who !== who) return ['', 'nominated'];
    return ['', 'available'];
  }

  function renderRosters(s, opp) {
    const col = (who, team) => team.players.map((p, id) => {
      const [cls, txt] = playerStatus(s, opp, who, id);
      return `<div class="pl ${cls}"><div><b>${esc(p.name)}</b>${who === 'they' ? ratingTag(p) + '<div>' + affTags(p) + '</div>' : ''}</div><div class="st">${esc(txt)}</div></div>`;
    }).join('');
    return `<div class="card"><h2>Players</h2><div class="grid2"><div><h3>${esc(US.name)}</h3>${col('we', US)}</div><div><h3>${esc(opp.name)}</h3>${col('they', opp)}</div></div></div>`;
  }

  // "Their lists" view inside the pairing screen: portraits for every opposing player, with live status
  function renderSessionLists(s, opp) {
    const kind = kindOf();
    const items = opp.players.map((p, id) => {
      const [cls, txt] = playerStatus(s, opp, 'they', id);
      return `<div class="lcard ${cls}">
        <div class="lh"><span><b>${esc(p.name)}</b>${ratingTag(p)}</span><span class="stbadge ${cls === 'table' ? 'hot' : ''}">${esc(txt)}</span></div>
        ${cardCrop(opp, id, kind)}</div>`;
    }).join('');
    return `<div class="card"><h2>${esc(opp.name)} – lists</h2>
      <p class="muted">Tap any picture to enlarge it. Paired players are dimmed; the player waiting for an opponent is outlined.</p>
      ${modeSeg()}${items}</div>`;
  }

  // ---------- pairing actions ----------
  function autoAdvance(s) {
    if (s.phase === 'nominate' && s.st.step === 4) {
      const Y = s.st.target.who === 'we' ? 'they' : 'we';
      s.nominated = s.st[Y].slice();
      s.phase = 'choose';
    }
  }
  function doChoose(id) {
    const s = S.session; pushHistory();
    s.st = E.applyChoice(s.st, s.nominated, id);
    s.nominated = null;
    s.phase = s.st.done ? 'done' : 'nominate';
    autoAdvance(s);
    S.sel = []; saveSession();
  }

  // =====================================================================
  //  LISTS TAB  (rosters for any team, including ours)
  // =====================================================================
  function renderLists() {
    const team = ALL[S.listsTeam] || ALL[1];
    const opts = ALL.map((t, i) => `<option value="${i}" ${S.listsTeam === i ? 'selected' : ''}>${i === 0 ? '★ ' + esc(t.name) + ' (us)' : esc(t.name)}</option>`).join('');
    const kind = kindOf();
    const items = team.players.map((p, i) => `<div class="lcard"><div class="lh"><span><b>${esc(p.name)}</b>${ratingTag(p)}</span><span>${affTags(p)}</span></div>${cardCrop(team, i, kind)}</div>`).join('');
    return `<div class="card"><h2>Team lists</h2>
      <p class="muted">The roster pictures for every team. Tap a picture to enlarge it.</p>
      <select data-change="listsTeam" style="width:100%">${opts}</select>
      ${modeSeg()}${items}</div>`;
  }

  // =====================================================================
  //  RATINGS TAB
  // =====================================================================
  function renderRatings() {
    const oi = S.ratingsTeam, opp = OPP[oi];
    const opts = OPP.map((t, i) => `<option value="${i}" ${oi === i ? 'selected' : ''}>${esc(t.name)} — ${filledCount(i)}/25</option>`).join('');
    let head = '<tr><th>Our player ↓ / their player →</th>' + opp.players.map(p => `<th>${esc(p.name)}<div class="aff">${ratingTag(p)}${affTags(p)}</div></th>`).join('') + '</tr>';
    let body = US.players.map((u, w) => '<tr><td>' + esc(u.name) + '</td>' + opp.players.map((p, t) => {
      const r = getRating(oi, w, t);
      const o = ['<option value="">–</option>'].concat([1, 2, 3, 4, 5].map(n => `<option value="${n}" ${r === n ? 'selected' : ''}>${n}</option>`)).join('');
      return `<td class="${isLocal(oi, w, t) ? 'local' : ''}"><select data-change="rate" data-w="${w}" data-t="${t}">${o}</select></td>`;
    }).join('') + '</tr>').join('');
    const nLocal = Object.keys(S.local).filter(k => k.startsWith(norm(opp.name) + '|')).length;
    return `
    <div class="card">
      <h2>Ratings</h2>
      <p class="muted">Rate each of our players against each opposing player: <b>1</b> = we expect to lose badly, <b>3</b> = even, <b>5</b> = we expect to win comfortably.
      Normally your team fills these in on the shared Google Sheet; use this page for quick changes on the day. Blue cells are typed into this device and override the sheet.</p>
      <select data-change="ratingsTeam" style="width:100%">${opts}</select>
      <div class="scroll" style="margin-top:10px"><table class="rtab">${head}${body}</table></div>
      <div class="row" style="margin-top:12px">
        ${S.url ? '<button class="btn" data-action="refresh">Refresh from sheet</button>' : ''}
        <button class="btn ghost" data-action="clearLocal" ${nLocal ? '' : 'disabled'}>Clear my typed-in ratings for this team (${nLocal})</button>
        <button class="btn ghost" data-action="demo">Fill empty cells with random demo ratings</button>
      </div>
    </div>`;
  }

  // =====================================================================
  //  SETTINGS TAB
  // =====================================================================
  function renderSettings() {
    let msg = '';
    if (S.sheetMsg.startsWith('err:')) msg = `<div class="banner err">${esc(S.sheetMsg.slice(4))}</div>`;
    else if (S.sheetMsg.startsWith('ok:')) msg = `<div class="banner ok">Loaded ${S.sheetMsg.slice(3)} ratings from the sheet.</div>`;
    const maps = [1, 2, 3, 4, 5].map(i => `<div><div class="muted">Rating ${i}</div><input type="number" min="0" max="100" step="1" data-change="map" data-i="${i}" value="${Math.round(S.map[i] * 100)}" style="width:90px"> %</div>`).join('');
    return `
    <div class="card">
      <h2>Google Sheet</h2>
      <p class="muted">Paste the link to your ratings spreadsheet. The app reads it each time you press Refresh, and keeps a saved copy in case the venue Wi-Fi drops.</p>
      <input type="text" id="url" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(S.url)}">
      <div class="muted" style="margin-top:10px">Name of the ratings tab (optional — leave blank to use "Ratings")</div>
      <input type="text" id="tabname" placeholder="Ratings" value="${esc(S.tabName)}">
      <div class="row" style="margin-top:10px">
        <button class="btn" data-action="saveUrl">Save &amp; load</button>
        <button class="btn ghost" data-action="clearUrl">Disconnect</button>
      </div>
      ${msg}
      <details style="margin-top:12px"><summary>No internet / sheet not working? Load a CSV file instead</summary>
        <p class="muted">In Google Sheets, open the ratings tab, then File → Download → Comma-separated values (.csv), then choose it here.</p>
        <input type="file" id="csvfile" accept=".csv,text/csv">
      </details>
    </div>
    <div class="card">
      <h2>What do the ratings mean?</h2>
      <p class="muted">Each rating is turned into a chance of winning that game. These are the defaults — change them if your team is more or less cautious.</p>
      <div class="row">${maps}</div>
      <div class="row" style="margin-top:10px"><button class="btn ghost" data-action="resetMap">Reset to defaults</button></div>
    </div>
    <div class="card"><h2>About the suggestions</h2>
      <p class="muted">The app looks ahead through every remaining step of the pairing process and assumes the opponent always makes the choice that is worst for us. It then recommends the option that gives us the best chance of winning at least 3 of 5 games (expected wins is the tie-break). Games are treated as independent and tables are ignored. The "Rating" badge next to each opposing player is for information only and does not change the suggestions.</p></div>`;
  }

  // =====================================================================
  //  RENDER + EVENTS
  // =====================================================================
  function render() {
    renderStatus(); renderNav();
    const f = { pairing: renderPairing, lists: renderLists, ratings: renderRatings, settings: renderSettings }[S.tab];
    const keep = S.prevTab === S.tab ? window.scrollY : 0;
    $('app').innerHTML = f();
    S.prevTab = S.tab;
    window.scrollTo(0, keep);
    renderModal();
  }

  function closeModal() { S.modal = null; }

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && S.modal) { closeModal(); renderModal(); }
  });

  document.addEventListener('click', ev => {
    const b = ev.target.closest('[data-action]'); if (!b) return;
    const a = b.dataset.action, s = S.session;
    switch (a) {
      case 'tab':
        S.tab = b.dataset.tab;
        if (S.tab === 'lists' && s && !S.listsPicked) S.listsTeam = ALL.indexOf(OPP[s.team]);   // jump to the team being played
        break;
      case 'role': S.setup.role = b.dataset.role; break;
      case 'start':
        S.session = newSession(S.setup.team, S.setup.role); S.sel = []; saveSession();
        S.listsPicked = false;
        if (S.url) refreshSheet(true);
        break;
      case 'reset': if (!confirm('Start a new pairing? The current one will be cleared.')) return; S.session = null; S.setup.role = null; S.sel = []; store.set('session', null); break;
      case 'undo': {
        const h = s.history.pop(); if (!h) return;
        s.st = h.st; s.phase = h.phase; s.nominated = h.nominated; S.sel = []; saveSession(); break;
      }
      case 'first': {
        pushHistory();
        s.st = E.stateAfterFirstPick(s.st, b.dataset.who, +b.dataset.id); s.phase = 'nominate';
        autoAdvance(s); S.sel = []; saveSession(); break;
      }
      case 'nominateWe': pushHistory(); s.nominated = [+b.dataset.a, +b.dataset.b]; s.phase = 'choose'; saveSession(); break;
      case 'confirmThey': if (S.sel.length !== 2) return; pushHistory(); s.nominated = S.sel.slice().sort((x, y) => x - y); s.phase = 'choose'; S.sel = []; saveSession(); break;
      case 'choose': doChoose(+b.dataset.id); break;
      case 'view': S.view = b.dataset.view; store.set('view', S.view); break;
      case 'lmode': S.lmode = b.dataset.m; store.set('lmode', S.lmode); break;
      case 'openCard': S.modal = { team: b.dataset.team, i: +b.dataset.i, zoom: false }; break;
      case 'mClose': closeModal(); break;
      case 'mZoom': if (S.modal) S.modal.zoom = !S.modal.zoom; break;
      case 'mPrev': if (S.modal) { S.modal.i = (S.modal.i + 4) % 5; } break;
      case 'mNext': if (S.modal) { S.modal.i = (S.modal.i + 1) % 5; } break;
      case 'refresh': refreshSheet(false); return;
      case 'clearLocal': {
        const pre = norm(OPP[S.ratingsTeam].name) + '|';
        Object.keys(S.local).forEach(k => { if (k.startsWith(pre)) delete S.local[k]; });
        store.set('local', S.local); break;
      }
      case 'demo': {
        for (let w = 0; w < 5; w++) for (let t = 0; t < 5; t++) if (getRating(S.ratingsTeam, w, t) == null)
          S.local[rkey(OPP[S.ratingsTeam].name, OPP[S.ratingsTeam].players[t].name, US.players[w].name)] = 1 + Math.floor(Math.random() * 5);
        store.set('local', S.local); break;
      }
      case 'saveUrl':
        S.url = $('url').value.trim(); S.tabName = $('tabname').value.trim();
        store.set('url', S.url); store.set('tabName', S.tabName);
        refreshSheet(false); return;
      case 'clearUrl': S.url = ''; store.set('url', ''); S.sheetMsg = ''; break;
      case 'resetMap': S.map = clone(E.DEFAULT_MAP); store.set('map', S.map); break;
    }
    if (a === 'mZoom' || a === 'mPrev' || a === 'mNext' || a === 'mClose' || a === 'openCard') {
      // only the pop-up changes: leave the page behind it (and its scroll position) alone
      renderModal();
      if (a === 'mPrev' || a === 'mNext') { const mb = document.querySelector('#modal .mbody'); if (mb) mb.scrollTop = 0; }
      return;
    }
    render();
  });

  document.addEventListener('change', ev => {
    const el = ev.target;
    if (el.id === 'csvfile' && el.files[0]) {
      const fr = new FileReader();
      fr.onload = () => { try { S.sheetMsg = 'ok:' + ingestCSV(fr.result); } catch (e) { S.sheetMsg = 'err:' + e.message; } render(); };
      fr.readAsText(el.files[0]); return;
    }
    const c = el.dataset && el.dataset.change; if (!c) return;
    if (c === 'setupTeam') S.setup.team = +el.value;
    else if (c === 'ratingsTeam') S.ratingsTeam = +el.value;
    else if (c === 'listsTeam') { S.listsTeam = +el.value; S.listsPicked = true; }
    else if (c === 'sel') {
      const id = +el.dataset.id;
      if (el.checked) { if (S.sel.length >= 2) { el.checked = false; return; } S.sel.push(id); }
      else S.sel = S.sel.filter(x => x !== id);
    } else if (c === 'rate') {
      const k = rkey(OPP[S.ratingsTeam].name, OPP[S.ratingsTeam].players[+el.dataset.t].name, US.players[+el.dataset.w].name);
      if (el.value === '') delete S.local[k]; else S.local[k] = +el.value;
      store.set('local', S.local);
    } else if (c === 'map') {
      const v = Math.max(0, Math.min(100, parseFloat(el.value) || 0)) / 100;
      S.map[+el.dataset.i] = v; store.set('map', S.map);
    }
    render();
  });

  // ---------- go ----------
  if (S.session && S.session.team >= OPP.length) S.session = null;
  render();
  if (S.url) refreshSheet(true);
})();
