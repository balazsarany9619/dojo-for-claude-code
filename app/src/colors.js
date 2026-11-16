// Semantic colors for Claude Code output (Balazs 2026-11-11: "unterschiedliche Farben und Dicke für Shell-Befehle,
// Coding, Diff-Zeilen"). Claude Code draws with fixed 256-color codes; Dojo rewrites them on the way to the screen, so
// tool calls, edits, diffs and your prompts read apart at a glance. Codes taken from a captured Claude Code 2.1.322 session:
//   38;5;246 grey   "Ran 1 shell command", "Read 2 files", "⎿", footer hints
//   1m Update/Write/Edit/Bash/Read 22m   tool header after the "⏺" bullet
//   48;5;22 / 48;5;52   added / removed diff line background, 38;5;77 / 38;5;167 the + and - signs
//   38;5;153 light blue file paths and inline code, 38;5;231 "⏺" of an answer, 48;5;237 your prompt bar, 38;5;244 rules
// Plain shell tabs are left alone. Switch: Settings > Terminal > Semantic colors.
const C = (r, g, b) => `38;2;${r};${g};${b}`;
const BG = (r, g, b) => `48;2;${r};${g};${b}`;
const COL = {
  shell: C(255, 184, 108),   // amber: shell commands
  edit: C(196, 156, 255),    // violet: file edits
  read: C(127, 220, 255),    // cyan: reading and searching
  web: C(110, 231, 200),     // teal: web fetch and search
  agent: C(255, 140, 190),   // pink: subagents and skills
  path: C(143, 240, 255),    // paths and inline code
  answer: C(79, 210, 255),   // the bullet in front of an answer
  ok: C(61, 255, 181),       // the bullet in front of a tool call
};
const TOOL_KIND = {
  Bash: 'shell', PowerShell: 'shell', Monitor: 'shell',
  Update: 'edit', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Create: 'edit',
  Read: 'read', Grep: 'read', Glob: 'read', Search: 'read', List: 'read', LS: 'read',
  WebFetch: 'web', WebSearch: 'web', Fetch: 'web',
  Agent: 'agent', Task: 'agent', Skill: 'agent', Workflow: 'agent',
};
const SUMMARY_KIND = { Ran: 'shell', Running: 'shell', Read: 'read', Reading: 'read', Searched: 'read', Searching: 'read', Listed: 'read',
  Wrote: 'edit', Edited: 'edit', Updated: 'edit', Writing: 'edit', Editing: 'edit', Fetched: 'web', Fetching: 'web' };

const SEMANTIC_RULES = [
  // tool header: ESC[1mUpdateESC[22m(  -> bold, colored name
  [/\x1b\[1m([A-Z][A-Za-z]+)\x1b\[22m\(/g, (m, name) => (TOOL_KIND[name] ? `\x1b[1;${COL[TOOL_KIND[name]]}m${name}\x1b[22;39m(` : m)],
  // summary line in grey: ESC[38;5;246mRan ... -> the whole line takes the kind's color, the verb gets bold
  [/\x1b\[38;5;246m(Ran|Running|Read|Reading|Searched|Searching|Listed|Wrote|Edited|Updated|Writing|Editing|Fetched|Fetching) /g,
    (m, verb) => `\x1b[${COL[SUMMARY_KIND[verb]]}m\x1b[1m${verb}\x1b[22m `],
  // diffs: calmer backgrounds that fit the dark glass, neon signs
  [/\x1b\[48;5;22m/g, `\x1b[${BG(14, 52, 40)}m`],
  [/\x1b\[48;5;52m/g, `\x1b[${BG(64, 18, 36)}m`],
  [/\x1b\[38;5;77m/g, `\x1b[${C(61, 255, 181)}m`],
  [/\x1b\[38;5;167m/g, `\x1b[${C(255, 110, 150)}m`],
  // paths and inline code, answer bullet, tool bullet
  [/\x1b\[38;5;153m/g, `\x1b[${COL.path}m`],
  [/\x1b\[38;5;231m⏺/g, `\x1b[${COL.answer}m⏺`],
  [/\x1b\[38;5;114m⏺/g, `\x1b[${COL.ok}m⏺`],
  // your prompt bar: blue instead of grey, and the rules around the input a touch bluer
  [/\x1b\[48;5;237m/g, `\x1b[${BG(22, 40, 82)}m`],
  [/\x1b\[38;5;244m/g, `\x1b[${C(60, 92, 150)}m`],
];

function colorize(s, data) {
  if (s.kind !== 'claude' || typeof settings === 'undefined' || !settings.semanticColors || data.indexOf('\x1b[') < 0) return data;
  for (const [re, to] of SEMANTIC_RULES) data = data.replace(re, to);
  return data;
}
