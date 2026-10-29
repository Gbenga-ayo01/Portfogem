/**
 * @file github.js
 * @description Hardened, CTO-reviewed backend module for GitHub portfolio integration.
 */

const DEFAULTS = {
  username: '',
  token: '',
  baseUrl: 'https://api.github.com',
  cacheTTL: 5 * 60 * 1000,
  defaultSort: 'updated',
  includeForks: false,
  maxEvents: 10,
};

const config = { ...DEFAULTS };

export class GitHubError extends Error {
  constructor(message, { status = 0, kind = 'unknown', resetAt = null, raw = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.kind = kind;
    this.resetAt = resetAt;
    this.raw = raw;
  }
}

const cache = new Map();
const inflight = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data, ttl = config.cacheTTL) {
  cache.set(key, { data, expires: Date.now() + ttl });
}

export function clearCache() {
  cache.clear();
  inflight.clear();
}

function safeUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function ghFetch(path, { signal } = {}) {
  if (!config.username || !config.username.trim()) {
    throw new GitHubError('GitHub username is not configured.', { kind: 'auth' });
  }

  const url = path.startsWith('http') ? path : `${config.baseUrl}${path}`;
  const cached = cacheGet(url);
  if (cached) return cached;

  if (inflight.has(url)) return inflight.get(url);

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  const fetchPromise = (async () => {
    let res;
    try {
      res = await fetch(url, { headers, signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new GitHubError('Network error — check your connection.', { kind: 'network', raw: err });
    }

    if (res.status === 429 || res.status === 403) {
      throw new GitHubError('GitHub rate limit reached.', { status: res.status, kind: 'rate_limit' });
    }

    if (!res.ok) throw new GitHubError(`GitHub API error (${res.status}).`, { status: res.status });

    const data = await res.json();
    cacheSet(url, data);
    return data;
  })().finally(() => inflight.delete(url));

  inflight.set(url, fetchPromise);
  return fetchPromise;
}

export async function getProfile(opts) {
  const data = await ghFetch(`/users/${encodeURIComponent(config.username)}`, opts);
  return {
    username: data.login,
    name: data.name || data.login,
    avatar: safeUrl(data.avatar_url),
    bio: data.bio || '',
    publicRepos: data.public_repos ?? 0,
    followers: data.followers ?? 0,
    following: data.following ?? 0,
    location: data.location || '',
    company: data.company || '',
    blog: safeUrl(data.blog),
    profileUrl: safeUrl(data.html_url),
    createdAt: data.created_at,
  };
}

export async function getRepos({ sort = config.defaultSort, includeForks = config.includeForks, limit = 100, signal } = {}) {
  const batch = await ghFetch(`/users/${encodeURIComponent(config.username)}/repos?per_page=100&sort=updated`, { signal });
  if (!Array.isArray(batch)) return [];

  const normalized = (includeForks ? batch : batch.filter((r) => !r.fork)).map((r) => ({
    name: r.name,
    description: r.description || '',
    language: r.language || null,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    url: safeUrl(r.html_url),
    homepage: safeUrl(r.homepage),
    updatedAt: r.updated_at,
  }));

  return normalized.slice(0, limit);
}

export async function getActivity({ limit = config.maxEvents, signal } = {}) {
  const events = await ghFetch(`/users/${encodeURIComponent(config.username)}/events/public?per_page=${Math.min(limit, 100)}`, { signal });
  if (!Array.isArray(events)) return [];

  return events.slice(0, limit).map((e) => ({
    id: e.id,
    type: e.type,
    repo: e.repo?.name || '',
    summary: `${e.type.replace('Event', '')} in ${e.repo?.name || 'repository'}`,
    createdAt: e.created_at,
    url: e.repo ? safeUrl(`https://github.com/${e.repo.name}`) : '',
  }));
}

export function configure(opts = {}) {
  Object.assign(config, opts);
  clearCache();
}

export default { configure, clearCache, getProfile, getRepos, getActivity, GitHubError };
