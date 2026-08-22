/**
 * Static validation: syntax-checks every source file and verifies that every
 * path referenced by the manifest and the extension's HTML pages resolves.
 *
 * Fast enough to run before every commit; the browser test in e2e-test.js is
 * the slow, thorough counterpart.
 */
const { execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;

/**
 * Remove comments without mistaking a string for one.
 *
 * The naive version -- three chained .replace() calls -- was wrong in a way
 * that made this whole check unreliable, and silently. Any source containing a
 * match pattern like '*://*.facebook.com/*' has a slash-star inside a STRING,
 * which the regex read as the start of a block comment and closed at the next
 * star-slash anywhere in the file. Everything between vanished. In
 * service-worker.js that was updateBadge() onwards, so a T() call in there
 * counted as a mention of nothing -- and the "every key the UI asks for exists"
 * check, whose entire job is to catch a missing translation before it ships,
 * was quietly not reading that code at all.
 *
 * So this one tracks quotes. Regex literals are treated as strings too, which
 * is not exact -- telling division from a regex needs a real parser -- but it
 * errs toward keeping code rather than deleting it, and deleting it is the
 * failure that matters here.
 */
function stripCommentsAware(src) {
  const STAR = String.fromCharCode(42);
  const SLASH = String.fromCharCode(47);
  const BACKSLASH = String.fromCharCode(92);
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '<' && src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (c === SLASH && d === STAR) {
      const end = src.indexOf(STAR + SLASH, i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === SLASH && d === SLASH) {
      const end = src.indexOf(String.fromCharCode(10), i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === BACKSLASH) { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function report(ok, label, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

// ---- 1. syntax ------------------------------------------------------------
function jsFiles(dir, acc) {
  acc = acc || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      jsFiles(p, acc);
    } else if (e.name.endsWith('.js')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Syntax-check one file, as the thing it actually is.
 *
 * `node --check foo.js` parses as CommonJS. The MV3 service worker is declared
 * "type": "module" and uses import, and under CommonJS parsing node happily
 * accepted a file with a duplicate top-level `const` -- a hard SyntaxError that
 * would have stopped the worker loading, reported here as clean. Anything with
 * an import or export is copied to a .mjs and checked as a module.
 */
function checkSyntax(file) {
  const src = fs.readFileSync(file, 'utf8');
  const isModule = /^\s*(?:import|export)\s/m.test(src);
  if (!isModule) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return;
  }
  const tmp = path.join(os.tmpdir(),
    'cb-syntax-' + process.pid + '-' + path.basename(file, '.js') + '.mjs');
  fs.writeFileSync(tmp, src);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}

// Only the directories this repository actually has. The extension and the
// backend were one tree once and this list was written for it; a hard-coded
// directory that is now in the other repository should mean "nothing to scan",
// not a crash on the first check.
const SCAN_DIRS = ['src', 'hosting', 'server', 'shared', 'tools']
  .map(d => path.join(ROOT, d))
  .filter(d => fs.existsSync(d));

for (const f of SCAN_DIRS.reduce((acc, d) => acc.concat(jsFiles(d)), [])) {
  try {
    checkSyntax(f);
    report(true, 'syntax ' + path.relative(ROOT, f));
  } catch (e) {
    report(false, 'syntax ' + path.relative(ROOT, f),
      String(e.stderr || e.message).split('\n').slice(0, 3).join(' '));
  }
}

// ---- 2. manifest ----------------------------------------------------------
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  report(true, 'manifest.json parses');
} catch (e) {
  report(false, 'manifest.json parses', e.message);
}

if (manifest) {
  const refs = [];
  if (manifest.background) refs.push(manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) {
    (cs.js || []).forEach(r => refs.push(r));
    (cs.css || []).forEach(r => refs.push(r));
  }
  if (manifest.action) refs.push(manifest.action.default_popup);
  if (manifest.options_page) refs.push(manifest.options_page);
  Object.values(manifest.icons || {}).forEach(r => refs.push(r));

  for (const r of refs.filter(Boolean)) {
    report(fs.existsSync(path.join(ROOT, r)), 'manifest ref ' + r);
  }

  // MAIN-world content scripts must not be granted extension APIs by mistake,
  // and the isolated bundle must load protocol.js before anything using it.
  const main = (manifest.content_scripts || []).find(c => c.world === 'MAIN');
  const iso = (manifest.content_scripts || []).find(c => c.world !== 'MAIN');
  report(!!main && main.run_at === 'document_start',
    'MAIN world script runs at document_start',
    main ? main.run_at : 'no MAIN entry');
  // i18n.js goes ahead of protocol.js, not merely somewhere before the scripts
  // that paint: protocol.js resolves the tag labels through CB_T, so loading it
  // first would freeze the one vocabulary every screen shares into English.
  report(!!iso && (iso.js || []).slice(0, 2).join(',') ===
    'src/common/i18n.js,src/common/protocol.js',
    'i18n.js then protocol.js lead the isolated bundle',
    iso ? (iso.js || []).slice(0, 2).join(', ') : 'no isolated entry');

  report(manifest.default_locale === 'en' &&
    fs.existsSync(path.join(ROOT, '_locales', manifest.default_locale, 'messages.json')),
    'default_locale is en and _locales/en/messages.json exists',
    manifest.default_locale || 'unset');

  const minChrome = parseInt(manifest.minimum_chrome_version, 10);
  report(minChrome >= 111, 'minimum_chrome_version supports world:MAIN',
    manifest.minimum_chrome_version);
}

// ---- 3. HTML asset references --------------------------------------------
for (const rel of ['src/popup/popup.html', 'src/options/options.html',
                   'src/welcome/welcome.html']) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { report(false, 'exists ' + rel); continue; }
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const re = /(?:src|href)="([^"#]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    if (/^(https?:)?\/\//.test(m[1])) continue;
    report(fs.existsSync(path.resolve(dir, m[1])), `${rel} -> ${m[1]}`);
  }
  // MV3 extension pages may not use inline script.
  report(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(src),
    `${rel} has no inline script (MV3 CSP)`);
}

// ---- 5. every settings field the options page binds must exist ------------
//
// options.js reads its fields by id and assigns straight onto the element. A
// field listed there with no matching input throws on load and takes the whole
// options page with it -- and nothing else in this file would notice, because
// both files are individually valid.
{
  const jsPath = path.join(ROOT, 'src', 'options', 'options.js');
  const htmlPath = path.join(ROOT, 'src', 'options', 'options.html');
  try {
    const js = fs.readFileSync(jsPath, 'utf8');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const fields = [];
    for (const m of js.matchAll(/const (?:TEXT|NUM|BOOL|SELECT)_FIELDS = \[([^\]]*)\]/g)) {
      for (const q of m[1].matchAll(/'([^']+)'/g)) fields.push(q[1]);
    }
    const missing = fields.filter(f => !html.includes('id="' + f + '"'));
    report(missing.length === 0,
      'options.js fields all exist in options.html (' + fields.length + ')',
      missing.length ? 'missing: ' + missing.join(', ') : '');
  } catch (e) {
    report(false, 'options settings fields', e.message);
  }
}

// ---- 6. every element the popup and activity pages reach for must exist ---
//
// Same failure as the options check above, in the files people actually open.
// $('someId') on a missing element returns null and the next property access
// throws, which blanks the whole page -- and both files stay individually
// valid, so nothing else here would catch it.
for (const page of ['popup', 'activity', 'welcome']) {
  const jsPath = path.join(ROOT, 'src', page, page + '.js');
  const htmlPath = path.join(ROOT, 'src', page, page + '.html');
  try {
    const js = fs.readFileSync(jsPath, 'utf8');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const ids = new Set();
    for (const m of js.matchAll(/\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) ids.add(m[1]);
    for (const m of js.matchAll(/\bshow\(\s*['"]([A-Za-z0-9_-]+)['"]/g)) ids.add(m[1]);
    const list = [...ids];
    const missing = list.filter(f => !html.includes('id="' + f + '"'));
    report(missing.length === 0,
      page + '.js elements all exist in ' + page + '.html (' + list.length + ')',
      missing.length ? 'missing: ' + missing.join(', ') : '');
  } catch (e) {
    report(false, page + ' elements', e.message);
  }
}

// ---- 7. the retired "Layer 1 / Layer 2" framing --------------------------
//
// The product used to be described as Layer 1 (hide) and Layer 2 (real block).
// That named the implementation rather than the choice anyone was making, and
// a mode picker replaced it -- which was itself replaced, see 7b. It is the
// kind of vocabulary that creeps back one label at a time, so this fails the
// build if it does.
//
// Only what a reader can actually see is scanned: every HTML page under src/,
// plus the quoted strings in the scripts those pages run. Comments still
// explaining where the old names went are exempt on purpose -- that history is
// worth keeping, and a check that punished it would just get the explanations
// deleted.
{
  const RETIRED = /\bLayer\s*[12]\b/i;
  const offenders = [];

  const htmlFiles = (dir, acc) => {
    acc = acc || [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) htmlFiles(p, acc); }
      else if (e.name.endsWith('.html')) acc.push(p);
    }
    return acc;
  };

  for (const file of htmlFiles(path.join(ROOT, 'src'))) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (RETIRED.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
    });
  }

  // The five scripts that put text on a screen: the three extension pages and
  // the two content scripts that render into the site itself. Comments come
  // out first, so what is tested is only what could reach a user.
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const STRINGS = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

  for (const rel of ['src/popup/popup.js', 'src/options/options.js',
                     'src/activity/activity.js', 'src/content/report-ui.js',
                     'src/content/dom-blocker.js']) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) { report(false, 'exists ' + rel); continue; }
    for (const s of stripComments(fs.readFileSync(file, 'utf8')).match(STRINGS) || []) {
      if (RETIRED.test(s)) offenders.push(rel + ' -> ' + s.slice(0, 60));
    }
  }

  report(offenders.length === 0, 'the "Layer 1 / Layer 2" framing is gone from the UI',
    offenders.join('; '));
}

// ---- 7b. the retired passive/active mode ---------------------------------
//
// What the extension is allowed to block used to be one setting called `mode`,
// with the values 'passive' and 'active'. It is now two independent switches,
// blockSeen and blockFromList, because the pair the radio could not express --
// work through the ranked list but leave what I scroll past alone -- is a
// perfectly reasonable thing to want.
//
// Two ways that could rot. A page could go on reading the dead setting and
// silently show the wrong state, or somebody could reintroduce the words as a
// label and leave the product with two vocabularies for one thing. So:
//
//   1. nothing under src/ may read `mode`, compare against its values or call
//      CB_MODE_OF, except the back-compat readers in protocol.js and
//      service-worker.js -- which exist precisely to keep old installs working
//      and must not be tidied away;
//   2. no page script may hardcode 'passive' or 'active' as a mode string, and
//      no page may keep the radio buttons that used to write it.
//
// Comments are stripped before any of this. An explanation of where the old
// setting went is worth keeping, and a check that punished it would only get
// the explanation deleted.
{
  const stripJsComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const htmlPages = (dir, acc) => {
    acc = acc || [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) htmlPages(p, acc); }
      else if (e.name.endsWith('.html')) acc.push(p);
    }
    return acc;
  };

  // `mode` as a settings key, however it is spelled. `hideMode` is a different
  // setting and stays: the word boundary keeps them apart without a list of
  // exceptions.
  const MODE_KEY = /\.mode\b|\[\s*['"]mode['"]\s*\]/;
  // Its values, in the shapes a value actually turns up in: assigned, compared,
  // or handed over as a property. Deliberately not a bare /'active'/ -- that is
  // also the CSS class on a selected chip, and a check that cried wolf about
  // styling would be switched off within the week.
  const MODE_VALUE =
    /(?:\bmode\s*(?:=|===?|!==?|:)\s*|[!=]==?\s*|\?\s*|:\s*)(['"])(?:passive|active)\1/;
  const MODE_READER = /\bCB_MODE_OF\b|\bmodeOf\s*\(/;
  // The flag that predates modes entirely and means what blockFromList off
  // means. protocol.js reads it so nobody's old install changes behaviour
  // under them; nothing else should know the name at all.
  const LEGACY_FLAG = /\bacceptServerTargets\b/;

  const ALLOWED = ['src/common/protocol.js', 'src/background/service-worker.js'];

  const offenders = [];
  for (const file of jsFiles(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (ALLOWED.includes(rel)) continue;
    stripJsComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/).forEach((line, i) => {
      if (MODE_KEY.test(line) || MODE_VALUE.test(line) ||
          MODE_READER.test(line) || LEGACY_FLAG.test(line)) {
        offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 50)}`);
      }
    });
  }
  report(offenders.length === 0,
    'the removed `mode` setting is read nowhere but the back-compat readers',
    offenders.join('; '));

  // The words themselves, in the files that put text on a screen. This is what
  // stops the vocabulary creeping back one label at a time: a 'passive' or
  // 'active' string in a page script is a mode string whatever it is doing
  // there, because the two switches have no such values to spell.
  const PAGE_SCRIPTS = ['src/popup/popup.js', 'src/options/options.js',
                        'src/activity/activity.js', 'src/content/report-ui.js',
                        'src/content/dom-blocker.js', 'src/content/main.js'];
  const said = [];
  for (const rel of PAGE_SCRIPTS) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) { report(false, 'exists ' + rel); continue; }
    stripJsComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/).forEach((line, i) => {
      if (MODE_VALUE.test(line)) said.push(`${rel}:${i + 1} ${line.trim().slice(0, 50)}`);
    });
  }
  // And the controls that used to write it. The pages are built around two
  // tick boxes now; a stray radio would be a second way to set the same thing.
  for (const file of htmlPages(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/id="mode(Passive|Active)"|name="mode"/.test(line)) {
        said.push(`${rel}:${i + 1} ${line.trim().slice(0, 50)}`);
      }
    });
  }
  report(said.length === 0,
    'no page hardcodes a passive/active mode string or picker',
    said.join('; '));
}

// ---- 8. the tag vocabulary ------------------------------------------------
//
// TAGS is the product's whole vocabulary and it lives in two repositories now:
// here in protocol.js, and in shared/logic.js in the backend, which derives
// verdicts from it. Nothing in THIS repository can see the other half, so what
// is checked here is that the list is well formed and that the extension's own
// files agree about it.
//
// The drift that check used to catch degrades gracefully rather than silently:
// a tag the backend publishes that this build does not know is matched by
// nobody's blockTags and is simply not blocked, which is the documented
// behaviour for a category introduced after a release. The backend's own suite
// holds the comparison, against a checkout of this repository when it has one.
{
  const TAG_LIST = /const TAGS = \[([^\]]*)\]/;
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src/common/protocol.js'), 'utf8');
    const m = TAG_LIST.exec(src);
    if (!m) throw new Error('no TAGS array in protocol.js');
    const tags = [...m[1].matchAll(/'([^']+)'/g)].map(q => q[1]);
    report(tags.length >= 5 && new Set(tags).size === tags.length,
      `TAGS is a well-formed vocabulary (${tags.length})`,
      tags.join(','));
    // Every tag needs a label to render, in both languages. A tag with no
    // label shows as the raw key in the report sheet and the options page.
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));
    const vi = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/vi/messages.json'), 'utf8'));
    const unlabelled = tags.filter(t => !en['tag_' + t] || !vi['tag_' + t]);
    report(unlabelled.length === 0, 'every tag has a label in both languages',
      unlabelled.join(', '));
  } catch (e) {
    report(false, 'TAGS is a well-formed vocabulary', e.message);
  }
}

// ---- 8b. the two i18n entry points are not interchangeable ---------------
//
// CB_FILL_I18N writes ONE element from a string it is handed: fill(el, text).
// CB_APPLY_I18N sweeps a root for [data-i18n] and fills each match. The names
// are close, the arities differ, and calling FILL where APPLY was meant does
// not fail loudly -- fill(document, undefined) throws on `text.length` AFTER
// clearing nothing, so a language picker wired that way silently does nothing.
// That shipped on the welcome page and is exactly the sort of thing nobody
// notices until somebody asks why a page has no Vietnamese.
{
  const offenders = [];
  const jsUnder = (dir, acc) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) jsUnder(rel, acc);
      else if (e.name.endsWith('.js')) acc.push(rel);
    }
    return acc;
  };
  for (const rel of jsUnder('src', [])) {
    if (rel.endsWith('common/i18n.js')) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const m of text.matchAll(/CB_FILL_I18N\s*\(([^)]*)\)/g)) {
      // Two arguments is the correct call; anything else is the mix-up.
      if (m[1].split(',').length < 2) offenders.push(rel + ': CB_FILL_I18N(' + m[1].trim() + ')');
    }
  }
  report(offenders.length === 0,
    'CB_FILL_I18N is never called where CB_APPLY_I18N was meant',
    offenders.join('; '));
}

// ---- 8c. every relative link in the documentation resolves ---------------
//
// The documentation is now a set of files that link to each other, which makes
// a moved file a broken promise rather than a tidy-up. This caught four the
// moment the README was split: sections written when they lived in the README
// carried root-relative paths with them into docs/, where `docs/RESEARCH.md`
// means `docs/docs/RESEARCH.md` and does not exist.
//
// Anchors are deliberately not checked. A heading is renamed far more often
// than a file is moved, and a check that failed the build over a `#section`
// would be turned off within a week.
{
  const md = [];
  const walkMd = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? dir + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (!['node_modules', '.git', 'dist', 'store'].includes(e.name)) walkMd(rel);
      } else if (e.name.endsWith('.md')) md.push(rel);
    }
  };
  walkMd('');

  const broken = [];
  let seen = 0;
  for (const rel of md) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      seen++;
      const target = path.resolve(path.dirname(path.join(ROOT, rel)), href.split('#')[0]);
      if (!fs.existsSync(target)) broken.push(rel + ' -> ' + href);
    }
  }
  report(broken.length === 0,
    `every relative link in the docs resolves (${seen} checked)`,
    broken.join('; '));
}

// ---- 9a1. nothing invisible of ours may take a click ----------------------
//
// The hover chip is position:fixed at the maximum z-index inside somebody
// else's page, and it is hidden by fading to opacity 0 -- which paints nothing
// and blocks everything. For the life of the page it went on swallowing clicks
// over its last rectangle, so clicking Like on Threads opened the report sheet
// for whichever profile had been hovered before it. The cure is one CSS line,
// and it is the kind of line a later edit drops without noticing, so it is
// held here.
{
  const src = fs.readFileSync(path.join(ROOT, 'src/content/report-ui.js'), 'utf8');
  const rule = (selector) => {
    const i = src.indexOf(selector + ' {');
    if (i < 0) return null;
    return src.slice(i, src.indexOf('}', i));
  };
  const hidden = rule('.chip');
  const shown = rule('.chip.show');
  const okHidden = !!hidden && /pointer-events:\s*none/.test(hidden);
  const okShown = !!shown && /pointer-events:\s*auto/.test(shown);
  report(okHidden, 'the hidden hover chip cannot be clicked',
    okHidden ? 'pointer-events: none'
             : (hidden ? 'MISSING from .chip' : '.chip rule not found'));
  report(okShown, 'and the shown one can',
    okShown ? 'pointer-events: auto'
            : (shown ? 'MISSING from .chip.show' : '.chip.show rule not found'));
}

// ---- 10. the two locales -------------------------------------------------
//
// chrome.i18n fails soft in every direction that matters here. A key present in
// en and missing from vi silently serves English to a Vietnamese reader; a key
// present in vi and missing from en is dead weight nothing can ever ask for; an
// empty message renders as the key, which is the fallback working as designed
// but not what anyone wanted to ship. None of the three is visible in a diff of
// two 250-key files, and all three are trivial to test.
{
  const LOCALES = ['en', 'vi'];
  const loaded = {};
  for (const l of LOCALES) {
    const file = path.join(ROOT, '_locales', l, 'messages.json');
    try {
      const buf = fs.readFileSync(file);
      // A BOM makes the file valid JSON to some parsers and not to Chrome's.
      report(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF),
        `_locales/${l}/messages.json is UTF-8 with no BOM`);
      loaded[l] = JSON.parse(buf.toString('utf8'));
      report(true, `_locales/${l}/messages.json parses (${Object.keys(loaded[l]).length} keys)`);
    } catch (e) {
      report(false, `_locales/${l}/messages.json parses`, e.message);
    }
  }

  const en = loaded.en, vi = loaded.vi;
  if (en && vi) {
    const missingVi = Object.keys(en).filter(k => !(k in vi));
    const missingEn = Object.keys(vi).filter(k => !(k in en));
    const shared = Object.keys(en).filter(k => k in vi).length;
    // The count is as much the point of this line as the pass is: two files
    // that agree on nothing agree perfectly, and only the number tells the
    // difference between that and 250 keys in step.
    report(missingVi.length === 0 && missingEn.length === 0,
      `every key exists in both locales (${shared})`,
      [missingVi.length ? 'absent from vi: ' + missingVi.join(', ') : '',
       missingEn.length ? 'absent from en: ' + missingEn.join(', ') : ''].filter(Boolean).join('; '));

    const empty = [], undescribed = [], mismatched = [];
    const placeholdersOf = (s) => [...String(s).matchAll(/\$(\d)/g)].map(m => m[1]).sort().join('');
    for (const l of LOCALES) {
      for (const [key, entry] of Object.entries(loaded[l])) {
        if (!entry || !String(entry.message || '').trim()) empty.push(`${l}:${key}`);
        // Not decoration. A translator seeing "failed" with no context cannot
        // tell a tile caption from a verb, and produces confident nonsense.
        if (!entry || !String(entry.description || '').trim()) undescribed.push(`${l}:${key}`);
      }
    }
    for (const key of Object.keys(en)) {
      if (!(key in vi)) continue;
      if (placeholdersOf(en[key].message) !== placeholdersOf(vi[key].message)) mismatched.push(key);
    }
    report(empty.length === 0, 'every message has text', empty.join(', '));
    report(undescribed.length === 0, 'every message has a description', undescribed.join(', '));
    // A translation that drops a $1 loses the number the sentence was about.
    report(mismatched.length === 0,
      'both locales use the same placeholders in each message', mismatched.join(', '));
  }

  // ---- 11. no orphaned keys, in either direction -------------------------
  if (en) {
    const used = new Set();
    const walkFiles = (dir, exts, acc) => {
      acc = acc || [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith('.')) walkFiles(f, exts, acc); }
        else if (exts.some(x => e.name.endsWith(x))) acc.push(f);
      }
      return acc;
    };
    // Every quoted string in the sources that happens to spell a key. Looser
    // than the call sites below on purpose, because plenty of keys reach CB_T
    // through a variable -- `T(listed ? 'popup_reportAgainButton' : …)` names
    // both of them and calls neither directly.
    const mentioned = new Set();
    const sources = walkFiles(path.join(ROOT, 'src'), ['.js', '.html']);
    for (const file of sources) {
      // Comments come out first. A note explaining what `popup_reportButton`
      // does is documentation, not a call, and a check that failed the build
      // over one would only get the explanation deleted.
      const text = stripCommentsAware(fs.readFileSync(file, 'utf8'));
      // CB_T('key') and the T('key') alias each page binds it to.
      for (const m of text.matchAll(/\b(?:CB_T|T)\(\s*'([A-Za-z0-9_]+)'/g)) used.add(m[1]);
      for (const m of text.matchAll(/data-i18n(?:-placeholder|-title|-label)?="([A-Za-z0-9_]+)"/g)) {
        used.add(m[1]);
      }
      for (const m of text.matchAll(/'([A-Za-z0-9_]+)'/g)) mentioned.add(m[1]);
    }
    for (const m of fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')
      .matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);

    const unknown = [...used].filter(k => !(k in en));
    report(unknown.length === 0,
      `every key the UI asks for exists in en (${used.size} used)`,
      unknown.join(', '));

    // Keys nothing names literally, because they are built from a value at
    // run time. Each one is a family, and the family is what has to be listed.
    const DYNAMIC = [
      /^tag_/              // 'tag_' + tag, built in protocol.js from TAGS
    ];
    const unused = Object.keys(en)
      .filter(k => !used.has(k) && !mentioned.has(k) && !DYNAMIC.some(re => re.test(k)));
    // A warning, not a failure: a key may legitimately land one commit before
    // the screen that uses it, and failing the build over that only teaches
    // people to delete strings they were about to need.
    if (unused.length) console.log(`warn  ${unused.length} key(s) in en are referenced nowhere` +
      `  — ${unused.join(', ')}`);
  }

  // ---- 12. no hardcoded UI strings left in the page markup --------------
  //
  // The pages carry data-i18n attributes and, outside them, no words at all.
  // That is the whole point: a string typed straight into the HTML looks
  // perfectly fine in English, and is simply never translated. So anything the
  // scanner finds outside a data-i18n element fails the build.
  //
  // <title> is the one place text is left in: it holds the product name, which
  // is never translated, and an empty title is what the tab shows before the
  // scripts run. It carries data-i18n like everything else, so it is exempt by
  // the same rule rather than by a special case.
  {
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr']);
    // What the markup is allowed to hold on its own. Nothing in here is a word
    // in any language: em dash placeholders standing in for a value that has
    // not loaded yet, the separators between chips, and bare digits -- a
    // number reads the same in Vietnamese as in English, and failing the build
    // over one would only teach people to wrap it in a key that translates to
    // itself. The moment a letter appears the text is translatable again and
    // this stops covering it.
    const ORNAMENT = /^[\s\d—–·…×\/:,.()%+-]*$/;

    // Found rather than listed: a page added to the extension is a page that
    // has to obey this, and a list written here would simply not know about it.
    const pages = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p); }
        else if (e.name.endsWith('.html')) pages.push(p);
      }
    })(path.join(ROOT, 'src'));

    for (const file of pages) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const src = fs.readFileSync(file, 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!doctype[^>]*>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ');

      const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
      const offenders = [];
      let at = 0, m, depth = 0, translatedAt = 0;
      const consider = (text) => {
        if (translatedAt || ORNAMENT.test(text)) return;
        offenders.push(text.trim().slice(0, 40));
      };
      while ((m = TAG.exec(src))) {
        consider(src.slice(at, m.index));
        at = m.index + m[0].length;
        const closing = !!m[1], name = m[2].toLowerCase();
        const selfClosing = /\/\s*$/.test(m[3]) || VOID.has(name);
        if (selfClosing) continue;
        if (closing) {
          depth--;
          if (translatedAt && depth < translatedAt) translatedAt = 0;
        } else {
          depth++;
          // An element that declares its OWN language is deliberately not in
          // the page's language and must not be translated: a language picker
          // lists each language as its own speakers write it, which is the one
          // place "English" and "Tiếng Việt" are correct in every locale.
          // `lang` is the honest marker for that rather than a bespoke opt-out
          // attribute -- it is exactly what the attribute already means, and a
          // screen reader reads it the same way.
          if (!translatedAt && (/\bdata-i18n=/.test(m[3]) || /\slang="/.test(m[3]))) {
            translatedAt = depth;
          }
        }
      }
      consider(src.slice(at));

      // Text in an attribute is still text: a tooltip, the grey prompt in an
      // empty box, the words a screen reader says instead of an icon. The
      // pages carry data-i18n-title, data-i18n-placeholder and data-i18n-label
      // for exactly those, so a literal one is a string that can never be
      // translated -- and it hides better than a bare text node does, because
      // it looks perfectly right in English and never appears in a screenshot.
      //
      // The leading space is what keeps data-i18n-title="..." out of this: the
      // character before that `title` is a hyphen, not whitespace.
      for (const m of src.matchAll(/\s(title|placeholder|alt|aria-label)="([^"]*)"/g)) {
        if (ORNAMENT.test(m[2])) continue;
        offenders.push(m[1] + '=' + m[2].slice(0, 30));
      }

      report(offenders.length === 0,
        rel + ' has no user-visible text outside data-i18n',
        offenders.join(' | '));
    }
  }
}

console.log('\n' + (failures ? `${failures} problem(s)` : 'all checks passed'));
process.exitCode = failures ? 1 : 0;
