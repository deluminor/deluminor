#!/usr/bin/env node
/**
 * Custom GitHub Profile SVG Generator
 * Isometric 3D contribution calendar + language donut chart
 * Theme: Cyan/Electric #00D9FF on dark background
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const USERNAME = process.env.GITHUB_USERNAME || process.env.GITHUB_ACTOR;
const TOKEN    = process.env.GITHUB_TOKEN;

const OUT_DIR  = 'profile-3d-contrib';
const OUT_FILE = path.join(OUT_DIR, 'profile-cyan.svg');

// SVG canvas
const W = 980;
const H = 375;

// Isometric tile dimensions
const TW = 20;  // full tile width
const TH = 10;  // tile height (TW/2 for isometric 30°)

// Cube height per contribution level (0 = none → 4 = max)
const CUBE_H = [2, 16, 32, 50, 68];

// Calendar grid origin on SVG canvas
const CAL_X = 390;
const CAL_Y = 76;

// ─── Color palette ────────────────────────────────────────────────────────────

const BG   = '#0D1117';
const TEXT = '#00D9FF';

// Isometric cube faces per level: top / right / left
const TOP   = ['#161B22', '#004E64', '#008099', '#00B8D4', '#00D9FF'];
const RIGHT = ['#161B22', '#003A4D', '#006B82', '#009DB8', '#00BEE0'];
const LEFT  = ['#161B22', '#002633', '#005466', '#00879B', '#00A8C7'];

// Language colors — vibrant, clearly distinct on dark background
const LANG_COLOR = {
  TypeScript:   '#00D9FF',  // cyan (theme accent)
  JavaScript:   '#F7C948',  // gold
  Python:       '#FF6B6B',  // coral
  CSS:          '#BD5FFF',  // violet
  HTML:         '#FF8C42',  // orange
  Java:         '#FF4757',  // red
  Rust:         '#FF7043',  // deep orange
  Go:           '#2ED573',  // green
  'C++':        '#5352ED',  // indigo
  'C#':         '#4FC3F7',  // light blue
  Ruby:         '#E91E63',  // pink
  Swift:        '#FF6B81',  // rose
  Kotlin:       '#A55EEA',  // purple
  Dart:         '#54C5F8',  // sky
  Vue:          '#41B883',  // vue green
  Shell:        '#4CD964',  // lime
  SCSS:         '#E91E8C',  // hot pink
  Dockerfile:   '#2196F3',  // blue
  _other:       '#445566',
};

// ─── HTTP / GitHub API ────────────────────────────────────────────────────────

/** Execute a GitHub GraphQL query */
function gql(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req  = https.request(
      {
        hostname: 'api.github.com',
        path:     '/graphql',
        method:   'POST',
        headers:  {
          Authorization:  `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent':   'deluminor-metrics/1.0',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          const json = JSON.parse(raw);
          if (json.errors) return reject(new Error(json.errors[0].message));
          resolve(json.data);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchCalendar() {
  const to   = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 1);

  const data = await gql(
    `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                contributionLevel
                date
              }
            }
          }
        }
      }
    }`,
    { login: USERNAME, from: from.toISOString(), to: to.toISOString() }
  );

  return data.user.contributionsCollection.contributionCalendar;
}

async function fetchLanguages() {
  const data = await gql(
    `query($login: String!) {
      user(login: $login) {
        repositories(
          first: 100
          isFork: false
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          nodes {
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name } }
            }
          }
        }
      }
    }`,
    { login: USERNAME }
  );

  const totals = {};
  for (const repo of data.user.repositories.nodes) {
    for (const { size, node } of repo.languages.edges) {
      totals[node.name] = (totals[node.name] || 0) + size;
    }
  }

  const sorted = Object.entries(totals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6);

  const total = sorted.reduce((s, [, v]) => s + v, 0);

  return sorted.map(([name, size]) => ({
    name,
    pct:   size / total,
    color: LANG_COLOR[name] ?? LANG_COLOR._other,
  }));
}

// ─── SVG helpers ──────────────────────────────────────────────────────────────

/** Format array of [x,y] pairs as SVG polygon points string */
const pts = (arr) =>
  arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/** Map GitHub contribution level string to 0–4 */
const LEVEL = {
  NONE:            0,
  FIRST_QUARTILE:  1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE:  3,
  FOURTH_QUARTILE: 4,
};

/**
 * Convert isometric grid position (week, day) to SVG screen coords.
 * The calendar reads left→right (weeks) and top-left→bottom-left (days).
 */
function isoXY(week, day) {
  return [
    CAL_X + (week - day) * (TW / 2),
    CAL_Y + (week + day) * (TH / 2),
  ];
}

// ─── Isometric cube ───────────────────────────────────────────────────────────

/**
 * Render one isometric cube at grid position (week, day) with given level.
 * Animation delay is staggered per week column to create a growing-trees wave.
 *
 * @param {number} week      - column index (0–52)
 * @param {number} day       - row index (0–6)
 * @param {number} level     - contribution level (0–4)
 * @param {number} weekIndex - actual week index for animation delay
 */
function renderCube(week, day, level, weekIndex) {
  const [bx, by] = isoXY(week, day);
  const h        = CUBE_H[level];

  /*
   * Cube vertices (isometric projection):
   *
   *          G
   *        /   \
   *      Hv     F      ← top face
   *        \   /
   *    C    E    B
   *      \ / \ /
   *       A              ← front-bottom vertex
   *
   * A = front-bottom,  B = right-bottom, C = left-bottom
   * E = front-top,     F = right-top,    G = back-top,  Hv = left-top
   */
  const A  = [bx,          by          ];  // front-bottom
  const B  = [bx + TW / 2, by - TH / 2];  // right-bottom
  const C  = [bx - TW / 2, by - TH / 2];  // left-bottom
  const E  = [bx,          by - h      ];  // front-top
  const F  = [bx + TW / 2, by - TH / 2 - h];  // right-top
  const G  = [bx,          by - TH     - h];  // back-top
  const Hv = [bx - TW / 2, by - TH / 2 - h];  // left-top

  const delay  = weekIndex * 14;  // 14ms stagger per week column — wave effect
  const filter = level === 4 ? ` filter="url(#glow)"` : '';

  /*
   * SVG transform-origin uses viewport coords by default (no transform-box needed).
   * Anchoring at (bx, by) = front-bottom vertex means scaleY(0) collapses the
   * entire cube to its base — each cube grows upward like a tree.
   */
  const origin = `${bx.toFixed(1)}px ${by.toFixed(1)}px`;
  const dur    = level === 0 ? 280 : 360 + level * 20;
  const ease   = level === 0
    ? 'ease-out'
    : 'cubic-bezier(0.34, 1.56, 0.64, 1)';  // spring overshoot

  const style = `transform-origin:${origin};animation:growUp ${dur}ms ${ease} ${delay}ms both`;

  return `<g style="${style}"${filter}>
    <polygon points="${pts([A, B, F, E])}"  fill="${RIGHT[level]}"/>
    <polygon points="${pts([A, C, Hv, E])}" fill="${LEFT[level]}"/>
    <polygon points="${pts([E, F, G, Hv])}" fill="${TOP[level]}"/>
  </g>`;
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

function renderCalendar(weeks) {
  // Collect all cubes with painter's-algorithm depth key (back → front)
  const cubes = [];

  for (let wi = 0; wi < weeks.length; wi++) {
    const { contributionDays } = weeks[wi];
    for (let di = 0; di < contributionDays.length; di++) {
      const level = LEVEL[contributionDays[di].contributionLevel] ?? 0;
      cubes.push({ wi, di, level, depth: wi + di });
    }
  }

  // Ascending depth = render furthest cubes first (painter's algorithm)
  cubes.sort((a, b) => a.depth - b.depth);

  return cubes
    .map(({ wi, di, level }) => renderCube(wi, di, level, wi))
    .join('\n');
}

// ─── Language donut chart ─────────────────────────────────────────────────────

function renderDonut(langs) {
  if (!langs.length) return '<!-- no language data -->';

  // Position: bottom-left corner, safely left of the isometric calendar
  const cx = 92;
  const cy = 272;
  const R  = 58;   // outer radius
  const r  = 36;   // inner radius

  const slices = [];
  let angle    = -Math.PI / 2;  // start at 12 o'clock

  for (let i = 0; i < langs.length; i++) {
    const sweep = langs[i].pct * 2 * Math.PI;
    const end   = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;

    const x1 = (cx + R * Math.cos(angle)).toFixed(2);
    const y1 = (cy + R * Math.sin(angle)).toFixed(2);
    const x2 = (cx + R * Math.cos(end)).toFixed(2);
    const y2 = (cy + R * Math.sin(end)).toFixed(2);
    const ix1 = (cx + r * Math.cos(end)).toFixed(2);
    const iy1 = (cy + r * Math.sin(end)).toFixed(2);
    const ix2 = (cx + r * Math.cos(angle)).toFixed(2);
    const iy2 = (cy + r * Math.sin(angle)).toFixed(2);

    const d     = `M${x1} ${y1} A${R} ${R} 0 ${large} 1 ${x2} ${y2} L${ix1} ${iy1} A${r} ${r} 0 ${large} 0 ${ix2} ${iy2}Z`;
    const delay = 800 + i * 80;  // stagger after calendar starts growing

    slices.push(
      `<path d="${d}" fill="${langs[i].color}" style="animation:fadeIn 400ms ease-out ${delay}ms both"/>`
    );

    angle = end;
  }

  // Legend to the right of the donut
  const lx = cx + R + 16;
  const legend = langs.map(({ name, pct, color }, i) => {
    const ly    = cy - R + i * 21 + 8;
    const delay = 900 + i * 80;
    return `<g style="animation:fadeIn 300ms ease-out ${delay}ms both">
      <rect x="${lx}" y="${ly - 7}" width="9" height="9" rx="2" fill="${color}"/>
      <text x="${lx + 13}" y="${ly + 1}" fill="${TEXT}" font-size="11" font-family="'SF Mono',Consolas,monospace">${name}</text>
      <text x="${lx + 116}" y="${ly + 1}" fill="#3A5566" font-size="10" font-family="'SF Mono',Consolas,monospace" text-anchor="end">${(pct * 100).toFixed(1)}%</text>
    </g>`;
  });

  return `<g>${slices.join('')}${legend.join('')}</g>`;
}

// ─── SVG assembly ─────────────────────────────────────────────────────────────

function buildSVG(calendar, langs) {
  const calSVG   = renderCalendar(calendar.weeks);
  const donutSVG = renderDonut(langs);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <style>
    @keyframes growUp {
      0%   { transform: scaleY(0); opacity: 0   }
      60%  { opacity: 1                          }
      100% { transform: scaleY(1)                }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px) }
      to   { opacity: 1; transform: translateY(0)   }
    }
  </style>

  <!-- Cyan glow for maximum-contribution cubes -->
  <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="2.5" result="blur"/>
    <feMerge>
      <feMergeNode in="blur"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
</defs>

<!-- Background -->
<rect width="${W}" height="${H}" fill="${BG}"/>

<!-- 3D Isometric Contribution Calendar -->
${calSVG}

<!-- Language Donut Chart -->
${donutSVG}
</svg>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!TOKEN)    throw new Error('GITHUB_TOKEN is required');
  if (!USERNAME) throw new Error('GITHUB_USERNAME or GITHUB_ACTOR is required');

  console.log(`→ Generating metrics for @${USERNAME}`);

  const [calendar, langs] = await Promise.all([
    fetchCalendar(),
    fetchLanguages(),
  ]);

  console.log(`  Total contributions: ${calendar.totalContributions}`);
  console.log(`  Languages: ${langs.map((l) => l.name).join(', ')}`);

  const svg = buildSVG(calendar, langs);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, svg, 'utf8');
  console.log(`✓ Saved → ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('✗', err.message);
  process.exit(1);
});
