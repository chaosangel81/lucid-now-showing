const DAY_MS = 86400000;
const DEFAULT_LOOKAHEAD_DAYS = 90;

export function hasComingSoonSource(config = {}) {
  const c = config.comingSoon || {};
  return !!((c.radarrUrl && c.radarrApiKey) || (c.sonarrUrl && c.sonarrApiKey));
}

export async function fetchComingSoonItems({
  config,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const c = config?.comingSoon || {};
  const offsetDays = numberOr(c.daysOffset, 0);
  const lookaheadDays = numberOr(c.lookaheadDays, DEFAULT_LOOKAHEAD_DAYS);
  const start = startOfDay(new Date(now.getTime() - offsetDays * DAY_MS));
  const end = new Date(now.getTime() + lookaheadDays * DAY_MS);

  const [movies, shows] = await Promise.all([
    fetchRadarrItems({ config: c, fetchImpl, start, end, now }),
    fetchSonarrItems({ config: c, fetchImpl, start, end, now }),
  ]);

  return interleave(
    movies.slice(0, numberOr(c.moviesCount, 5)),
    shows.slice(0, numberOr(c.showsCount, 5)),
  );
}

async function fetchRadarrItems({ config, fetchImpl, start, end, now }) {
  if (!config.radarrUrl || !config.radarrApiKey) return [];
  const base = trimSlash(config.radarrUrl);
  const url = `${base}/api/v3/calendar?start=${dateOnly(start)}&end=${dateOnly(end)}&unmonitored=false`;
  const resp = await fetchImpl(url, { headers: { 'X-Api-Key': config.radarrApiKey } });
  if (!resp.ok) {
    const err = new Error(`Radarr calendar returned ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  return (Array.isArray(data) ? data : [])
    .map(item => ({ item, picked: pickRadarrReleaseDate(item, start, end) }))
    .filter(({ item, picked }) => !item.hasFile && picked)
    .sort((a, b) => new Date(a.picked.releaseDate) - new Date(b.picked.releaseDate))
    .map(({ item, picked }) => {
      const id = item.id || item.movieId || '';
      const genres = Array.isArray(item.genres) ? item.genres.filter(Boolean).join(' / ') : '';
      const { releaseDate, releaseType } = picked;
      const baseLabel = formatReleaseDate(releaseDate);
      const releaseLabel = releaseType === 'cinema' && baseLabel ? `In cinemas: ${baseLabel}` : baseLabel;
      return {
        type: 'movie',
        typeLabel: 'Movie',
        title: item.title || 'Untitled Movie',
        subtitle: [item.year, genres].filter(Boolean).join(' / '),
        releaseDate,
        releaseType,
        countdown: formatCountdown(releaseDate, now),
        releaseLabel,
        overview: item.overview || '',
        posterUrl: imageUrl(item.images, 'poster'),
        fanartUrl: imageUrl(item.images, 'fanart'),
        localPosterUrl: id ? `${base}/api/v3/MediaCover/${id}/poster.jpg?apikey=${encodeURIComponent(config.radarrApiKey)}` : '',
        localFanartUrl: id ? `${base}/api/v3/MediaCover/${id}/fanart.jpg?apikey=${encodeURIComponent(config.radarrApiKey)}` : '',
      };
    });
}

// Pick the visible release date for a Radarr movie.
//
// Eligibility (#87): inCinemas keeps a monitored, not-yet-downloaded movie in
// the rotation when no home-release date is known.
//
// Display preference (#90): home-release dates (digitalRelease /
// physicalRelease) are clearer for a Coming Soon footer because the rotation
// is primarily a home-library availability display. We pick the earliest
// qualifying home date; only when neither qualifies do we fall back to
// inCinemas, and we tag releaseType: 'cinema' so the UI can label it as a
// theatrical date rather than imply digital/physical availability.
//
// TMDB feasibility note: when Radarr lacks digital/physical metadata, TMDB's
// /movie/{id}/release_dates endpoint exposes typed release dates (theatrical,
// digital, physical, etc.) per region and could be used as a fallback. That
// would require a TMDB API token, configurable region, and result caching, so
// it's intentionally out of scope here. IMDb has no equivalent simple public
// API and is not a practical alternative.
function pickRadarrReleaseDate(item, start, end) {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const inWindow = (raw) => {
    if (!raw) return null;
    const ts = new Date(raw).getTime();
    return Number.isFinite(ts) && ts >= startMs && ts <= endMs ? ts : null;
  };
  const homeCandidates = [
    { raw: item.digitalRelease, ts: inWindow(item.digitalRelease) },
    { raw: item.physicalRelease, ts: inWindow(item.physicalRelease) },
  ].filter(c => c.ts !== null);
  if (homeCandidates.length) {
    homeCandidates.sort((a, b) => a.ts - b.ts);
    return { releaseDate: homeCandidates[0].raw, releaseType: 'home' };
  }
  const cinemaTs = inWindow(item.inCinemas);
  if (cinemaTs !== null) {
    return { releaseDate: item.inCinemas, releaseType: 'cinema' };
  }
  return null;
}

async function fetchSonarrItems({ config, fetchImpl, start, end, now }) {
  if (!config.sonarrUrl || !config.sonarrApiKey) return [];
  const base = trimSlash(config.sonarrUrl);
  const url = `${base}/api/v3/calendar?start=${dateOnly(start)}&end=${dateOnly(end)}&unmonitored=false&includeSeries=true`;
  const resp = await fetchImpl(url, { headers: { 'X-Api-Key': config.sonarrApiKey } });
  if (!resp.ok) {
    const err = new Error(`Sonarr calendar returned ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const seenSeries = new Set();
  return (Array.isArray(data) ? data : [])
    .filter(item => {
      if (item.hasFile || !item.airDateUtc) return false;
      const ts = new Date(item.airDateUtc).getTime();
      return Number.isFinite(ts) && ts >= start.getTime() && ts <= end.getTime();
    })
    .sort((a, b) => new Date(a.airDateUtc) - new Date(b.airDateUtc))
    .filter(item => {
      const id = item.seriesId || item.series?.id || item.series?.title || item.title;
      if (seenSeries.has(id)) return false;
      seenSeries.add(id);
      return true;
    })
    .map(item => {
      const series = item.series || {};
      const id = series.id || item.seriesId || '';
      const season = String(item.seasonNumber || 0).padStart(2, '0');
      const episode = String(item.episodeNumber || 0).padStart(2, '0');
      const episodeLabel = `S${season}E${episode}${item.title ? ` / ${item.title}` : ''}`;
      const releaseDate = item.airDate || (item.airDateUtc ? item.airDateUtc.split('T')[0] : '');
      return {
        type: 'tv',
        typeLabel: 'TV',
        title: series.title || item.title || 'Untitled Series',
        subtitle: episodeLabel,
        releaseDate,
        releaseType: 'air',
        countdown: formatCountdown(releaseDate, now),
        releaseLabel: formatReleaseDate(releaseDate),
        overview: item.overview || '',
        posterUrl: imageUrl(series.images, 'poster'),
        fanartUrl: imageUrl(series.images, 'fanart'),
        localPosterUrl: id ? `${base}/api/v3/MediaCover/${id}/poster.jpg?apikey=${encodeURIComponent(config.sonarrApiKey)}` : '',
        localFanartUrl: id ? `${base}/api/v3/MediaCover/${id}/fanart.jpg?apikey=${encodeURIComponent(config.sonarrApiKey)}` : '',
        seriesTitle: series.title || '',
        seasonNumber: item.seasonNumber || null,
        episodeNumber: item.episodeNumber || null,
      };
    });
}

function interleave(movies, shows) {
  const items = [];
  const max = Math.max(movies.length, shows.length);
  for (let i = 0; i < max; i += 1) {
    if (i < movies.length) items.push(movies[i]);
    if (i < shows.length) items.push(shows[i]);
  }
  return items;
}

function imageUrl(images, coverType) {
  if (!Array.isArray(images)) return '';
  const image = images.find(i => i && i.coverType === coverType);
  return image?.remoteUrl || '';
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function startOfDay(value) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateOnly(value) {
  return value.toISOString().split('T')[0];
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function formatReleaseDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const day = d.getUTCDate();
  return `${ordinal(day)} of ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatCountdown(dateStr, now = new Date()) {
  if (!dateStr) return '';
  const target = startOfDay(new Date(`${String(dateStr).substring(0, 10)}T00:00:00`));
  if (Number.isNaN(target.getTime())) return '';
  const today = startOfDay(now);
  const diff = Math.round((target - today) / DAY_MS);
  if (diff < 0) return 'Available';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 7) return `In ${diff} days`;
  if (diff < 14) return 'In 1 week';
  if (diff < 30) return `In ${Math.round(diff / 7)} weeks`;
  if (diff < 60) return 'In 1 month';
  if (diff < 365) return `In ${Math.round(diff / 30)} months`;
  const years = Math.round(diff / 365);
  return `In ${years} year${years === 1 ? '' : 's'}`;
}

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}
