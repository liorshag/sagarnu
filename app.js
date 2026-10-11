'use strict';

/* ---------- saved in localStorage ---------- */
const KEY = 'sagarnu.v1';
// { providers: [8], seen: ['movie-346648', ...], lastFilters: {...} }
function load(){ try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save(data){ try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} }
function patchSaved(changes){ save({ ...load(), ...changes }); }
function getSeen(){ return load().seen || []; }
function addSeen(id){
  const seen = getSeen();
  if (!seen.includes(id)) patchSaved({ seen: [...seen, id] });
}

/* ---------- state ---------- */
let catalog;
const saved = load();
const state = {
  screen: 'home',
  viewers: saved.lastFilters?.viewers || 2,
  filters: {
    type: 'movie', maxRuntime: 120, genres: [], providers: saved.providers || [], // providers = TMDB ids
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

/* ---------- load the catalog ---------- */
async function init(){
  try {
    const res = await fetch('titles.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    catalog = await res.json();
  } catch (err) {
    console.error('Failed to load titles.json', err);
    return show('error');
  }
  // keep only saved services that still exist in the catalog
  const known = catalog.providers.map(p => p.id);
  state.filters.providers = state.filters.providers.filter(id => known.includes(id));
  renderHome();
  renderSetup();
  show('home');
}

/* ---------- screens ---------- */
const renderers = { setup: renderSetup, pass: renderPass, vote: renderVote, result: renderResult };

function show(screen){
  state.screen = screen;
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === screen);
  window.scrollTo(0, 0);
  renderers[screen]?.();
}

function renderHome(){
  const date = new Date(catalog.updated + 'T00:00:00');
  const nice = isNaN(date) ? catalog.updated
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  $('updated').textContent = `List updated ${nice}` + (catalog.sample ? ' · Sample data' : '');
}

/* ---------- setup ---------- */
function chip(label, pressed, data){
  const b = el('button', 'chip', label);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  Object.assign(b.dataset, data);
  return b;
}

function genresFor(type){
  const present = new Set(catalog.titles.filter(t => t.type === type).flatMap(t => t.genres));
  return catalog.genres.filter(g => present.has(g));
}

function renderSetup(){
  const f = state.filters;

  $('viewers-chips').replaceChildren(
    ...[2, 3, 4, 5, 6].map(n => chip(String(n), n === state.viewers, { viewers: n }))
  );

  for (const b of $('type-chips').children) b.setAttribute('aria-pressed', String(b.dataset.type === f.type));

  $('time-field').hidden = f.type === 'series';
  for (const b of $('time-chips').children) b.setAttribute('aria-pressed', String(Number(b.dataset.time) === f.maxRuntime));

  const genres = genresFor(f.type);
  f.genres = f.genres.filter(g => genres.includes(g));
  const options = $('genre-options');
  options.replaceChildren(options.querySelector('legend'), ...genres.map(g => {
    const label = el('label', 'check');
    const input = el('input');
    input.type = 'checkbox';
    input.value = g;
    input.checked = f.genres.includes(g);
    label.append(input, el('span', 'box'), el('span', 'check-text', g));
    return label;
  }));
  renderGenreSummary();

  const providers = catalog.providers;
  $('services-field').hidden = providers.length <= 1;
  $('service-chips').replaceChildren(...providers.map(p => {
    const b = chip(p.name, f.providers.includes(p.id), { provider: p.id });
    if (p.logo) {
      const img = el('img');
      img.src = p.logo; img.alt = ''; img.width = 24; img.height = 24;
      b.prepend(img);
    }
    return b;
  }));
}

function renderGenreSummary(){
  const g = state.filters.genres;
  const summary = $('genre-summary');
  summary.textContent = g.length === 0 ? 'Any genre'
    : g.length <= 2 ? g.join(', ')
    : `${g.slice(0, 2).join(', ')} +${g.length - 2}`;
  summary.classList.toggle('is-empty', g.length === 0);
}

function setGenrePanel(open){
  $('genre-panel').hidden = !open;
  document.querySelector('[data-action="genres-toggle"]').setAttribute('aria-expanded', String(open));
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
  else if (d.provider) {
    f.providers = toggle(f.providers, Number(d.provider));
    patchSaved({ providers: f.providers });
  }
  renderSetup();
}

/* ---------- building the deck ---------- */
function buildDeck(all, f, seen, used, size = 10, widened = false){
  const pool = all.filter(t =>
    t.type === f.type &&
    (!f.maxRuntime || t.type === 'series' || t.runtime == null || t.runtime <= f.maxRuntime) &&
    (f.genres.length === 0 || t.genres.some(g => f.genres.includes(g))) &&
    (f.providers.length === 0 || t.providers.some(p => f.providers.includes(p))) &&
    !seen.includes(t.id) && !used.includes(t.id)
  );
  // too few? loosen filters in this order: genres → runtime → providers
  if (pool.length < 6 && f.genres.length)    return buildDeck(all, {...f, genres: []}, seen, used, size, true);
  if (pool.length < 6 && f.maxRuntime && f.type === 'movie')
                                             return buildDeck(all, {...f, maxRuntime: 0}, seen, used, size, true);
  if (pool.length < 6 && f.providers.length) return buildDeck(all, {...f, providers: []}, seen, used, size, true);
  return { deck: weightedShuffle(pool).slice(0, size), widened };
}
// popular / well-rated titles come up a bit more often, but still random
function weightedShuffle(a){
  return a.map(t => ({ t, k: Math.random() ** (1 / Math.max(1, t.rating || 5)) }))
          .sort((x, y) => y.k - x.k).map(x => x.t);
}

function startRound(){
  let { deck, widened } = buildDeck(catalog.titles, state.filters, getSeen(), state.usedIds);
  if (!deck.length && state.usedIds.length) {
    // went through everything tonight: allow repeats
    state.usedIds = [];
    ({ deck, widened } = buildDeck(catalog.titles, state.filters, getSeen(), state.usedIds));
  }
  if (!deck.length) {
    // everything left is marked as seen: show it anyway rather than an empty deck
    ({ deck, widened } = buildDeck(catalog.titles, state.filters, [], state.usedIds));
  }
  Object.assign(state, { deck, widened, voter: 0, idx: 0, votes: [] });
  show('vote');
}

function go(){
  patchSaved({
    providers: state.filters.providers,
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
function minutes(n){ return `${n} min`; }

function facts(t){
  const parts = [];
  if (t.year) parts.push(t.year);
  if (t.genres.length) parts.push(t.genres.slice(0, 3).join(', '));
  if (t.runtime) parts.push(t.type === 'series' ? `${minutes(t.runtime)} / episode` : minutes(t.runtime));
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

  $('widened').hidden = !(state.widened && state.idx === 0);
  $('card-title').textContent = t.title;
  $('card-original').textContent = t.original && t.original !== t.title ? t.original : '';
  $('card-facts').textContent = facts(t);
  $('card-overview').textContent = t.overview;

  const service = $('card-service');
  service.replaceChildren();
  for (const id of t.providers) {
    const prov = catalog.providers.find(p => p.id === id);
    if (!prov) continue;
    if (prov.logo) {
      const img = el('img');
      img.src = prov.logo; img.alt = ''; img.width = 22; img.height = 22;
      service.append(img);
    }
    service.append(el('strong', '', prov.name));
  }
  service.append(el('span', '', 'Streaming data: JustWatch'));

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
  switch (b.dataset.action) {
    case 'start':   return show('setup');
    case 'home':    return show('home');
    case 'go':      setGenrePanel(false); return go();
    case 'ready':   return show('vote');
    case 'again':   return anotherRound();
    case 'watched': return watched();
    case 'retry':   return init();
    case 'genres-toggle': return setGenrePanel($('genre-panel').hidden);
    case 'genres-done':   return setGenrePanel(false);
    case 'genres-clear':
      state.filters.genres = [];
      return renderSetup();
  }
});

document.addEventListener('change', e => {
  const input = e.target;
  if (!input.matches('#genre-options input[type=checkbox]')) return;
  state.filters.genres = toggle(state.filters.genres, input.value);
  renderGenreSummary();
});

init();
