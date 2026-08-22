/**
 * Read-only: map the structure of a Threads post so the report button can be
 * placed in its action bar, and so a report can carry the post's identity.
 *
 *   node tools/probe-thread-actions.js [url]
 *
 * Reports, per post: the action-bar controls and their labels, the permalink,
 * the author link, and where the post text lives.
 */
const CDP_PORT = 9333;
const URL_ARG = process.argv[2] || 'https://www.threads.com/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();
    this.ready=new Promise(r=>this.ws.addEventListener('open',r));
    this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
      if(m.id&&this.p.has(m.id)){const q=this.p.get(m.id);this.p.delete(m.id);
        m.error?q.rej(new Error(m.error.message)):q.res(m.result);}});}
  send(me,pa,s){const i=++this.id;const o={id:i,method:me,params:pa||{}};if(s)o.sessionId=s;
    return new Promise((res,rej)=>{this.p.set(i,{res,rej});this.ws.send(JSON.stringify(o));
      setTimeout(()=>{if(this.p.has(i)){this.p.delete(i);rej(new Error('t/o '+me))}},45000)})}
}

const PROBE = `(function(){
  var out = { url: location.href.slice(0, 90), posts: [] };
  var containers = document.querySelectorAll('[data-pressable-container="true"], [data-pressable-container]');
  out.containerCount = containers.length;

  for (var i = 0; i < containers.length && out.posts.length < 3; i++) {
    var c = containers[i];
    var r = c.getBoundingClientRect();
    if (r.height < 60) continue;

    // Action-bar controls: svg[aria-label] is how Threads labels its icons.
    var actions = [];
    var svgs = c.querySelectorAll('svg[aria-label]');
    for (var j = 0; j < svgs.length; j++) {
      var lb = svgs[j].getAttribute('aria-label');
      var btn = svgs[j].closest('[role="button"],button,div[tabindex]');
      var b = (btn || svgs[j]).getBoundingClientRect();
      actions.push({
        label: lb,
        tag: btn ? btn.tagName.toLowerCase() : 'svg',
        role: btn ? (btn.getAttribute('role') || '') : '',
        x: Math.round(b.x), y: Math.round(b.y),
        w: Math.round(b.width), h: Math.round(b.height),
        parentTag: btn && btn.parentElement ? btn.parentElement.tagName.toLowerCase() : null,
        siblings: btn && btn.parentElement ? btn.parentElement.children.length : 0
      });
    }

    // Permalink: Threads post URLs look like /@user/post/<shortcode>.
    var permalink = null, author = null;
    var as = c.querySelectorAll('a[href]');
    for (var k = 0; k < as.length; k++) {
      var h = as[k].getAttribute('href') || '';
      if (!permalink && /\\/@[^/]+\\/post\\//.test(h)) permalink = h;
      if (!author && /^\\/@[^/]+$/.test(h)) author = h;
    }

    // Post text: the largest text block that is not the author name.
    var textNodes = [];
    var spans = c.querySelectorAll('span[dir="auto"], div[dir="auto"]');
    for (var m2 = 0; m2 < spans.length; m2++) {
      var t = (spans[m2].innerText || '').trim();
      if (t.length > 12) textNodes.push(t.slice(0, 160));
    }
    textNodes.sort(function(a, b){ return b.length - a.length; });

    out.posts.push({
      height: Math.round(r.height),
      permalink: permalink,
      author: author,
      actions: actions,
      textSample: textNodes[0] || null,
      textCandidates: textNodes.length
    });
  }
  return JSON.stringify(out, null, 1);
})()`;

(async () => {
  const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
  const c = new CDP(v.webSocketDebuggerUrl); await c.ready;
  const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /threads\.(com|net)/.test(t.url));
  if (!page) { console.error('open a Threads tab first'); process.exit(1); }
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Page.navigate', { url: URL_ARG }, sessionId);
  await sleep(12000);

  const r = await c.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId);
  if (r.exceptionDetails) console.log('EXC ' + r.exceptionDetails.text);
  console.log(r.result && r.result.value);
  setTimeout(() => process.exit(0), 150);
})().catch(e => { console.error(e.message); process.exit(1); });
