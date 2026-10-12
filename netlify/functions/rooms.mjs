// Movie Night rooms: everyone votes on their own phone.
//
//   POST /api/rooms                  { name, vibe, genres, deck }      -> { member, room }
//   GET  /api/rooms/:code?member=id                                    -> { room }
//   POST /api/rooms/:code/join       { name }                          -> { member, room }
//   POST /api/rooms/:code/start      { memberId, key }        (host)   -> { room }
//   POST /api/rooms/:code/vote       { memberId, key, round, votes, done } -> { room }
//   POST /api/rooms/:code/reveal     { memberId, key }        (host)   -> { room }
//   POST /api/rooms/:code/round      { memberId, key, deck }  (host)   -> { room }
//
// Stored in Netlify Blobs. Each member has their own blob so simultaneous
// votes never overwrite each other. Votes stay hidden until everyone is done
// (or the host reveals). Rooms expire after 24 hours.

import { getStore } from '@netlify/blobs';

const TTL = 24 * 60 * 60 * 1000;
const MAX_MEMBERS = 10;
const MAX_DECK = 30;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I look-alikes
const VIBES = ['mix', 'movie', 'series'];
const VOTES = ['yes', 'no', 'seen'];

class HttpError extends Error {
  constructor(status, code, message){ super(message); this.status = status; this.code = code; }
}

const store = () => getStore({ name: 'rooms', consistency: 'strong' });
const metaKey = code => `${code}/meta`;
const memberKey = (code, id) => `${code}/m/${id}`;

function randomId(chars, length){
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map(b => chars[b % chars.length]).join('');
}

/* ---------- input checks (the deck comes from a browser, so trust nothing) ---------- */
function cleanName(name){
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!n) throw new HttpError(400, 'name_required', 'Enter your name.');
  return n;
}

function str(v, max){ return typeof v === 'string' ? v.slice(0, max) : ''; }
function url(v, prefix){ return typeof v === 'string' && v.startsWith(prefix) && v.length < 300 ? v : null; }

function cleanDeck(deck){
  if (!Array.isArray(deck) || deck.length === 0) throw new HttpError(400, 'bad_deck', 'The deck is empty.');
  const seen = new Set();
  const out = [];
  for (const t of deck.slice(0, MAX_DECK)) {
    const id = str(t?.id, 40);
    if (!/^(movie|series)-\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      tmdbId: Number(t.tmdbId) || null,
      type: id.startsWith('movie') ? 'movie' : 'series',
      title: str(t.title, 200) || 'Untitled',
      original: str(t.original, 200),
      year: Number.isInteger(t.year) ? t.year : null,
      genres: Array.isArray(t.genres) ? t.genres.slice(0, 5).map(g => str(g, 40)).filter(Boolean) : [],
      overview: str(t.overview, 1200),
      poster: url(t.poster, 'https://image.tmdb.org/'),
      backdrop: url(t.backdrop, 'https://image.tmdb.org/'),
      rating: typeof t.rating === 'number' ? Math.round(t.rating * 10) / 10 : null,
      watchLink: url(t.watchLink, 'https://www.themoviedb.org/')
    });
  }
  if (!out.length) throw new HttpError(400, 'bad_deck', 'The deck is empty.');
  return out;
}

/* ---------- reading a room ---------- */
async function getMeta(code){
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new HttpError(404, 'room_not_found', 'No room with that code.');
  const meta = await store().get(metaKey(code), { type: 'json' });
  if (!meta) throw new HttpError(404, 'room_not_found', 'No room with that code.');
  if (Date.now() - meta.createdAt > TTL) throw new HttpError(410, 'room_expired', 'This room has expired.');
  return meta;
}

async function getMembers(code){
  const s = store();
  const { blobs } = await s.list({ prefix: `${code}/m/` });
  const members = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })));
  return members.filter(Boolean).sort((a, b) => a.joinedAt - b.joinedAt);
}

async function auth(code, body){
  const m = await store().get(memberKey(code, str(body?.memberId, 40)), { type: 'json' });
  if (!m || m.key !== body?.key) throw new HttpError(403, 'not_member', 'You are not in this room.');
  return m;
}

function view(meta, members){
  const current = members.map(m => {
    const votes = m.round === meta.round ? m.votes : {};
    return { m, votes, done: m.round === meta.round && m.done };
  });
  const allDone = current.length > 0 && current.every(c => c.done);
  const status = meta.status === 'voting' && allDone ? 'done' : meta.status;
  const revealed = status === 'done';
  return {
    code: meta.code,
    vibe: meta.vibe,
    genres: meta.genres,
    round: meta.round,
    status,                                  // lobby | voting | done
    hostId: meta.hostId,
    deck: meta.deck,
    expiresAt: meta.createdAt + TTL,
    members: current.map(({ m, votes, done }) => ({
      id: m.id,
      name: m.name,
      progress: Object.keys(votes).length,
      done
    })),
    // votes are only shared once the round is over
    results: revealed ? current.map(({ m, votes }) => ({ id: m.id, name: m.name, votes })) : null
  };
}

async function roomView(code){
  const meta = await getMeta(code);
  return view(meta, await getMembers(code));
}

/* ---------- actions ---------- */
async function createRoom(body){
  const name = cleanName(body.name);
  const vibe = VIBES.includes(body.vibe) ? body.vibe : 'mix';
  const genres = Array.isArray(body.genres) ? body.genres.slice(0, 3).map(g => str(g, 40)).filter(Boolean) : [];
  const deck = cleanDeck(body.deck);
  const s = store();

  let code;
  for (let i = 0; i < 5 && !code; i++) {
    const candidate = randomId(CODE_CHARS, 6);
    const existing = await s.get(metaKey(candidate), { type: 'json' });
    if (!existing || Date.now() - existing.createdAt > TTL) code = candidate;
  }
  if (!code) throw new HttpError(503, 'busy', 'Could not create a room. Try again.');

  const member = { id: randomId(CODE_CHARS, 10), key: randomId(CODE_CHARS, 24), name, joinedAt: Date.now(), round: 1, votes: {}, done: false };
  const meta = { code, createdAt: Date.now(), hostId: member.id, vibe, genres, round: 1, status: 'lobby', deck };
  await s.setJSON(metaKey(code), meta);
  await s.setJSON(memberKey(code, member.id), member);
  return { member: { id: member.id, key: member.key }, room: view(meta, [member]) };
}

async function joinRoom(code, body){
  const name = cleanName(body.name);
  const meta = await getMeta(code);
  const members = await getMembers(code);
  if (members.length >= MAX_MEMBERS) throw new HttpError(409, 'room_full', `This room already has ${MAX_MEMBERS} people.`);
  const member = { id: randomId(CODE_CHARS, 10), key: randomId(CODE_CHARS, 24), name, joinedAt: Date.now(), round: meta.round, votes: {}, done: false };
  await store().setJSON(memberKey(code, member.id), member);
  return { member: { id: member.id, key: member.key }, room: view(meta, [...members, member]) };
}

async function hostAction(code, body, change){
  const meta = await getMeta(code);
  const me = await auth(code, body);
  if (me.id !== meta.hostId) throw new HttpError(403, 'not_host', 'Only the host can do that.');
  change(meta);
  await store().setJSON(metaKey(code), meta);
  return roomView(code);
}

async function vote(code, body){
  const meta = await getMeta(code);
  const me = await auth(code, body);
  if (Number(body.round) !== meta.round) throw new HttpError(409, 'old_round', 'A new round has started.');
  const ids = new Set(meta.deck.map(t => t.id));
  const votes = {};
  for (const [id, v] of Object.entries(body.votes || {})) if (ids.has(id) && VOTES.includes(v)) votes[id] = v;
  Object.assign(me, { round: meta.round, votes, done: !!body.done && Object.keys(votes).length === meta.deck.length });
  await store().setJSON(memberKey(code, me.id), me);
  const room = view(meta, await getMembers(code));
  if (room.status === 'done' && meta.status !== 'done') {
    // lock the results in, so someone joining late doesn't hide them again
    meta.status = 'done';
    await store().setJSON(metaKey(code), meta);
  }
  return room;
}

/* ---------- routing ---------- */
function json(body, status = 200){
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export default async (req) => {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);   // ['api', 'rooms', code?, action?]
  const code = (parts[2] || '').toUpperCase();
  const action = parts[3] || '';
  try {
    if (req.method === 'GET' && code && !action) return json({ room: await roomView(code) });
    if (req.method !== 'POST') return json({ error: 'not_found' }, 404);

    const body = await req.json().catch(() => ({}));
    if (!code) return json(await createRoom(body), 201);
    switch (action) {
      case 'join':   return json(await joinRoom(code, body));
      case 'vote':   return json({ room: await vote(code, body) });
      case 'start':  return json({ room: await hostAction(code, body, m => { m.status = 'voting'; }) });
      case 'reveal': return json({ room: await hostAction(code, body, m => { m.status = 'done'; }) });
      case 'round': {
        const deck = cleanDeck(body.deck);
        return json({ room: await hostAction(code, body, m => { m.round += 1; m.deck = deck; m.status = 'voting'; }) });
      }
    }
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
    console.error(err);
    return json({ error: 'server_error', message: 'Something went wrong.' }, 500);
  }
};

export const config = { path: ['/api/rooms', '/api/rooms/*'] };
