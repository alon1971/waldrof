const { execSync } = require('child_process');
const names = ['mapRow','filterByGrade','loadCommunity','getDynamicTopicsForGrade','renderCatalogGrades','collectCatalogFilesForGrade','collectCatalogFiles','renderCatalog'];
function extract(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = src.match(re);
  if (!m) return { err: 'not found' };
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { text: src.slice(m.index, i + 1) };
    }
  }
  return { err: 'unclosed' };
}
const repo = 'c:/Users/alon1/Documents/Waldrof';
for (const rev of ['31f5ac0', 'HEAD']) {
  const src = execSync(`git -C ${repo} show ${rev}:index.html`, { encoding: 'utf8', maxBuffer: 80 * 1024 * 1024 });
  console.log('\n######## ' + rev + ' ########\n');
  for (const n of names) {
    const r = extract(src, n);
    if (r.err) { console.log('--- ' + n + ' ERROR: ' + r.err); continue; }
    console.log('--- ' + n + ' ---');
    console.log(r.text);
    console.log('');
  }
}
