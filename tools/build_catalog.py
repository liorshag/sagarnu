"""Build titles.json from TMDB (Python port of PLAN.md section 4.4).

Usage:
  python3 tools/build_catalog.py
Options (env vars):
  TMDB_TOKEN=...   TMDB "API Read Access Token" (or put it in tools/.env)
  PROVIDERS=8      TMDB provider ids, "|" separated. 8 = Netflix
  PAGES=5          pages per type (20 titles per page)
  MIN_VOTES=200    skip obscure titles

Standard library only. Needs Python 3.8+.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_env_file(path):
    if not path.exists():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(HERE / '.env')

TOKEN = os.environ.get('TMDB_TOKEN')
if not TOKEN:
    print('Missing TMDB_TOKEN in tools/.env', file=sys.stderr)
    sys.exit(1)

REGION = 'IL'
LANG = 'en-US'
PROVIDERS = os.environ.get('PROVIDERS') or '8'
PAGES = int(os.environ.get('PAGES') or 5)
MIN_VOTES = int(os.environ.get('MIN_VOTES') or 200)
IMG = 'https://image.tmdb.org/t/p/'


def api(path, params=None):
    url = 'https://api.themoviedb.org/3' + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {TOKEN}',
        'accept': 'application/json',
    })
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            if e.code == 429:  # rate limited
                time.sleep(1.5)
                continue
            raise RuntimeError(f'{e.code} {url}') from None
    raise RuntimeError('Too many retries: ' + url)


# run tasks a few at a time to stay polite with the API
def pool(items, size, fn):
    with ThreadPoolExecutor(max_workers=size) as ex:
        return list(ex.map(fn, items))


def genre_map(kind):
    genres = api(f'/genre/{kind}/list', {'language': 'en'})['genres']
    return {g['id']: g['name'] for g in genres}


def discover(kind):
    ids = []
    for page in range(1, PAGES + 1):
        data = api(f'/discover/{kind}', {
            'language': LANG,
            'watch_region': REGION,
            'with_watch_providers': PROVIDERS,
            'with_watch_monetization_types': 'flatrate',
            'sort_by': 'popularity.desc',
            'vote_count.gte': MIN_VOTES,
            'page': page,
        })
        ids.extend(r['id'] for r in data['results'])
        if page >= data['total_pages']:
            break
    return list(dict.fromkeys(ids))


def details(kind, id_, genres):
    d = api(f'/{kind}/{id_}', {'language': LANG, 'append_to_response': 'watch/providers'})
    il = (d.get('watch/providers') or {}).get('results', {}).get(REGION) or {}
    is_movie = kind == 'movie'
    released = d.get('release_date') if is_movie else d.get('first_air_date')
    original = d.get('original_title') if is_movie else d.get('original_name')
    runtimes = d.get('episode_run_time') or []
    vote = d.get('vote_average')
    return {
        'id': f'{kind}-{id_}',
        'tmdbId': id_,
        'type': 'movie' if is_movie else 'series',
        'title': (d.get('title') if is_movie else d.get('name')) or original,
        'original': original,
        'year': int(released[:4]) if released else None,
        'runtime': (d.get('runtime') or None) if is_movie else (runtimes[0] if runtimes else None),
        'genres': [genres.get(g['id'], g['name']) for g in d.get('genres') or []],
        'overview': d.get('overview') or '',
        'poster': IMG + 'w342' + d['poster_path'] if d.get('poster_path') else None,
        'rating': round(vote, 1) if vote else None,
        'providers': [p['provider_id'] for p in il.get('flatrate') or []],
        'watchLink': il.get('link'),
    }


def provider_list(used_ids):
    params = {'watch_region': REGION, 'language': LANG}
    found = {}
    for kind in ('movie', 'tv'):
        for p in api(f'/watch/providers/{kind}', params)['results']:
            found[p['provider_id']] = p
    print('\nStreaming services TMDB lists for Israel (id: name):')
    for p in found.values():
        print(f"  {p['provider_id']}: {p['provider_name']}")
    return [{
        'id': p['provider_id'],
        'name': p['provider_name'],
        'logo': IMG + 'w92' + p['logo_path'] if p.get('logo_path') else None,
    } for p in (found.get(i) for i in used_ids) if p]


def main():
    wanted = [int(x) for x in PROVIDERS.split('|') if x.strip()]
    movie_genres, tv_genres = genre_map('movie'), genre_map('tv')
    movie_ids = discover('movie')
    tv_ids = discover('tv')
    print(f'Found {len(movie_ids)} movies and {len(tv_ids)} series. Loading details…')

    movies = pool(movie_ids, 5, lambda i: details('movie', i, movie_genres))
    series = pool(tv_ids, 5, lambda i: details('tv', i, tv_genres))
    # keep only titles that really stream on the chosen services in Israel
    titles = [t for t in movies + series if any(p in wanted for p in t['providers'])]
    for t in titles:
        t['providers'] = [p for p in t['providers'] if p in wanted]

    catalog = {
        'updated': date.today().isoformat(),
        'region': REGION,
        'providers': provider_list(wanted),
        'genres': sorted({g for t in titles for g in t['genres']}),
        'titles': titles,
    }
    out = HERE.parent / 'titles.json'
    out.write_text(json.dumps(catalog, ensure_ascii=False), encoding='utf-8')
    print(f'\nSaved {len(titles)} titles to titles.json')


if __name__ == '__main__':
    main()
