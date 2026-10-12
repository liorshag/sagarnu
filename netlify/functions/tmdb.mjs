// Server-side proxy to TMDB. The Read Access Token never reaches the browser.
//
//   GET /api/genres
//     -> { movie: [{ id, name }], series: [{ id, name }] }
//   GET /api/titles?type=movie|series&page=1&genres=28,35&maxRuntime=120
//     -> { page, totalPages, totalResults, results: [title] }
//
// Titles come from TMDB /discover, filtered to what JustWatch lists as
// streaming on Netflix (provider 8) with a subscription in Israel.

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';
const BACKDROP = 'https://image.tmdb.org/t/p/w780';
const REGION = 'IL';
const NETFLIX = 8;
const LANG = 'en-US';
const MAX_PAGE = 500;              // TMDB discover never serves pages past 500
const TTL = 6 * 60 * 60 * 1000;    // in-memory cache for warm function instances

const KIND = { movie: 'movie', series: 'tv' };
const cache = new Map();           // url -> { at, data }

class HttpError extends Error {
  constructor(status, code, message){ super(message); this.status = status; this.code = code; }
}

function token(){
  const t = globalThis.Netlify?.env.get('TMDB_ACCESS_TOKEN') ?? process.env.TMDB_ACCESS_TOKEN;
  if (!t) throw new HttpError(500, 'missing_token', 'TMDB_ACCESS_TOKEN is not set on the server.');
  return t;
}

async function tmdb(path, params = {}){
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}`, accept: 'application/json' } });
    if (res.status === 429) {      // rate limited: respect Retry-After, then retry
      const wait = Number(res.headers.get('retry-after')) || 1;
      await new Promise(r => setTimeout(r, Math.min(wait, 3) * 1000));
      continue;
    }
    if (res.status === 401) throw new HttpError(502, 'tmdb_auth', 'TMDB rejected the access token.');
    if (!res.ok) throw new HttpError(502, 'tmdb_error', `TMDB responded ${res.status}.`);
    const data = await res.json();
    cache.set(key, { at: Date.now(), data });
    return data;
  }
  throw new HttpError(503, 'tmdb_busy', 'TMDB is busy. Try again in a moment.');
}

async function genreMap(type){
  const { genres } = await tmdb(`/genre/${KIND[type]}/list`, { language: LANG });
  return genres;
}

function normalize(r, type, names){
  const isMovie = type === 'movie';
  const date = isMovie ? r.release_date : r.first_air_date;
  const title = (isMovie ? r.title : r.name) || (isMovie ? r.original_title : r.original_name);
  return {
    id: `${type}-${r.id}`,         // movies and series share TMDB id space, so prefix them
    tmdbId: r.id,
    type,
    title,
    original: (isMovie ? r.original_title : r.original_name) || title,
    year: date ? Number(date.slice(0, 4)) : null,
    genres: (r.genre_ids || []).map(id => names.get(id)).filter(Boolean),
    overview: r.overview || '',
    poster: r.poster_path ? IMG + r.poster_path : null,
    backdrop: r.backdrop_path ? BACKDROP + r.backdrop_path : null,
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    votes: r.vote_count || 0,
    watchLink: `https://www.themoviedb.org/${KIND[type]}/${r.id}/watch?locale=${REGION}`
  };
}

async function titles(params){
  const type = params.get('type');
  if (!KIND[type]) throw new HttpError(400, 'bad_request', 'type must be "movie" or "series".');
  const page = Math.min(MAX_PAGE, Math.max(1, parseInt(params.get('page'), 10) || 1));
  const genres = (params.get('genres') || '').split(',').filter(g => /^\d+$/.test(g));
  const maxRuntime = parseInt(params.get('maxRuntime'), 10);

  const [data, genreList] = await Promise.all([
    tmdb(`/discover/${KIND[type]}`, {
      watch_region: REGION,
      with_watch_providers: NETFLIX,
      with_watch_monetization_types: 'flatrate',
      language: LANG,
      sort_by: 'popularity.desc',
      include_adult: 'false',
      'vote_count.gte': 20,        // skip near-empty entries
      with_genres: genres.join('|'), // "|" = any of the chosen genres
      'with_runtime.lte': type === 'movie' && maxRuntime > 0 ? maxRuntime : undefined,
      page
    }),
    genreMap(type)
  ]);

  const names = new Map(genreList.map(g => [g.id, g.name]));
  const seen = new Set();
  const results = [];
  for (const r of data.results || []) {
    if (seen.has(r.id)) continue;   // TMDB can repeat an item across a page boundary
    seen.add(r.id);
    results.push(normalize(r, type, names));
  }
  return {
    page: data.page,
    totalPages: Math.min(data.total_pages || 0, MAX_PAGE),
    totalResults: data.total_results || 0,
    results
  };
}

function json(body, status = 200, cacheable = false){
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (cacheable) {
    headers['cache-control'] = 'public, max-age=600';
    // Netlify's CDN keeps results for 6 hours and serves stale copies while refreshing.
    headers['netlify-cdn-cache-control'] = 'public, durable, s-maxage=21600, stale-while-revalidate=86400';
  } else {
    headers['cache-control'] = 'no-store';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export default async (req) => {
  const url = new URL(req.url);
  try {
    if (url.pathname === '/api/genres') {
      const [movie, series] = await Promise.all([genreMap('movie'), genreMap('series')]);
      return json({ movie, series }, 200, true);
    }
    if (url.pathname === '/api/titles') return json(await titles(url.searchParams), 200, true);
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
    console.error(err);
    return json({ error: 'server_error', message: 'Something went wrong.' }, 500);
  }
};

export const config = { path: ['/api/genres', '/api/titles'] };
