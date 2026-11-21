// AC-49 static check: no browser branching outside src/compat/, no Google-specific browser APIs or
// Google services anywhere (FR-101–FR-103). The Gemini provider endpoint is the one allowed Google host.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html|css|json)$/.test(name)) files.push(p);
  }
};
walk(join(root, 'src'));
files.push(join(root, 'manifest.json'));

const BROWSER_BRANCHING = [/navigator\.userAgent/, /navigator\.brave/, /userAgentData/];
const GOOGLE_SPECIFIC = [
  /chrome\.identity/, /chrome\.gcm/, /chrome\.instanceID/, /getAuthToken/,
  /fonts\.googleapis\.com/, /fonts\.gstatic\.com/, /google-analytics\.com/, /googletagmanager/,
  /firebase/i, /safebrowsing/i, /ajax\.googleapis\.com/,
];

const problems = [];
for (const f of files) {
  const rel = relative(root, f);
  const text = readFileSync(f, 'utf8');
  if (!rel.startsWith('src/compat/')) {
    for (const re of BROWSER_BRANCHING) if (re.test(text)) problems.push(`${rel}: browser branching (${re}) outside src/compat/`);
  }
  for (const re of GOOGLE_SPECIFIC) if (re.test(text)) problems.push(`${rel}: Google-specific API or service (${re})`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`check-compat: OK (${files.length} files)`);
