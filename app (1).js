/* =====================================================================
   WTC Pairing Assistant - screen code
   Data (teams/players/affiliations) comes from data.js
   The maths comes from engine.js
   ===================================================================== */
(function () {
  'use strict';
  const E = window.Engine;
  const DATA = window.WTC_DATA;

  // ---------- teams ----------
  const US = DATA.teams.find(t => t.name === DATA.ourTeam);
  const OPP = DATA.teams.filter(t => t.name !== DATA.ourTeam).sort((a, b) => a.name.localeCompare(b.name));

  // ---------- small helpers ----------
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s == null ? '' : s).replace(/\\/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pct = x => Math.round(x * 100) + '%';
  const clone = o => JSON.parse(JSON.stringify(o));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('wtc.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('wtc.' + k, JSON.stringify(v)); } catch (e) { /* storage full / blocked */ } }
  };

  // ---------- app state ----------
  const S = {
    tab: 'pairing',
    setup: { team: 0, role: null },
    ratingsTeam: 0,
    session: store.get('session', null),
    sel: [],                                   // ticked opponent players while entering a nomination
    local: store.get('local', {}),             // ratings typed into the app (override the sheet)
    sheet: store.get('sheetCache', { ratings: {}, ts: null, rows: 0 }),
    sheetMsg: '',
    url: store.get('url', ''),
    map: store.get('map', E.DEFAULT_MAP)
  };
  // make sure map has all 5 numbers
  for (let i = 1; i <= 5; i++) if (typeof S.map[i] !== 'number') S.map = E.DEFAULT_MAP;

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
  function sheetUrlToCsv(u) {
    u = u.trim();
    if (!u) return '';
    if (/\/spreadsheets\/d\/e\//.test(u)) {                       // "published to the web" link
      if (/output=csv/.test(u)) return u;
      return u.replace('/pubhtml', '/pub') + (u.includes('?') ? '&' : '?') + 'output=csv';
    }
    const m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);     // normal share link
    if (m) return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv&sheet=Ratings';
    return u;                                                      // assume it is already a CSV link
  }
  function ingestCSV(text) {
    const rows = parseCSV(text);
    let h = -1;
    for (let i = 0; i < Math.min(rows.length, 6); i++) {
      const low = rows[i].map(norm);
      if (low.includes('team') && low.some(x => x.startsWith('opponent'))) { h = i; break; }
    }
    if (h < 0) throw new Error('Could not find the header row (needs "Team" and "Opponent player" columns). Is the right tab published?');
    const head = rows[h].map(norm);
    const ci = { team: head.indexOf('team'), opp: head.findIndex(x => x.startsWith('opponent')) };
    const ourCols = US.players.map(p => {
      const n = norm(p.name);
      let idx = head.indexOf(n);
      if (idx < 0) idx = head.findIndex(x => x && (x.includes(n) || n.includes(x)) && x !== 'team' && !x.startsWith('opponent') && !x.includes('affil'));
      return idx;
    });
    const lacking = US.players.filter((p, i) => ourCols[i] < 0).map(p => p.name);
    if (lacking.length) throw new Error('No column found for: ' + lacking.join(', '));
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
  async function refreshSheet(silent) {
    const url = sheetUrlToCsv(S.url);
    if (!url) { S.sheetMsg = ''; render(); return; }
    try {
      if (!silent) { S.sheetMsg = 'Loading…'; renderStatus(); }
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 9000);
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(to);
      if (!res.ok) throw new Error('Google returned ' + res.status + ' (is the sheet published / shared?)');
      const n = ingestCSV(await res.text());
      S.sheetMsg = 'ok:' + n;
    } catch (e) {
      S.sheetMsg = 'err:' + (e.name === 'AbortError' ? 'timed out' : e.message) + (S.sheet.ts ? ' — using the last saved copy.' : '');
    }
    render();
  }

  // ---------- header status ----------
  function renderStatus() {
    let s = 'Team: ' + esc(US.name) + ' · ';
    if (!S.url) s += 'no Google Sheet connected (local ratings only)';
    else if (S.sheetMsg.startsWith('err:')) s += 'sheet problem: ' + esc(S.sheetMsg.slice(4));
    else if (S.sheetMsg === 'Loading…') s += 'loading ratings…';
    else if (S.sheet.ts) s += S.sheet.count + ' ratings from sheet (' + new Date(S.sheet.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')';
    else s += 'sheet not loaded yet';
    $('status').innerHTML = s;
  }

  // ---------- tabs ----------
  function renderNav() {
    const tabs = [['pairing', 'Pairing'], ['ratings', 'Ratings'], ['settings', 'Settings']];
    $('nav').innerHTML = tabs.map(([k, l]) => `<button data-action="tab" data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('');
  }

  // ---------- shared bits ----------
  const chip = r => `<span class="rt r${r == null ? 0 : r}" title="${r == null ? 'not rated yet (treated as 3)' : 'rating ' + r}">${r == null ? '–' : r}</span>`;
  const affTags = p => (p.affiliations || []).map(a => `<span class="tag">${esc(a)}</span>`).join('');
  const outlook = v => `<div class="outlook"><b>${pct(v.p3)}</b><small>${v.e.toFixed(1)} wins avg</small></div>`;

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
    // "outlook" for the whole situation, assuming best play from here
    const st = s.st;
    if (s.phase === 'done') return E.finish(P, st.pairs);
    if (s.phase === 'first') {
      const who = s.role === 'B' ? 'we' : 'they';
      const rows = E.rankFirstPicks(P, st, who);
      return rows[0].v;
    }
    if (s.phase === 'nominate') return E.stateValue(P, st);
    return E.afterNominate(P, st, s.nominated);
  }

  function renderSession() {
    const s = S.session, oi = s.team, st = s.st;
    const { P, R, missing } = matrix(oi);
    const opp = OPP[oi];
    const weB = s.role === 'B';
    const v = currentValue(s, P);

    // ---- top strip
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
    </div>`;

    html += renderAction(s, P, R, opp);
    html += renderMatchups(s, R, P, opp);
    html += renderRosters(s, opp);
    return html;
  }

  // ---------- the step-by-step action card ----------
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
          <div><div class="nm">${esc(opp.players[id].name)}</div><div>${affTags(opp.players[id])}</div></div>${outlook(r.v)}</button>`;
      }).join('');
      return `<div class="card"><h2>Which player did ${esc(opp.name)} put down first?</h2><p class="muted">Tap their player. The % shows how we'd stand if they lead with that player.</p><div class="opts">${items}</div></div>`;
    }

    const t = st.target, X = t.who, Y = X === 'we' ? 'they' : 'we';
    const tName = nameOf(X, t.id, oi);
    const tDesc = st.step === 1 ? `${tName}` : `${tName} (left on the table)`;
    const tAff = X === 'they' ? `<div>${affTags(opp.players[t.id])}</div>` : '';

    // ---- Nominate: Y offers two players
    if (s.phase === 'nominate') {
      if (Y === 'we') {
        const rows = E.rankNominations(P, st);
        const items = rows.map((r, i) => {
          const [a, b] = r.pair;
          const ch = r.choices.map(c => `${esc(US.players[c.id].name.split(' ')[0])} → ${pct(c.v.p3)}`).join(' · ');
          const ra = rt(R, P, 'we', a, X, t.id), rb = rt(R, P, 'we', b, X, t.id);
          return `<button class="opt ${i === 0 ? 'best' : ''}" data-action="nominateWe" data-a="${a}" data-b="${b}">
            <div><div class="nm">${esc(US.players[a].name)} ${ra} &nbsp;+&nbsp; ${esc(US.players[b].name)} ${rb}${i === 0 ? '<span class="badge">Suggested</span>' : ''}</div>
            <div class="sub">If they pick: ${ch}</div></div>${outlook(r.v)}</button>`;
        }).join('');
        const forced = st.step === 4 ? '<p class="muted">Only two players left, so this one is forced.</p>' : '';
        return `<div class="card"><h2>Nominate two players to face ${esc(tDesc)}</h2>${tAff}
          <p class="muted">Ratings shown are your player vs ${esc(tName)}. The opponent will pick whichever of the two is worse for you, so pairs are ranked by that worst case.</p>${forced}
          <div class="opts">${items}</div></div>`;
      }
      // they nominate two
      const items = st.they.map(id => `
        <label class="opt ${S.sel.includes(id) ? 'sel' : ''}" style="cursor:pointer">
          <span class="chk label"><input type="checkbox" data-change="sel" data-id="${id}" ${S.sel.includes(id) ? 'checked' : ''}></span>
          <div style="flex:1"><div class="nm">${esc(opp.players[id].name)}</div><div>${affTags(opp.players[id])}</div></div>
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
            <div><div class="nm">${esc(opp.players[r.id].name)}${i === 0 ? '<span class="badge">Suggested</span>' : ''}</div>
            <div>${affTags(opp.players[r.id])}</div>
            <div class="sub">${esc(tName)} vs this player: ${chip(R[t.id][r.id])} (${pct(P[t.id][r.id])} to win)</div></div>${outlook(r.v)}</button>`).join('');
        return `<div class="card"><h2>Choose who ${esc(tName)} plays</h2>
          <p class="muted">Pick one of the two players offered. The other stays on the table. Tap the one you choose.</p><div class="opts">${items}</div></div>`;
      }
      // they choose one of ours
      const rows = E.rankChoices(P, st, pair);            // ranked from X's (their) view: first = their best pick
      const predicted = rows[0].id;
      const items = pair.map(id => {
        const r = rows.find(x => x.id === id);
        return `<button class="opt" data-action="choose" data-id="${id}">
          <div><div class="nm">${esc(US.players[id].name)}${id === predicted ? ' <span class="tag">their likely pick</span>' : ''}</div>
          <div class="sub">vs ${esc(tName)}: ${chip(R[id][t.id])} (${pct(P[id][t.id])} to win)</div></div>${outlook(r.v)}</button>`;
      }).join('');
      return `<div class="card"><h2>Which of your two did ${esc(opp.name)} choose?</h2>
        <p class="muted">You offered ${esc(US.players[pair[0]].name)} and ${esc(US.players[pair[1]].name)} to face ${esc(tDesc)}. Tap the one they chose; the other stays on the table.</p><div class="opts">${items}</div></div>`;
    }
    return '';
  }
  // rating chip for (candidate side/id) vs (target side/id), from our perspective
  function rt(R, P, candWho, cid, tWho, tid) {
    const w = candWho === 'we' ? cid : tid, th = candWho === 'we' ? tid : cid;
    return `${chip(R[w][th])}`;
  }

  // ---------- matchups table ----------
  function renderMatchups(s, R, P, opp) {
    const pairs = s.st.pairs;
    if (!pairs.length) return '';
    const rows = pairs.map(([w, t], i) => `<tr><td>${i + 1}</td><td>${esc(US.players[w].name)}</td><td>${esc(opp.players[t].name)}</td><td>${chip(R[w][t])}</td><td>${pct(P[w][t])}</td></tr>`).join('');
    return `<div class="card"><h2>Matchups so far</h2><div class="scroll"><table><tr><th>#</th><th>Us</th><th>Them</th><th>Rating</th><th>Win chance</th></tr>${rows}</table></div></div>`;
  }

  // ---------- rosters (display only) ----------
  function renderRosters(s, opp) {
    const st = s.st;
    const status = (who, id) => {
      const idx = st.pairs.findIndex(p => p[who === 'we' ? 0 : 1] === id);
      if (idx >= 0) return ['paired', 'Matchup ' + (idx + 1) + ' → ' + (who === 'we' ? opp.players[st.pairs[idx][1]].name : US.players[st.pairs[idx][0]].name)];
      if (st.target && st.target.who === who && st.target.id === id) return ['table', (st.step === 1 ? 'put down – waiting for an opponent' : 'left on the table – waiting for an opponent')];
      if (s.nominated && s.nominated.includes(id) && st.target && st.target.who !== who) return ['', 'nominated'];
      return ['', 'available'];
    };
    const col = (who, team) => team.players.map((p, id) => {
      const [cls, txt] = status(who, id);
      return `<div class="pl ${cls}"><div><b>${esc(p.name)}</b>${who === 'they' ? '<div>' + affTags(p) + '</div>' : ''}</div><div class="st">${esc(txt)}</div></div>`;
    }).join('');
    return `<div class="card"><h2>Players</h2><div class="grid2"><div><h3>${esc(US.name)}</h3>${col('we', US)}</div><div><h3>${esc(opp.name)}</h3>${col('they', opp)}</div></div></div>`;
  }

  // ---------- pairing actions ----------
  function autoAdvance(s) {
    // at step 4 the nominated pair is forced (only two players left)
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
  //  RATINGS TAB
  // =====================================================================
  function renderRatings() {
    const oi = S.ratingsTeam, opp = OPP[oi];
    const opts = OPP.map((t, i) => `<option value="${i}" ${oi === i ? 'selected' : ''}>${esc(t.name)} — ${filledCount(i)}/25</option>`).join('');
    let head = '<tr><th>Our player ↓ / their player →</th>' + opp.players.map(p => `<th>${esc(p.name)}<div class="aff">${affTags(p)}</div></th>`).join('') + '</tr>';
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
      <p class="muted">Paste the link to your published ratings sheet (see the setup guide). The app reads it each time you press Refresh, and keeps a saved copy in case the venue Wi-Fi drops.</p>
      <input type="text" id="url" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?output=csv" value="${esc(S.url)}">
      <div class="row" style="margin-top:10px">
        <button class="btn" data-action="saveUrl">Save &amp; load</button>
        <button class="btn ghost" data-action="clearUrl">Disconnect</button>
      </div>
      ${msg}
      <details style="margin-top:12px"><summary>No internet / sheet not working? Load a CSV file instead</summary>
        <p class="muted">In Google Sheets: File → Download → Comma-separated values (.csv), then choose it here.</p>
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
      <p class="muted">The app looks ahead through every remaining step of the pairing process and assumes the opponent always makes the choice that is worst for us. It then recommends the option that gives us the best chance of winning at least 3 of 5 games (expected wins is the tie-break). Games are treated as independent and tables are ignored.</p></div>`;
  }

  // =====================================================================
  //  RENDER + EVENTS
  // =====================================================================
  function render() {
    renderStatus(); renderNav();
    const f = { pairing: renderPairing, ratings: renderRatings, settings: renderSettings }[S.tab];
    const keep = window.scrollY;
    $('app').innerHTML = f();
    if (S.tab === 'pairing' && S.session) window.scrollTo(0, keep);
  }

  document.addEventListener('click', ev => {
    const b = ev.target.closest('[data-action]'); if (!b) return;
    const a = b.dataset.action, s = S.session;
    switch (a) {
      case 'tab': S.tab = b.dataset.tab; break;
      case 'role': S.setup.role = b.dataset.role; break;
      case 'start':
        S.session = newSession(S.setup.team, S.setup.role); S.sel = []; saveSession();
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
      case 'saveUrl': S.url = $('url').value.trim(); store.set('url', S.url); refreshSheet(false); return;
      case 'clearUrl': S.url = ''; store.set('url', ''); S.sheetMsg = ''; break;
      case 'resetMap': S.map = clone(E.DEFAULT_MAP); store.set('map', S.map); break;
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
