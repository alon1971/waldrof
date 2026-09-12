const { execSync } = require('child_process');
const src = execSync('git -C c:/Users/alon1/Documents/Waldrof show HEAD:index.html', { encoding: 'utf8', maxBuffer: 80 * 1024 * 1024 });
const start = src.indexOf('async function renderCatalog(');
let i = src.indexOf('{', start);
let depth = 0;
let end = i;
for (; end < src.length; end++) {
  const c = src[end];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) break; }
}
const fn = src.slice(start, end + 1);
const idx = fn.indexOf("view === 'grades'");
console.log(fn.slice(idx, idx + 1200));
