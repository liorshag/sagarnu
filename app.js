'use strict';

/* ---------- saved in localStorage ---------- */
const KEY = 'sagarnu.v1';
// { seen: ['movie-346648', ...], lastFilters: {...}, name: 'Noa', rooms: { CODE: { id, key, expiresAt } }, votes: { 'CODE:round': {...} } }
function load(){ try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save(data){ try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} }
function patchSaved(changes){ save({ ...load(), ...changes }); }
function getSeen(){ return load().seen || []; }
function addSeen(id){
  const seen = getSeen();
  if (!seen.includes(id)) patchSaved({ seen: [...seen, id] });
}

/* ---------- state ---------- */
const LOCAL_DECK = 10;   // per person when passing one phone
const ROOM_DECK = 15;    // everyone swipes the same deck on their own phone
const MAX_GENRES = 3;
const saved = load();
const state = {
  screen: 'home',
  mode: 'room',          // 'room' = own phones, 'local' = pass one phone
  viewers: 2,
  filters: { vibe: 'mix', maxRuntime: 120, genres: [] },   // genres = names
  deck: [],
  widened: false,
  voter: 0,
  idx: 0,
  votes: [],             // local mode: votes[voter][idx] = 'yes' | 'no' | 'seen'
  myVotes: {},           // room mode: { titleId: vote }
  usedIds: [],
  room: null,            // latest room view from the server
  member: null,          // { id, key } for the current room
  roundShown: 0
};
Object.assign(state, pick(saved.lastFilters, ['mode', 'viewers']));
Object.assign(state.filters, pick(saved.lastFilters, ['vibe', 'maxRuntime', 'genres']));

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
function icon(name, cls = 'icon'){
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

let toastTimer;
function toast(text){
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------- API ---------- */
class ApiError extends Error {
  constructor(code, message){ super(message || code); this.code = code; }
}

async function request(url, options = {}){
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) }
    });
  } catch {
    throw new ApiError('network');
  }
  const body = await res.json().catch(() => null);
  if (!body) throw new ApiError('server_error');
  if (!res.ok) throw new ApiError(body.error || 'server_error', body.message);
  return body;
}

const responses = new Map();   // GET url -> Promise, so repeat requests reuse the answer
function getJSON(url){
  if (!responses.has(url)) {
    const p = request(url);
    responses.set(url, p);
    p.catch(() => responses.delete(url));   // let failures be retried
  }
  return responses.get(url);
}
const post = (url, body) => request(url, { method: 'POST', body: JSON.stringify(body) });

/* ---------- TMDB data (via /api, which keeps the token on the server) ---------- */
let genres = null;             // { movie: [{id, name}], series: [{id, name}] }
async function ensureGenres(){
  if (!genres) {
    const data = await getJSON('/api/genres');
    const sort = list => [...list].sort((a, b) => a.name.localeCompare(b.name));
    genres = { movie: sort(data.movie), series: sort(data.series) };
  }
  return genres;
}

// TMDB names some TV genres differently from movie genres
const TV_ALIAS = { 'Action': 'Action & Adventure', 'Adventure': 'Action & Adventure', 'Science Fiction': 'Sci-Fi & Fantasy', 'Fantasy': 'Sci-Fi & Fantasy', 'War': 'War & Politics' };
const MOVIE_ALIAS = { 'Action & Adventure': ['Action', 'Adventure'], 'Sci-Fi & Fantasy': ['Science Fiction', 'Fantasy'], 'War & Politics': ['War'] };

function genreNamesFor(vibe){
  return genres[vibe === 'series' ? 'series' : 'movie'].map(g => g.name);
}

function genreIds(type, names){
  const wanted = new Set(names);
  for (const n of names) {
    if (type === 'series' && TV_ALIAS[n]) wanted.add(TV_ALIAS[n]);
    if (type === 'movie' && MOVIE_ALIAS[n]) MOVIE_ALIAS[n].forEach(m => wanted.add(m));
  }
  return genres[type].filter(g => wanted.has(g.name)).map(g => g.id);
}

// one pool of fetched titles per filter combination, filled page by page
const pools = new Map();
function poolFor(type, names, maxRuntime){
  const ids = genreIds(type, names);
  const runtime = type === 'movie' ? maxRuntime : 0;
  const key = `${type}|${ids.join(',')}|${runtime}`;
  if (!pools.has(key)) pools.set(key, { type, ids, runtime, items: new Map(), nextPage: 1, totalPages: Infinity });
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
async function freshTitles(type, names, maxRuntime, seen, used, want, maxPages = 4){
  const pool = poolFor(type, names, maxRuntime);
  const fresh = () => [...pool.items.values()].filter(t => !seen.includes(t.id) && !used.includes(t.id));
  for (let n = 0; fresh().length < want && pool.nextPage <= pool.totalPages && n < maxPages; n++) {
    await loadNextPage(pool);
  }
  return fresh();
}

// popular / well-rated titles come up a bit more often, but still random
function weightedShuffle(a){
  return a.map(t => ({ t, k: Math.random() ** (1 / Math.max(1, t.rating || 5)) }))
          .sort((x, y) => y.k - x.k).map(x => x.t);
}

async function deckForType(type, f, seen, used, size){
  // too few? loosen filters in this order: genres → runtime
  const tries = [{ names: f.genres, runtime: f.maxRuntime }];
  if (f.genres.length) tries.push({ names: [], runtime: f.maxRuntime });
  if (type === 'movie' && f.maxRuntime) tries.push({ names: [], runtime: 0 });

  let best = { titles: [], widened: false };
  for (let i = 0; i < tries.length; i++) {
    const fresh = await freshTitles(type, tries[i].names, tries[i].runtime, seen, used, size * 2);
    const result = { titles: weightedShuffle(fresh), widened: i > 0 };
    if (fresh.length >= Math.min(6, size)) return result;
    if (result.titles.length > best.titles.length) best = result;
  }
  return best;
}

async function buildDeck(f, seen, used, size){
  const types = f.vibe === 'mix' ? ['movie', 'series'] : [f.vibe];
  const parts = await Promise.all(types.map(type =>
    deckForType(type, f, seen, used, types.length > 1 ? Math.ceil(size / 2) : size)
  ));
  let deck;
  if (parts.length === 1) {
    deck = parts[0].titles.slice(0, size);
  } else {
    // half movies, half series; if one side runs short, the other fills in
    const [m, s] = parts.map(p => p.titles);
    const half = Math.ceil(size / 2);
    const mCount = Math.min(m.length, Math.max(half, size - s.length));
    deck = weightedShuffle([...m.slice(0, mCount), ...s.slice(0, size - mCount)]);
  }
  return { deck, widened: parts.some(p => p.widened) };
}

/* ---------- screens ---------- */
const renderers = { create: renderCreate, lobby: renderLobby, pass: renderPass, vote: renderVote, waiting: renderWaiting, result: renderResult };

function show(screen){
  state.screen = screen;
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === screen);
  window.scrollTo(0, 0);
  renderers[screen]?.();
  updatePolling();
}

function showLoading(title = 'Finding titles…'){
  $('loading-title').textContent = title;
  show('loading');
}

let retryAction = null;
const ERROR_TEXT = {
  missing_token: "The app isn't connected to TMDB yet. Add TMDB_ACCESS_TOKEN to the site's environment variables.",
  tmdb_auth: 'TMDB rejected the access token. Check TMDB_ACCESS_TOKEN.',
  tmdb_busy: 'TMDB is busy right now. Try again in a moment.',
  room_not_found: 'No room with that code. Check the code with your host.',
  room_expired: 'This room has expired. Rooms last 24 hours. Start a new one!',
  room_full: 'This room is full (10 people max).',
  not_member: "You're no longer in this room. Join again with the code.",
  not_host: 'Only the host can do that.',
  network: 'Check your connection and try again.'
};
function errorText(err){ return ERROR_TEXT[err.code] || err.message || 'Check your connection and try again.'; }

function showError(err, retry, title = 'Something went wrong'){
  console.error(err);
  $('error-title').textContent = title;
  $('error-detail').textContent = errorText(err);
  retryAction = retry;
  show('error');
}

/* ---------- home ---------- */
function bg(elm, url){ elm.style.backgroundImage = url ? `url("${url}")` : ''; }

async function loadHomeRows(){
  for (const [type, rowId] of [['movie', 'row-movies'], ['series', 'row-series']]) {
    const row = $(rowId);
    row.replaceChildren(...Array.from({ length: 6 }, () => el('div', 'row-skeleton')));
    getJSON(`/api/titles?type=${type}&page=1`).then(data => {
      row.replaceChildren(...data.results.map(t => {
        const item = el('div', 'row-item');
        item.title = t.title;
        item.append(poster(t, 'mini-poster', 112, 168));
        return item;
      }));
      if (type === 'movie') {
        const pick = data.results.filter(t => t.backdrop).slice(0, 6);
        const hero = pick[Math.floor(Math.random() * pick.length)];
        if (hero) bg($('billboard-img'), hero.backdrop);
      }
    }).catch(err => {
      row.replaceWith(Object.assign(el('p', 'row-note', type === 'movie' ? errorText(err) : "Couldn't load titles right now."), { id: rowId }));
    });
  }
}

/* ---------- create ---------- */
function chip(label, pressed, data){
  const b = el('button', 'chip', label);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  Object.assign(b.dataset, data);
  return b;
}

async function openCreate(){
  if (!genres) {
    showLoading('Getting ready…');
    try { await ensureGenres(); }
    catch (err) { return showError(err, openCreate, "We couldn't reach the movie database"); }
  }
  show('create');
}

function renderCreate(){
  const f = state.filters;
  const room = state.mode === 'room';

  for (const b of document.querySelectorAll('.mode-card')) b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
  for (const b of document.querySelectorAll('.vibe')) b.setAttribute('aria-checked', String(b.dataset.vibe === f.vibe));

  $('name-field').hidden = !room;
  if (!$('host-name').value) $('host-name').value = load().name || '';
  $('viewers-field').hidden = room;
  $('viewers-chips').replaceChildren(
    ...[2, 3, 4, 5, 6].map(n => chip(String(n), n === state.viewers, { viewers: n }))
  );

  $('time-field').hidden = f.vibe === 'series';
  for (const b of $('time-chips').children) b.setAttribute('aria-pressed', String(Number(b.dataset.time) === f.maxRuntime));

  const names = genreNamesFor(f.vibe);
  f.genres = f.genres.filter(g => names.includes(g)).slice(0, MAX_GENRES);
  $('genre-pills').replaceChildren(...names.map(g => {
    const b = el('button', 'pill');
    b.type = 'button';
    b.dataset.genre = g;
    b.append(el('span', 'tick'), el('span', '', g));
    b.firstChild.setAttribute('aria-hidden', 'true');
    return b;
  }));
  renderGenrePills();

  $('create-btn').textContent = room ? 'Create room' : 'Start swiping';
  $('create-error').hidden = true;
}

function renderGenrePills(){
  const chosen = state.filters.genres;
  const full = chosen.length >= MAX_GENRES;
  for (const b of $('genre-pills').children) {
    const on = chosen.includes(b.dataset.genre);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = full && !on;
  }
  $('genre-count').hidden = chosen.length === 0;
  $('genre-summary').textContent = `${chosen.length}/${MAX_GENRES} selected`;
}

function toggle(list, value){
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value];
}

function rememberFilters(){
  patchSaved({ lastFilters: { mode: state.mode, viewers: state.viewers, ...state.filters } });
}

async function submitCreate(){
  rememberFilters();
  if (state.mode === 'local') return startLocal();

  const name = $('host-name').value.trim();
  if (!name) {
    $('create-error').textContent = 'Enter your name so friends know who you are.';
    $('create-error').hidden = false;
    $('host-name').focus();
    return;
  }
  patchSaved({ name });
  showLoading('Building your deck…');
  try {
    const { deck } = await buildDeck(state.filters, getSeen(), [], ROOM_DECK);
    if (!deck.length) return show('empty');
    const res = await post('/api/rooms', { name, vibe: state.filters.vibe, genres: state.filters.genres, deck });
    enterRoom(res.member, res.room);
  } catch (err) {
    showError(err, submitCreate, "We couldn't create the room");
  }
}

/* ---------- one phone ---------- */
async function startLocal(){
  state.usedIds = [];
  state.room = null;
  await startLocalRound();
}

async function startLocalRound(){
  showLoading();
  try {
    let r = await buildDeck(state.filters, getSeen(), state.usedIds, LOCAL_DECK);
    if (!r.deck.length && state.usedIds.length) {
      // went through everything tonight: allow repeats
      state.usedIds = [];
      r = await buildDeck(state.filters, getSeen(), state.usedIds, LOCAL_DECK);
    }
    if (!r.deck.length) r = await buildDeck(state.filters, [], state.usedIds, LOCAL_DECK);
    if (!r.deck.length) return show('empty');
    Object.assign(state, { deck: r.deck, widened: r.widened, voter: 0, idx: 0, votes: [] });
    show('vote');
  } catch (err) {
    showError(err, startLocalRound, "We couldn't reach the movie database");
  }
}

function renderPass(){
  $('pass-viewer').textContent = `Viewer ${state.voter + 1} of ${state.viewers}`;
}

/* ---------- rooms ---------- */
function roomLink(code){ return `${location.origin}${location.pathname}?room=${code}`; }

function setRoomInUrl(code){
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code); else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

function savedVotesKey(){ return `${state.room.code}:${state.room.round}`; }
function persistMyVotes(){
  const all = load().votes || {};
  all[savedVotesKey()] = state.myVotes;
  // keep only the latest few rounds
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 6))) delete all[k];
  patchSaved({ votes: all });
}

function enterRoom(member, room){
  state.member = member;
  state.mode = 'room';
  const rooms = load().rooms || {};
  for (const [c, r] of Object.entries(rooms)) if (r.expiresAt < Date.now()) delete rooms[c];
  rooms[room.code] = { ...member, expiresAt: room.expiresAt };
  patchSaved({ rooms });
  setRoomInUrl(room.code);
  state.roundShown = 0;
  applyRoom(room, true);
}

function isHost(){ return state.room && state.member && state.room.hostId === state.member.id; }

// route to the right screen for the room's current state
function applyRoom(room, entering = false){
  state.room = room;
  if (room.status === 'lobby') return entering || state.screen !== 'lobby' ? show('lobby') : renderLobby();

  if (room.round !== state.roundShown) {      // a round this device hasn't started yet
    if (room.status === 'done') { state.roundShown = room.round; return show('result'); }
    return beginRoomVoting();
  }
  if (state.screen === 'vote') return;         // keep swiping; results wait until you're done
  const me = room.members.find(m => m.id === state.member?.id);
  if (room.status === 'done') return state.screen === 'result' ? renderResult() : show('result');
  if (me?.done) return state.screen === 'waiting' ? renderWaiting() : show('waiting');
  beginRoomVoting();
}

function beginRoomVoting(){
  const room = state.room;
  state.roundShown = room.round;
  state.deck = room.deck;
  state.widened = false;
  state.myVotes = (load().votes || {})[savedVotesKey()] || {};
  state.idx = room.deck.findIndex(t => !state.myVotes[t.id]);
  if (state.idx === -1) return finishRoomVoting();
  show('vote');
}

// votes are sent in order; each request carries all of this person's votes so far
let syncChain = Promise.resolve();
function syncVotes(done = false){
  const run = () => post(`/api/rooms/${state.room.code}/vote`, {
    memberId: state.member.id, key: state.member.key, round: state.room.round, votes: state.myVotes, done
  }).then(res => { state.room = res.room; return res.room; });
  const p = syncChain.then(run, run);
  syncChain = p.catch(() => {});
  return p;
}

async function finishRoomVoting(){
  showLoading('Saving your votes…');
  try {
    applyRoom(await syncVotes(true));
  } catch (err) {
    if (err.code === 'old_round') return refreshRoom();
    showError(err, finishRoomVoting, "We couldn't save your votes");
  }
}

async function refreshRoom(){
  if (!state.room) return;
  try {
    const { room } = await request(`/api/rooms/${state.room.code}`);
    applyRoom(room);
  } catch (err) {
    if (['room_not_found', 'room_expired'].includes(err.code)) {
      stopPolling();
      showError(err, () => { leaveRoom(); show('home'); }, 'Room closed');
    }
  }
}

let pollTimer = null;
function stopPolling(){ clearInterval(pollTimer); pollTimer = null; }
function updatePolling(){
  const watch = state.room && ['lobby', 'waiting', 'result'].includes(state.screen);
  if (watch && !pollTimer) pollTimer = setInterval(() => { if (!document.hidden) refreshRoom(); }, 2500);
  if (!watch) stopPolling();
}

function leaveRoom(){
  stopPolling();
  state.room = null;
  state.member = null;
  setRoomInUrl(null);
}

const AVATAR_COLORS = ['#e50914', '#2a7ade', '#46d369', '#f5a623', '#b38cff', '#e05297', '#18b4b4', '#ff7a45', '#8bc34a', '#9e9e9e'];
function memberRow(m, i, extra){
  const li = el('li');
  const av = el('span', 'avatar', m.name.charAt(0).toUpperCase());
  av.style.background = AVATAR_COLORS[i % AVATAR_COLORS.length];
  const name = el('span', 'member-name', m.name + (m.id === state.member?.id ? ' (you)' : ''));
  li.append(av, name);
  if (extra) li.append(extra);
  return li;
}

function renderLobby(){
  const room = state.room;
  if (!room) return;
  $('lobby-code').textContent = room.code;
  const vibe = { mix: 'Movies & TV shows', movie: 'Movies', series: 'TV shows' }[room.vibe];
  $('lobby-vibe').textContent = [vibe, room.genres.join(', ')].filter(Boolean).join(' · ') + ` · ${room.deck.length} titles`;
  $('lobby-count').textContent = `(${room.members.length}/10)`;
  $('lobby-members').replaceChildren(...room.members.map((m, i) =>
    memberRow(m, i, m.id === room.hostId ? el('span', 'member-tag', 'Host') : null)
  ));
  $('lobby-start').hidden = !isHost();
  $('lobby-wait').hidden = isHost();
  $('lobby-start').textContent = room.members.length > 1 ? 'Start swiping' : 'Start swiping (just me so far)';
}

function renderWaiting(){
  const room = state.room;
  if (!room) return;
  const left = room.members.filter(m => !m.done);
  $('waiting-text').textContent = left.length
    ? `Waiting for ${left.length === 1 ? left[0].name : `${left.length} people`} to finish swiping.`
    : 'Everyone is done. Getting results…';
  $('waiting-members').replaceChildren(...room.members.map((m, i) =>
    memberRow(m, i, el('span', 'member-tag' + (m.done ? ' done' : ''), m.done ? 'Done' : `${m.progress}/${room.deck.length}`))
  ));
  $('waiting-reveal').hidden = !isHost() || left.length === 0;
}

async function hostCall(action, body = {}){
  try {
    const res = await post(`/api/rooms/${state.room.code}/${action}`, { memberId: state.member.id, key: state.member.key, ...body });
    applyRoom(res.room);
  } catch (err) {
    showError(err, () => hostCall(action, body));
  }
}

async function newRoomRound(){
  state.usedIds = [...new Set([...state.usedIds, ...state.room.deck.map(t => t.id)])];
  showLoading('Building a new deck…');
  try {
    const f = { ...state.filters, vibe: state.room.vibe, genres: state.room.genres };
    let { deck } = await buildDeck(f, getSeen(), state.usedIds, ROOM_DECK);
    if (!deck.length) { state.usedIds = []; ({ deck } = await buildDeck(f, getSeen(), [], ROOM_DECK)); }
    if (!deck.length) return show('empty');
    await hostCall('round', { deck });
  } catch (err) {
    showError(err, newRoomRound, "We couldn't start a new round");
  }
}

async function share(){
  const url = roomLink(state.room.code);
  const text = `Join my NextFlick movie night! Room code ${state.room.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'NextFlick movie night', text, url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(url, 'Link copied');
}

async function copy(text, done){
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { toast(text); }
}

/* ---------- join ---------- */
function openJoin(code = ''){
  $('join-code').value = code;
  if (!$('join-name').value) $('join-name').value = load().name || '';
  $('join-error').hidden = true;
  show('join');
  (code ? $('join-name') : $('join-code')).focus();
}

async function submitJoin(e){
  e?.preventDefault();
  const code = $('join-code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const name = $('join-name').value.trim();
  const fail = text => { $('join-error').textContent = text; $('join-error').hidden = false; };
  if (code.length !== 6) return fail('Room codes have 6 letters and numbers.');
  if (!name) return fail('Enter your name so others know who you are.');
  patchSaved({ name });

  const mine = (load().rooms || {})[code];
  showLoading('Joining room…');
  try {
    if (mine) {   // already in this room on this device: pick up where you left off
      try {
        const { room } = await request(`/api/rooms/${code}`);
        if (room.members.some(m => m.id === mine.id)) return enterRoom(mine, room);
      } catch (err) { if (err.code !== 'room_not_found') throw err; }
    }
    const res = await post(`/api/rooms/${code}/join`, { name });
    enterRoom(res.member, res.room);
  } catch (err) {
    show('join');
    fail(errorText(err));
  }
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
  box.style.background = `linear-gradient(160deg, hsl(${h} 40% 34%), hsl(${(h + 40) % 360} 45% 14%))`;
  return box;
}

function poster(t, cls, width, height, lazy = true){
  const wrap = el('div', cls);
  if (t.poster) {
    const img = el('img');
    img.src = t.poster;
    img.alt = '';
    img.width = width; img.height = height;
    img.draggable = false;
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

function makeCard(t, top){
  const card = el('article', 'card ' + (top ? 'is-top' : 'is-next'));
  card.setAttribute('aria-label', top ? `${t.title}, ${facts(t)}` : '');
  if (!top) card.setAttribute('aria-hidden', 'true');

  const p = poster(t, 'card-poster', 500, 750, !top);
  const badges = el('div', 'card-badges');
  badges.append(el('span', 'badge badge-type', TYPE_LABEL[t.type]));
  if (t.rating) badges.append(el('span', 'badge badge-rating', `★ ${t.rating.toFixed(1)}`));

  const info = el('div', 'card-info');
  if (top && state.widened && state.idx === 0) info.append(el('p', 'widened', 'We widened the search a bit'));
  info.append(el('h2', 'card-title', t.title));
  if (t.original && t.original !== t.title) info.append(el('p', 'card-original', t.original));
  info.append(el('p', 'card-facts', facts(t)));
  info.append(el('p', 'card-overview', t.overview || 'No description available yet.'));
  const service = el('p', 'card-service');
  service.append(el('strong', '', 'Netflix Israel'), ' · Availability by JustWatch, may change');
  info.append(service);

  card.append(p, badges, el('span', 'stamp stamp-yes', 'YES'), el('span', 'stamp stamp-no', 'NOPE'), info);
  return card;
}

function renderVote(){
  const t = state.deck[state.idx];
  if (!t) return;
  const total = state.deck.length;

  $('progress').replaceChildren(...state.deck.map((_, i) =>
    el('span', i < state.idx ? 'done' : i === state.idx ? 'now' : '')
  ));
  $('vote-viewer').textContent = state.mode === 'local'
    ? `Viewer ${state.voter + 1} of ${state.viewers}`
    : `Room ${state.room.code}`;
  $('vote-count').textContent = `${state.idx + 1} / ${total}`;
  $('swipe-hint').hidden = state.idx > 1;

  const deck = $('deck');
  const cards = [];
  const next = state.deck[state.idx + 1];
  if (next) cards.push(makeCard(next, false));
  const top = makeCard(t, true);
  cards.push(top);
  deck.replaceChildren(...cards);
  attachSwipe(top);
  setVoteButtons(true);

  // preload the card after next
  const later = state.deck[state.idx + 2];
  if (later?.poster) new Image().src = later.poster;
}

function setVoteButtons(enabled){
  document.querySelectorAll('[data-vote]').forEach(b => { b.disabled = !enabled; });
}

const SWIPE_DISTANCE = 100;
function attachSwipe(card){
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  const yes = card.querySelector('.stamp-yes');
  const no = card.querySelector('.stamp-no');

  const move = () => {
    card.style.transform = `translate(${dx}px, ${dy * 0.25}px) rotate(${dx * 0.06}deg)`;
    yes.style.opacity = Math.max(0, Math.min(1, dx / SWIPE_DISTANCE));
    no.style.opacity = Math.max(0, Math.min(1, -dx / SWIPE_DISTANCE));
  };

  card.addEventListener('pointerdown', e => {
    if (voteLocked || (e.pointerType === 'mouse' && e.button !== 0)) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY; dx = dy = 0;
    card.setPointerCapture(e.pointerId);
    card.classList.remove('is-returning');
    card.classList.add('is-dragging');
  });
  card.addEventListener('pointermove', e => {
    if (!dragging) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    move();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('is-dragging');
    if (dx > SWIPE_DISTANCE) return castVote('yes');
    if (dx < -SWIPE_DISTANCE) return castVote('no');
    card.classList.add('is-returning');
    dx = dy = 0;
    move();
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

let voteLocked = false;
function castVote(v){            // v = 'yes' | 'no' | 'seen'
  if (voteLocked || state.screen !== 'vote') return;
  voteLocked = true;
  setVoteButtons(false);

  const card = document.querySelector('.card.is-top');
  if (card) {
    const out = { yes: 'translate(150%, 30px) rotate(24deg)', no: 'translate(-150%, 30px) rotate(-24deg)', seen: 'translate(0, -130%) scale(.9)' }[v];
    card.classList.remove('is-returning');
    card.classList.add('is-leaving');
    if (v !== 'seen') card.querySelector(v === 'yes' ? '.stamp-yes' : '.stamp-no').style.opacity = 1;
    card.style.transform = out;
    card.style.opacity = '0';
  }
  setTimeout(() => { voteLocked = false; recordVote(v); }, card ? 280 : 0);
}

function recordVote(v){
  const t = state.deck[state.idx];
  if (v === 'seen') addSeen(t.id);

  if (state.mode === 'room' && state.room) {
    state.myVotes[t.id] = v;
    persistMyVotes();
    state.idx++;
    if (state.idx < state.deck.length) {
      syncVotes().catch(() => {});   // progress for the others; final save happens at the end
      return renderVote();
    }
    return finishRoomVoting();
  }

  (state.votes[state.voter] ||= [])[state.idx] = v;
  state.idx++;
  if (state.idx < state.deck.length) return renderVote();
  state.idx = 0; state.voter++;
  show(state.voter < state.viewers ? 'pass' : 'result');
}

/* ---------- result ---------- */
const MATCH = {
  perfect:    { label: 'Perfect Match',    icon: 'trophy', sub: 'Everyone said yes. No debate needed.' },
  strong:     { label: 'Strong Match',     icon: 'star',   sub: 'Most of you want it. An easy sell for the rest.' },
  compromise: { label: 'Smart Compromise', icon: 'hand',   sub: "Not everyone's first pick, but it got the most yeses." },
  none:       { label: 'No match',         icon: 'x',      sub: 'Nobody said yes this time. Try another round with new titles.' }
};

// votes: one array per person, aligned with deck
function analyze(deck, votes){
  const n = votes.length;
  const rows = deck.map((t, i) => {
    const v = votes.map(row => row[i]);
    return { t, i, yes: v.filter(x => x === 'yes').length, seen: v.includes('seen') };
  });
  const ranked = rows
    .filter(r => !r.seen)                       // anyone has seen it → out this round
    .sort((a, b) => b.yes - a.yes || (b.t.rating || 0) - (a.t.rating || 0) || a.i - b.i);
  const top = ranked[0];
  const winner = top && top.yes > 0 ? top : null;
  const kind = !winner ? 'none'
    : winner.yes === n ? 'perfect'
    : winner.yes / n >= 2 / 3 ? 'strong'
    : 'compromise';
  // wildcard: a title only some people loved, best-rated first
  const wildcard = ranked
    .filter(r => r !== winner && r.yes > 0 && (!winner || r.yes < winner.yes || ranked.length > 3))
    .sort((a, b) => a.yes - b.yes || (b.t.rating || 0) - (a.t.rating || 0))[0] || null;
  return { n, winner, kind, wildcard, ranked, seen: rows.filter(r => r.seen) };
}

function currentVotes(){
  if (state.mode === 'room' && state.room?.results) {
    return state.room.results.map(p => state.room.deck.map(t => p.votes[t.id] || null));
  }
  return state.votes;
}

let lastResult = null;
function renderResult(){
  const deck = state.mode === 'room' && state.room ? state.room.deck : state.deck;
  const votes = currentVotes();
  if (!deck.length || !votes.length) return;
  const r = analyze(deck, votes);
  lastResult = r;
  const w = r.winner;
  const m = MATCH[r.kind];

  const badge = $('match-badge');
  badge.className = `match-badge ${r.kind}`;
  badge.replaceChildren(icon(m.icon), document.createTextNode(m.label));
  $('result-title').textContent = w ? w.t.title : 'Nobody said yes';
  $('result-sub').textContent = w && r.kind !== 'perfect'
    ? `${m.sub} ${w.yes} of ${r.n} said yes.`
    : m.sub;
  $('result-facts').textContent = w ? facts(w.t) : '';
  bg($('result-img'), w ? (w.t.backdrop || w.t.poster) : null);

  const where = $('where');
  const hasLink = !!(w && w.t.watchLink);
  $('result-actions').hidden = !hasLink;
  if (hasLink) where.href = w.t.watchLink;

  const wc = $('wildcard');
  wc.hidden = !r.wildcard;
  if (r.wildcard) {
    const info = el('div');
    const label = el('p', 'wildcard-label');
    label.append(icon('dice'), 'Wildcard');
    info.append(label, el('h3', 'wildcard-title', r.wildcard.t.title),
      el('p', 'wildcard-why', `${facts(r.wildcard.t)} · ${r.wildcard.yes} of ${r.n} loved it`));
    wc.replaceChildren(poster(r.wildcard.t, 'mini-poster', 72, 108), info);
  }

  const rest = [...r.ranked.filter(x => x !== w), ...r.seen];
  $('rest-label').hidden = rest.length === 0;
  $('ranked').replaceChildren(...rest.map(x => {
    const li = el('li', x.seen ? 'is-seen' : '');
    const name = el('div', 'ranked-title', x.t.title);
    name.append(el('small', '', facts(x.t)));
    const score = x.seen
      ? el('span', 'score', 'Seen')
      : el('span', 'score' + (x.yes === r.n ? ' full' : ''), `${x.yes} / ${r.n}`);
    li.append(poster(x.t, 'mini-poster', 46, 69), name, score);
    return li;
  }));

  const guest = state.mode === 'room' && !isHost();
  $('again-btn').disabled = guest;
  $('again-btn').textContent = guest ? 'The host can start another round' : 'Another round';
  $('watched').hidden = !w;
}

function anotherRound(){
  if (state.mode === 'room' && state.room) return newRoomRound();
  state.usedIds.push(...state.deck.map(t => t.id));
  startLocalRound();
}

function watched(){
  if (lastResult?.winner) addSeen(lastResult.winner.t.id);
  toast('Marked as watched');
  $('watched').hidden = true;
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.vote) return castVote(b.dataset.vote);
  if (b.dataset.mode) { state.mode = b.dataset.mode; return renderCreate(); }
  if (b.dataset.vibe) { state.filters.vibe = b.dataset.vibe; return renderCreate(); }
  if (b.dataset.genre) { state.filters.genres = toggle(state.filters.genres, b.dataset.genre); return renderGenrePills(); }
  if (b.dataset.viewers) { state.viewers = Number(b.dataset.viewers); return renderCreate(); }
  if (b.dataset.time) { state.filters.maxRuntime = Number(b.dataset.time); return renderCreate(); }
  switch (b.dataset.action) {
    case 'start':   leaveRoom(); return openCreate();
    case 'join':    leaveRoom(); return openJoin();
    case 'home':    leaveRoom(); return show('home');
    case 'leave':   leaveRoom(); return show('home');
    case 'create':  return submitCreate();
    case 'ready':   return show('vote');
    case 'again':   return anotherRound();
    case 'watched': return watched();
    case 'share':   return share();
    case 'copy-code': return copy(state.room.code, 'Code copied');
    case 'room-start':  return hostCall('start');
    case 'room-reveal': return hostCall('reveal');
    case 'retry':   return retryAction ? retryAction() : show('home');
    case 'genres-clear':
      state.filters.genres = [];
      return renderGenrePills();
  }
});

$('join-form').addEventListener('submit', submitJoin);
$('join-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
});

document.addEventListener('keydown', e => {
  if (state.screen !== 'vote' || e.target.closest('input')) return;
  const v = { ArrowRight: 'yes', ArrowLeft: 'no', ArrowDown: 'seen' }[e.key];
  if (v) { e.preventDefault(); castVote(v); }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden && pollTimer) refreshRoom(); });

/* ---------- start ---------- */
async function init(){
  const code = new URLSearchParams(location.search).get('room')?.toUpperCase();
  ensureGenres().catch(() => {});   // warm up; errors surface when needed
  if (code) {
    const mine = (load().rooms || {})[code];
    if (mine) {
      showLoading('Back to your room…');
      try {
        const { room } = await request(`/api/rooms/${code}`);
        if (room.members.some(m => m.id === mine.id)) { loadHomeRows(); return enterRoom(mine, room); }
      } catch {}
    }
    loadHomeRows();
    return openJoin(code);
  }
  show('home');
  loadHomeRows();
}

init();
