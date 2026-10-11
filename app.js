'use strict';

/* ---------- saved in localStorage ---------- */
const KEY = 'sagarnu.v1';
// { seen: ['movie-346648', ...], lastFilters: {...} }
function load(){ try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save(data){ try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} }
function patchSaved(changes){ save({ ...load(), ...changes }); }
function getSeen(){ return load().seen || []; }
function addSeen(id){
  const seen = getSeen();
  if (!seen.includes(id)) patchSaved({ seen: [...seen, id] });
}

/* ---------- state ---------- */
const DECK_SIZE = 10;
const saved = load();
const state = {
  screen: 'home',
  viewers: saved.lastFilters?.viewers || 2,
  filters: {
    type: 'movie', maxRuntime: 120, genres: [],   // genres = names, mapped to TMDB ids per type
    ...pick(saved.lastFilters, ['type', 'maxRuntime', 'genres'])
  },
  deck: [],        // the titles for this round
  widened: false,  // filters were loosened to fill the deck
  voter: 0,
  idx: 0,
  votes: [],       // votes[voter][idx] = 'yes' | 'no' | 'seen'
  usedIds: []      // titles shown in earlier rounds tonight
};

function pick(obj, keys){
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const $ = id => document.getElementById(id);
function el(tag, cls, text){
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------- data from TMDB (via /api, which keeps the token on the server) ---------- */
class ApiError extends Error {
  constructor(code, message){ super(message || code); this.code = code; }
}

const responses = new Map();   // url -> Promise, so repeat requests reuse the answer
function getJSON(url){
  if (!responses.has(url)) {
    const p = fetch(url, { headers: { accept: 'application/json' } }).then(async res => {
      const body = await res.json().catch(() => null);
      if (!body) throw new ApiError('server_error');
      if (!res.ok) throw new ApiError(body.error || 'server_error', body.message);
      return body;
    });
    responses.set(url, p);
    p.catch(() => responses.delete(url));   // let failures be retried
  }
  return responses.get(url);
}

let genres = null;             // { movie: [{id, name}], series: [{id, name}] }
async function ensureGenres(){
  if (!genres) {
    const data = await getJSON('/api/genres');
    const sort = list => [...list].sort((a, b) => a.name.localeCompare(b.name));
    genres = { movie: sort(data.movie), series: sort(data.series) };
  }
  return genres;
}

function genreIds(f){
  return genres[f.type].filter(g => f.genres.includes(g.name)).map(g => g.id);
}

// one pool of fetched titles per filter combination, filled page by page
const pools = new Map();
function poolFor(f){
  const ids = genreIds(f);
  const runtime = f.type === 'movie' ? f.maxRuntime : 0;
  const key = `${f.type}|${ids.join(',')}|${runtime}`;
  if (!pools.has(key)) pools.set(key, { type: f.type, ids, runtime, items: new Map(), nextPage: 1, totalPages: Infinity });
  return pools.get(key);
}

async function loadNextPage(pool){
  const q = new URLSearchParams({ type: pool.type, page: pool.nextPage });
  if (pool.ids.length) q.set('genres', pool.ids.join(','));
  if (pool.runtime) q.set('maxRuntime', pool.runtime);
  const data = await getJSON(`/api/titles?${q}`);
  for (const t of data.results) if (!pool.items.has(t.id)) pool.items.set(t.id, t);   // dedupe across pages
  pool.totalPages = data.totalPages;
  pool.nextPage++;
}

// fetch more pages until there are enough fresh titles or the results run out
async function freshTitles(f, seen, used, want = DECK_SIZE * 2, maxPages = 4){
  const pool = poolFor(f);
  const fresh = () => [...pool.items.values()].filter(t => !seen.includes(t.id) && !used.includes(t.id));
  for (let n = 0; fresh().length < want && pool.nextPage <= pool.totalPages && n < maxPages; n++) {
    await loadNextPage(pool);
  }
  return fresh();
}

/* ---------- screens ---------- */
const renderers = { setup: renderSetup, pass: renderPass, vote: renderVote, result: renderResult };

function show(screen){
  state.screen = screen;
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === screen);
  window.scrollTo(0, 0);
  renderers[screen]?.();
}

let retryAction = null;
function showError(err, retry){
  console.error(err);
  const messages = {
    missing_token: "The app isn't connected to TMDB yet. Add TMDB_ACCESS_TOKEN to the site's environment variables.",
    tmdb_auth: 'TMDB rejected the access token. Check TMDB_ACCESS_TOKEN.',
    tmdb_busy: 'TMDB is busy right now. Try again in a moment.'
  };
  $('error-detail').textContent = messages[err.code] || 'Check your connection and try again.';
  retryAction = retry;
  show('error');
}

async function openSetup(){
  if (!genres) {
    show('loading');
    try { await ensureGenres(); }
    catch (err) { return showError(err, openSetup); }
  }
  show('setup');
}

function init(){
  show('home');
  ensureGenres().catch(() => {});   // warm up; errors surface when setup opens
}

/* ---------- setup ---------- */
function chip(label, pressed, data){
  const b = el('button', 'chip', label);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  Object.assign(b.dataset, data);
  return b;
}

function renderSetup(){
  const f = state.filters;

  $('viewers-chips').replaceChildren(
    ...[2, 3, 4, 5, 6].map(n => chip(String(n), n === state.viewers, { viewers: n }))
  );

  for (const b of $('type-chips').children) b.setAttribute('aria-pressed', String(b.dataset.type === f.type));

  $('time-field').hidden = f.type === 'series';
  for (const b of $('time-chips').children) b.setAttribute('aria-pressed', String(Number(b.dataset.time) === f.maxRuntime));

  const names = genres[f.type].map(g => g.name);
  f.genres = f.genres.filter(g => names.includes(g));
  $('genre-pills').replaceChildren(...names.map(g => {
    const b = el('button', 'pill');
    b.type = 'button';
    b.dataset.genre = g;
    b.setAttribute('aria-pressed', String(f.genres.includes(g)));
    b.append(el('span', 'tick'), el('span', '', g));
    b.firstChild.setAttribute('aria-hidden', 'true');
    return b;
  }));
  renderGenreSummary();
}

function renderGenreSummary(){
  const n = state.filters.genres.length;
  $('genre-count').hidden = n === 0;
  $('genre-summary').textContent = `${n} selected`;
}

function toggleGenre(b){
  const f = state.filters;
  f.genres = toggle(f.genres, b.dataset.genre);
  b.setAttribute('aria-pressed', String(f.genres.includes(b.dataset.genre)));
  renderGenreSummary();
}

function toggle(list, value){
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value];
}

function onSetupChip(b){
  const f = state.filters;
  const d = b.dataset;
  if (d.viewers) state.viewers = Number(d.viewers);
  else if (d.type) f.type = d.type;
  else if (d.time) f.maxRuntime = Number(d.time);
  renderSetup();
}

/* ---------- building the deck ---------- */
async function buildDeck(f, seen, used, size = DECK_SIZE){
  // too few? loosen filters in this order: genres → runtime
  const tries = [f];
  if (f.genres.length) tries.push({ ...f, genres: [] });
  if (f.type === 'movie' && f.maxRuntime) tries.push({ ...f, genres: [], maxRuntime: 0 });

  let best = { deck: [], widened: false };
  for (let i = 0; i < tries.length; i++) {
    const fresh = await freshTitles(tries[i], seen, used);
    const result = { deck: weightedShuffle(fresh).slice(0, size), widened: i > 0 };
    if (fresh.length >= 6) return result;
    if (result.deck.length > best.deck.length) best = result;
  }
  return best;
}
// popular / well-rated titles come up a bit more often, but still random
function weightedShuffle(a){
  return a.map(t => ({ t, k: Math.random() ** (1 / Math.max(1, t.rating || 5)) }))
          .sort((x, y) => y.k - x.k).map(x => x.t);
}

async function startRound(){
  show('loading');
  try {
    let r = await buildDeck(state.filters, getSeen(), state.usedIds);
    if (!r.deck.length && state.usedIds.length) {
      // went through everything tonight: allow repeats
      state.usedIds = [];
      r = await buildDeck(state.filters, getSeen(), state.usedIds);
    }
    if (!r.deck.length) {
      // everything left is marked as seen: show it anyway rather than an empty deck
      r = await buildDeck(state.filters, [], state.usedIds);
    }
    if (!r.deck.length) return show('empty');
    Object.assign(state, { deck: r.deck, widened: r.widened, voter: 0, idx: 0, votes: [] });
    show('vote');
  } catch (err) {
    showError(err, startRound);
  }
}

function go(){
  patchSaved({
    lastFilters: { viewers: state.viewers, ...pick(state.filters, ['type', 'maxRuntime', 'genres']) }
  });
  state.usedIds = [];
  startRound();
}

/* ---------- posters ---------- */
function hue(id){
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function fallback(t){
  const h = hue(t.id);
  const box = el('div', 'poster-fallback', t.title);
  box.style.background = `linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 40) % 360} 50% 20%))`;
  return box;
}

function poster(t, cls, width, height, lazy = true){
  const wrap = el('div', cls);
  if (t.poster) {
    const img = el('img');
    img.src = t.poster;
    img.alt = '';
    img.width = width; img.height = height;
    if (lazy) img.loading = 'lazy';
    img.onerror = () => img.replaceWith(fallback(t));
    wrap.append(img);
  } else {
    wrap.append(fallback(t));
  }
  return wrap;
}

/* ---------- vote ---------- */
const TYPE_LABEL = { movie: 'Movie', series: 'Series' };

function facts(t){
  const parts = [TYPE_LABEL[t.type]];
  if (t.year) parts.push(t.year);
  if (t.genres.length) parts.push(t.genres.slice(0, 3).join(', '));
  return parts.join(' · ');
}

function renderVote(){
  const t = state.deck[state.idx];
  const total = state.deck.length;

  $('progress').replaceChildren(...state.deck.map((_, i) =>
    el('span', i < state.idx ? 'done' : i === state.idx ? 'now' : '')
  ));
  $('vote-viewer').textContent = `Viewer ${state.voter + 1} of ${state.viewers}`;
  $('vote-count').textContent = `${state.idx + 1} / ${total}`;

  const p = poster(t, 'poster-inner', 342, 513, false);
  p.style.display = 'contents';
  const wrap = $('poster-wrap');
  wrap.replaceChildren(p);
  if (t.rating) wrap.append(el('span', 'rating-badge', `TMDB ${t.rating.toFixed(1)}`));
  wrap.append(el('span', 'type-badge', TYPE_LABEL[t.type]));

  $('widened').hidden = !(state.widened && state.idx === 0);
  $('card-title').textContent = t.title;
  $('card-original').textContent = t.original && t.original !== t.title ? t.original : '';
  $('card-facts').textContent = facts(t);
  $('card-overview').textContent = t.overview || 'No description available yet.';

  $('card-service').replaceChildren(
    el('strong', '', 'Netflix Israel'),
    el('span', '', 'Availability by JustWatch, may change')
  );

  // preload the next card's poster
  const next = state.deck[state.idx + 1];
  if (next?.poster) new Image().src = next.poster;
}

let locked = false;
function vote(v){            // v = 'yes' | 'no' | 'seen'
  if (locked) return;
  locked = true;
  const buttons = document.querySelectorAll('[data-vote]');
  buttons.forEach(b => b.disabled = true);
  setTimeout(() => { locked = false; buttons.forEach(b => b.disabled = false); }, 250);

  (state.votes[state.voter] ||= [])[state.idx] = v;
  if (v === 'seen') addSeen(state.deck[state.idx].id);
  state.idx++;
  if (state.idx < state.deck.length) return show('vote');
  state.idx = 0; state.voter++;
  show(state.voter < state.viewers ? 'pass' : 'result');
}

/* ---------- pass ---------- */
function renderPass(){
  $('pass-viewer').textContent = `Viewer ${state.voter + 1} of ${state.viewers}`;
}

/* ---------- result ---------- */
function computeResult(deck, votes, viewers){
  const ranked = deck.map((t, i) => {
    const v = votes.map(row => row[i]);
    return { t, i, yes: v.filter(x => x === 'yes').length, seen: v.includes('seen') };
  })
  .filter(r => !r.seen)                       // anyone has seen it → out this round
  .sort((a, b) => b.yes - a.yes || a.i - b.i);
  const top = ranked[0];
  return {
    winner: top && top.yes > 0 ? top : null,
    full: !!top && top.yes === viewers,
    ranked
  };
}

let lastResult = null;
function renderResult(){
  const r = computeResult(state.deck, state.votes, state.viewers);
  lastResult = r;
  const w = r.winner;

  $('result-title').textContent = !w ? 'Nobody said yes.'
    : r.full ? 'Deal! Everyone said yes'
    : `Closest to agreement: ${w.yes} of ${state.viewers}`;

  const winner = $('winner');
  winner.replaceChildren();
  if (w) {
    const info = el('div');
    info.append(el('h2', 'winner-title', w.t.title), el('p', 'winner-facts', facts(w.t)));
    winner.append(poster(w.t, 'mini-poster', 120, 180, false), info);
  }

  const where = $('where');
  const hasLink = !!(w && w.t.watchLink);
  $('result-actions').hidden = !hasLink;
  if (hasLink) where.href = w.t.watchLink;

  const rest = r.ranked.filter(x => x !== w);
  $('rest-label').hidden = rest.length === 0;
  $('ranked').replaceChildren(...rest.map(x => {
    const li = el('li');
    const name = el('div', 'ranked-title', x.t.title);
    name.append(el('small', '', facts(x.t)));
    const score = el('span', 'score' + (x.yes === state.viewers ? ' full' : ''), `${x.yes} / ${state.viewers}`);
    li.append(poster(x.t, 'mini-poster', 48, 72), name, score);
    return li;
  }));

  $('watched').hidden = !w;
}

function anotherRound(){
  state.usedIds.push(...state.deck.map(t => t.id));
  startRound();
}

function watched(){
  if (lastResult?.winner) addSeen(lastResult.winner.t.id);
  anotherRound();
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.vote) return vote(b.dataset.vote);
  if (b.classList.contains('chip')) return onSetupChip(b);
  if (b.dataset.genre) return toggleGenre(b);
  switch (b.dataset.action) {
    case 'start':   return openSetup();
    case 'home':    return show('home');
    case 'go':      return go();
    case 'ready':   return show('vote');
    case 'again':   return anotherRound();
    case 'watched': return watched();
    case 'retry':   return retryAction ? retryAction() : openSetup();
    case 'genres-clear':
      state.filters.genres = [];
      return renderSetup();
  }
});

init();
