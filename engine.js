/* =====================================================================
   WTC pairing engine (no screen code in here - just the maths)

   Pairing process (5 v 5), as described in the WTC rules:
     Step 1  Team B puts down a player (the "target").
             Team A offers 2 players, Team B picks one to face the target.
             The player Team A offered but B didn't pick is left "on the table".
     Step 2  The player left on the table is the new target.
             Team B offers 2 of their remaining players, Team A picks one.
     Step 3  Team A offers 2 of their remaining players to face B's floater, B picks.
     Step 4  Team B offers their last 2 players, Team A picks. Step 5 is forced.

   Every decision is evaluated by looking ahead through the WHOLE rest of the
   process. We assume the opponent plays as well as possible against us
   (worst case). The thing we try to maximise is the chance of winning at least
   3 of the 5 games; expected number of wins is used as a tie-break.
   ===================================================================== */
(function (root) {
  'use strict';

  const DEFAULT_MAP = { 1: 0.10, 2: 0.30, 3: 0.50, 4: 0.70, 5: 0.90 };

  // ---------- probability helpers ----------
  // Chance of winning k of n games where game i is won with probability ps[i]
  function winDistribution(ps) {
    let dist = [1];
    for (const p of ps) {
      const next = new Array(dist.length + 1).fill(0);
      for (let k = 0; k < dist.length; k++) {
        next[k] += dist[k] * (1 - p);
        next[k + 1] += dist[k] * p;
      }
      dist = next;
    }
    return dist;
  }
  function evaluate(ps) {
    const dist = winDistribution(ps);
    const need = Math.floor(ps.length / 2) + 1; // 3 of 5
    let p3 = 0, e = 0;
    dist.forEach((pr, k) => { if (k >= need) p3 += pr; e += k * pr; });
    // "s" is the single number we compare options by
    return { p3, e, s: p3 + 1e-4 * e };
  }

  function combos2(arr) {
    const out = [];
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
    return out;
  }
  const other = who => (who === 'we' ? 'they' : 'we');

  // P[w][t] = chance OUR player w beats THEIR player t
  function pairProb(P, st, targetWho, targetId, candId) {
    return targetWho === 'we' ? P[targetId][candId] : P[candId][targetId];
  }
  function pickBetter(best, v, wantMax) {
    if (!best) return v;
    return wantMax ? (v.s > best.s ? v : best) : (v.s < best.s ? v : best);
  }

  /* State shape (used by the screen code too):
     { step: 1..4,
       we: [ids still unpaired, NOT counting the target],
       they: [same],
       target: { who:'we'|'they', id },   // player waiting to be matched
       pairs: [[weId, theyId], ...] }     // matchups already fixed            */

  // Value of the game once a pair has been offered and one candidate chosen
  function afterChoose(P, st, pair, c) {
    const X = st.target.who, Y = other(X);
    const t = st.target;
    const floater = pair[0] === c ? pair[1] : pair[0];
    const newPair = X === 'we' ? [t.id, c] : [c, t.id];
    const pairs = st.pairs.concat([newPair]);
    const yList = st[Y].filter(x => x !== pair[0] && x !== pair[1]);
    if (st.step === 4) {
      // the last two players are forced to play each other
      const last = st[X][0];
      const lastPair = X === 'we' ? [last, floater] : [floater, last];
      return finish(P, pairs.concat([lastPair]));
    }
    const next = { step: st.step + 1, target: { who: Y, id: floater }, pairs };
    next[X] = st[X].slice();
    next[Y] = yList;
    return stateValue(P, next);
  }

  function finish(P, pairs) {
    const ps = pairs.map(([w, t]) => P[w][t]);
    const v = evaluate(ps);
    v.pairs = pairs;
    return v;
  }

  // Value once Y has offered `pair`: X then chooses
  function afterNominate(P, st, pair) {
    const X = st.target.who;
    let best = null;
    for (const c of pair) best = pickBetter(best, afterChoose(P, st, pair, c), X === 'we');
    return best;
  }

  // Value of a state where Y is about to nominate two players
  function stateValue(P, st) {
    const X = st.target.who, Y = other(X);
    const pairs = st[Y].length === 2 ? [st[Y].slice()] : combos2(st[Y]);
    let best = null;
    for (const pr of pairs) best = pickBetter(best, afterNominate(P, st, pr), Y === 'we');
    return best;
  }

  // ---------- helpers the screen uses ----------
  function freshState(nWe = 5, nThey = 5) {
    return {
      step: 1,
      we: [...Array(nWe).keys()],
      they: [...Array(nThey).keys()],
      target: null,
      pairs: []
    };
  }

  // Step 1: Team B chooses the first player. who = 'we' or 'they'.
  function stateAfterFirstPick(st0, who, id) {
    const st = { step: 1, we: st0.we.slice(), they: st0.they.slice(), target: { who, id }, pairs: [] };
    st[who] = st[who].filter(x => x !== id);
    return st;
  }
  // Ranked list of first picks for a side (value from OUR point of view)
  function rankFirstPicks(P, st0, who) {
    const rows = st0[who].map(id => ({ id, v: stateValue(P, stateAfterFirstPick(st0, who, id)) }));
    rows.sort((a, b) => who === 'we' ? b.v.s - a.v.s : a.v.s - b.v.s);
    return rows;
  }

  // Y nominates a pair. Returns every possible pair with its value and what X would do.
  function rankNominations(P, st) {
    const X = st.target.who, Y = other(X);
    const pairs = st[Y].length === 2 ? [st[Y].slice()] : combos2(st[Y]);
    const rows = pairs.map(pair => {
      const choices = pair.map(c => ({ id: c, v: afterChoose(P, st, pair, c) }));
      const v = choices.reduce((b, c) => pickBetter(b, c.v, X === 'we'), null);
      const pick = choices.find(c => c.v === v);
      return { pair, choices, v, pick: pick.id };
    });
    rows.sort((a, b) => Y === 'we' ? b.v.s - a.v.s : a.v.s - b.v.s);
    return rows;
  }

  // X chooses between the two offered players. Ranked from X's point of view.
  function rankChoices(P, st, pair) {
    const X = st.target.who;
    const rows = pair.map(c => ({ id: c, v: afterChoose(P, st, pair, c) }));
    rows.sort((a, b) => X === 'we' ? b.v.s - a.v.s : a.v.s - b.v.s);
    return rows;
  }

  // Apply a completed choice to a state (used when the user records what happened)
  function applyChoice(st, pair, c) {
    const X = st.target.who, Y = other(X), t = st.target;
    const floater = pair[0] === c ? pair[1] : pair[0];
    const newPair = X === 'we' ? [t.id, c] : [c, t.id];
    const pairs = st.pairs.concat([newPair]);
    if (st.step === 4) {
      const last = st[X][0];
      const lastPair = X === 'we' ? [last, floater] : [floater, last];
      return { step: 5, done: true, we: [], they: [], target: null, pairs: pairs.concat([lastPair]) };
    }
    const next = { step: st.step + 1, target: { who: Y, id: floater }, pairs };
    next[X] = st[X].slice();
    next[Y] = st[Y].filter(x => x !== pair[0] && x !== pair[1]);
    return next;
  }

  const api = {
    DEFAULT_MAP, evaluate, winDistribution, stateValue, afterNominate, afterChoose,
    freshState, stateAfterFirstPick, rankFirstPicks, rankNominations, rankChoices,
    applyChoice, finish
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
