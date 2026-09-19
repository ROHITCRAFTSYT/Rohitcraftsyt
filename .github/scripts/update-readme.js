#!/usr/bin/env node
/**
 * Smart README generator.
 *
 * Pulls live data from the GitHub REST API and rewrites the dynamic sections of
 * README.md in place — everything between a pair of HTML-comment markers such as
 *   <!-- LATEST_PROJECTS:START -->  ...  <!-- LATEST_PROJECTS:END -->
 * is replaced. Anything outside the markers is left untouched, so the hand-written
 * header / arsenal / footer survive every run.
 *
 * Sections generated:
 *   STATS            – a one-line summary (public repos, stars earned, followers)
 *   LATEST_PROJECTS  – the 6 most recently pushed, non-fork repos
 *   LANG_BREAKDOWN   – real language usage, aggregated from bytes across all repos
 *   UPDATED          – a "last refreshed" timestamp
 *
 * Runs with zero external dependencies (Node 18+ built-in fetch).
 * Auth: set GITHUB_TOKEN in the environment (the Actions default token is fine).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const USER = process.env.GH_USER || 'ROHITCRAFTSYT';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const README = path.join(__dirname, '..', '..', 'README.md');
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const UTC_OFFSET = 5.5; // IST, used by the "productive time" card
const MAX_PROJECTS = 6;

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': `${USER}-readme-bot`,
  'X-GitHub-Api-Version': '2022-11-28',
};
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

async function gh(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json();
}

/** Fetch every public, non-fork repo (paginated). */
async function fetchRepos() {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(
      `https://api.github.com/users/${USER}/repos?per_page=100&page=${page}&sort=pushed`
    );
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((r) => !r.fork && !r.private);
}

/** Aggregate language bytes across all repos into ranked percentages. */
async function fetchLanguages(repos) {
  const totals = {};
  // Cap concurrency so we stay friendly with the API.
  for (const repo of repos) {
    try {
      const langs = await gh(repo.languages_url);
      for (const [name, bytes] of Object.entries(langs)) {
        totals[name] = (totals[name] || 0) + bytes;
      }
    } catch {
      /* skip a repo we can't read rather than fail the whole run */
    }
  }
  const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(totals)
    .map(([name, bytes]) => ({ name, pct: (bytes / grand) * 100 }))
    .sort((a, b) => b.pct - a.pct);
}

/** Fetch recent public events (used to infer productive hours). Best-effort. */
async function fetchEvents() {
  try {
    return await gh(`https://api.github.com/users/${USER}/events/public?per_page=100`);
  } catch {
    return [];
  }
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function esc(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build a 2-column card table of the most recently pushed repos. */
function renderProjects(repos) {
  const featured = repos
    .filter((r) => r.name.toLowerCase() !== USER.toLowerCase()) // drop the profile repo itself
    .slice(0, MAX_PROJECTS);

  if (!featured.length) return '_No public repositories yet._';

  const cell = (r) => {
    if (!r) return '<td width="50%"></td>';
    const lang = r.language ? `\`${esc(r.language)}\`` : '`—`';
    const stars = r.stargazers_count > 0 ? ` · ⭐ ${r.stargazers_count}` : '';
    const desc = esc(r.description) || '_No description yet._';
    return (
      `<td width="50%" valign="top">\n\n` +
      `#### 🔹 [${esc(r.name)}](${r.html_url})\n` +
      `${lang}${stars} · updated ${relativeTime(r.pushed_at)}\n\n` +
      `${desc}\n\n` +
      `</td>`
    );
  };

  let out = '<table>\n';
  for (let i = 0; i < featured.length; i += 2) {
    out += '<tr>\n';
    out += cell(featured[i]) + '\n';
    out += cell(featured[i + 1]) + '\n';
    out += '</tr>\n';
  }
  out += '</table>';
  return out;
}

/** Build a text bar-chart of aggregated language usage. */
function renderLanguages(langs) {
  const top = langs.slice(0, 6);
  if (!top.length) return '```text\nNo language data yet.\n```';
  const width = 18;
  const pad = Math.max(...top.map((l) => l.name.length));
  const lines = top.map((l) => {
    const filled = Math.round((l.pct / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const name = l.name.padEnd(pad);
    const pct = l.pct.toFixed(1).padStart(4);
    return `${name}  ${bar}  ${pct}%`;
  });
  return '```text\n' + lines.join('\n') + '\n```';
}

function renderStats(repos, profile) {
  const stars = repos.reduce((a, r) => a + r.stargazers_count, 0);
  return (
    `\`🗂️ ${profile.public_repos} public repos\` ` +
    `\`⭐ ${stars} stars earned\` ` +
    `\`👥 ${profile.followers} followers\``
  );
}

/* --------------------------------------------------------------------------
 * Self-hosted analytics cards.
 *
 * These replace the third-party github-profile-summary-cards.vercel.app images,
 * whose shared public instance intermittently rate-limits the GitHub API and
 * renders an "ERROR!!! Cards are temporarily rate limited" placeholder. We build
 * the same numbers here with the workflow's authenticated token (a far higher
 * rate limit) and commit static SVGs, so the profile never shows an error card.
 * ------------------------------------------------------------------------- */

// github_dark palette, to match the rest of the profile.
const C = {
  bg: '#0d1117',
  border: '#30363d',
  accent: '#58a6ff',
  text: '#c9d1d9',
  muted: '#8b949e',
  track: '#21262d',
};
const LANG_COLORS = ['#58a6ff', '#3fb950', '#f778ba', '#d29922', '#a371f7', '#ff7b72', '#8b949e'];
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Ubuntu,sans-serif";

function svgEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Outer card frame: rounded panel, title, accent underline. */
function frame(w, h, title, body) {
  return (
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${svgEsc(title)}">` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${C.bg}" stroke="${C.border}"/>` +
    `<text x="24" y="36" font-family="${FONT}" font-size="17" font-weight="600" fill="${C.accent}">${svgEsc(title)}</text>` +
    `<rect x="24" y="46" width="38" height="3" rx="1.5" fill="${C.accent}"/>` +
    body +
    `</svg>`
  );
}

function num(n) {
  return Number(n).toLocaleString('en-US');
}

/** Stats card — replaces the "stats" + "profile-details" cards. */
function renderStatsSvg(profile, repos) {
  const stars = repos.reduce((a, r) => a + (r.stargazers_count || 0), 0);
  const forks = repos.reduce((a, r) => a + (r.forks_count || 0), 0);
  const rows = [
    ['Public Repos', profile.public_repos],
    ['Stars Earned', stars],
    ['Total Forks', forks],
    ['Followers', profile.followers],
    ['Following', profile.following],
  ];
  const body = rows
    .map(([label, value], i) => {
      const y = 82 + i * 27;
      return (
        `<text x="24" y="${y}" font-family="${FONT}" font-size="14" fill="${C.muted}">${svgEsc(label)}</text>` +
        `<text x="456" y="${y}" font-family="${FONT}" font-size="14" font-weight="600" ` +
        `fill="${C.text}" text-anchor="end">${num(value)}</text>`
      );
    })
    .join('');
  return frame(480, 210, 'GitHub Stats', body);
}

/** Language donut — replaces the "repos-per-language" card. */
function renderLanguagesSvg(langs) {
  const top = langs.slice(0, 6);
  const shown = top.reduce((a, l) => a + l.pct, 0);
  const segs = top.map((l, i) => ({ name: l.name, pct: l.pct, color: LANG_COLORS[i] }));
  if (shown < 99.9) {
    segs.push({ name: 'Other', pct: 100 - shown, color: LANG_COLORS[6] });
  }

  const cx = 108;
  const cy = 120;
  const r = 46;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segs
    .map((s) => {
      const len = (s.pct / 100) * circ;
      const arc =
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" ` +
        `stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" ` +
        `stroke-dashoffset="${(-offset).toFixed(2)}"/>`;
      offset += len;
      return arc;
    })
    .join('');
  const donut = `<g transform="rotate(-90 ${cx} ${cy})">${arcs}</g>`;

  const legend = segs
    .map((s, i) => {
      const y = 74 + i * 22;
      return (
        `<rect x="210" y="${y - 10}" width="11" height="11" rx="2.5" fill="${s.color}"/>` +
        `<text x="228" y="${y}" font-family="${FONT}" font-size="13" fill="${C.text}">${svgEsc(s.name)}</text>` +
        `<text x="456" y="${y}" font-family="${FONT}" font-size="13" fill="${C.muted}" ` +
        `text-anchor="end">${s.pct.toFixed(1)}%</text>`
      );
    })
    .join('');

  return frame(480, 210, 'Top Languages', donut + legend);
}

/** Productive-time card — replaces the "productive-time" card. */
function renderProductiveSvg(events) {
  const buckets = [
    { label: 'Morning', range: '6–12', count: 0 },
    { label: 'Daytime', range: '12–18', count: 0 },
    { label: 'Evening', range: '18–24', count: 0 },
    { label: 'Night', range: '0–6', count: 0 },
  ];
  let total = 0;
  for (const ev of events) {
    if (!ev || ev.type !== 'PushEvent' || !ev.created_at) continue;
    const d = new Date(ev.created_at);
    let hour = d.getUTCHours() + d.getUTCMinutes() / 60 + UTC_OFFSET;
    hour = ((hour % 24) + 24) % 24;
    const idx = hour >= 6 && hour < 12 ? 0 : hour >= 12 && hour < 18 ? 1 : hour >= 18 ? 2 : 3;
    buckets[idx].count++;
    total++;
  }

  const trackX = 128;
  const trackW = 328;
  const body = buckets
    .map((b, i) => {
      const y = 78 + i * 30;
      const pct = total ? (b.count / total) * 100 : 0;
      const w = Math.max(2, Math.round((pct / 100) * trackW));
      return (
        `<text x="24" y="${y + 4}" font-family="${FONT}" font-size="13" fill="${C.text}">${b.label}</text>` +
        `<text x="24" y="${y + 19}" font-family="${FONT}" font-size="10" fill="${C.muted}">${b.range}</text>` +
        `<rect x="${trackX}" y="${y - 6}" width="${trackW}" height="12" rx="6" fill="${C.track}"/>` +
        `<rect x="${trackX}" y="${y - 6}" width="${w}" height="12" rx="6" fill="${C.accent}"/>` +
        `<text x="${trackX + trackW}" y="${y - 10}" font-family="${FONT}" font-size="11" ` +
        `fill="${C.muted}" text-anchor="end">${pct.toFixed(0)}%</text>`
      );
    })
    .join('');

  const note = total
    ? ''
    : `<text x="24" y="200" font-family="${FONT}" font-size="11" fill="${C.muted}">No recent public pushes yet.</text>`;
  return frame(480, 210, `Productive Time (IST · last ${total} pushes)`, body + note);
}

/** Write all analytics SVGs into the committed assets/ folder. */
function writeCards({ profile, repos, langs, events }) {
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.writeFileSync(path.join(ASSETS, 'stats.svg'), renderStatsSvg(profile, repos));
  fs.writeFileSync(path.join(ASSETS, 'languages.svg'), renderLanguagesSvg(langs));
  fs.writeFileSync(path.join(ASSETS, 'productive.svg'), renderProductiveSvg(events));
  console.log('✅ analytics cards written to assets/');
}

/** Replace the content between <!-- KEY:START --> and <!-- KEY:END -->. */
function replaceSection(md, key, body) {
  const re = new RegExp(`(<!-- ${key}:START -->)([\\s\\S]*?)(<!-- ${key}:END -->)`);
  if (!re.test(md)) {
    console.warn(`⚠️  marker ${key} not found in README — skipping`);
    return md;
  }
  return md.replace(re, `$1\n${body}\n$3`);
}

async function main() {
  console.log(`Fetching data for @${USER}${TOKEN ? '' : ' (unauthenticated — may hit rate limits)'}`);
  const [profile, repos] = await Promise.all([
    gh(`https://api.github.com/users/${USER}`),
    fetchRepos(),
  ]);
  console.log(`  ${repos.length} non-fork repos`);
  const [langs, events] = await Promise.all([fetchLanguages(repos), fetchEvents()]);

  // Self-hosted analytics SVGs (replace the rate-limited third-party cards).
  writeCards({ profile, repos, langs, events });

  let md = fs.readFileSync(README, 'utf8');
  md = replaceSection(md, 'STATS', renderStats(repos, profile));
  md = replaceSection(md, 'LATEST_PROJECTS', renderProjects(repos));
  md = replaceSection(md, 'LANG_BREAKDOWN', renderLanguages(langs));
  md = replaceSection(
    md,
    'UPDATED',
    `<sub>🤖 Auto-updated from live GitHub data · last refreshed ${new Date().toUTCString()}</sub>`
  );

  fs.writeFileSync(README, md);
  console.log('✅ README.md updated');
}

main().catch((err) => {
  console.error('❌ ' + err.message);
  process.exit(1);
});
