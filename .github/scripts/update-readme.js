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
  const langs = await fetchLanguages(repos);

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
