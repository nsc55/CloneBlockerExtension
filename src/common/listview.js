/**
 * Search, sort and paging for a long list, in about a page of code.
 *
 * The activity page has two lists that grow without limit -- the queue, and
 * the history of every attempt -- and both used to be drawn with a hard cap
 * and a "… and 43 more" line, which is a way of admitting the page cannot show
 * you what it holds. This is the smallest thing that fixes both, and it is one
 * thing rather than two so the second list cannot drift from the first.
 *
 * It renders its own controls and its own pager and knows nothing else: what a
 * row IS, how to draw it, and what its words are stay with the caller. That is
 * what lets the same object serve a queue of pending targets and a log of past
 * attempts without either of them explaining itself to it.
 *
 * Not shared with the moderation dashboard, which has the same controls and a
 * near-identical model: that page is served from Firebase Hosting and this one
 * ships inside the extension, so they cannot import each other. Worth saying
 * out loud, because the two look like an obvious de-duplication and are not.
 */
(function () {
  'use strict';

  const T = (k, ...a) => (globalThis.CB_T ? globalThis.CB_T(k, ...a) : k);

  /**
   * @param opts.sorts     [{ key, label, cmp }] -- cmp compares ASCENDING
   * @param opts.text      (item) -> the string a search matches against
   * @param opts.pageSize  rows per page
   * @param opts.onChange  called when the view moved; the caller re-renders
   */
  function createListView(opts) {
    const sorts = (opts.sorts || []).slice();
    const view = {
      q: '',
      sort: sorts.length ? sorts[0].key : '',
      dir: opts.dir === 'asc' ? 'asc' : 'desc',
      page: 1,
      pageSize: opts.pageSize || 25
    };
    let controlsHost = null, pagerHost = null, lastTotal = 0;
    const changed = () => { if (opts.onChange) opts.onChange(); };

    const terms = () => view.q.trim().toLowerCase().split(/\s+/).filter(Boolean);

    /** Every term must match, so a second word narrows rather than widens. */
    function matches(item) {
      const t = terms();
      if (!t.length) return true;
      const hay = String(opts.text ? opts.text(item) : '').toLowerCase();
      return t.every(x => hay.includes(x));
    }

    function compare(a, b) {
      const s = sorts.find(x => x.key === view.sort) || sorts[0];
      if (!s) return 0;
      return (view.dir === 'asc' ? 1 : -1) * s.cmp(a, b);
    }

    const pages = (n) => Math.max(1, Math.ceil(n / view.pageSize));

    /**
     * Narrow, order and cut. Returns the slice to draw plus the numbers the
     * caller needs to say where the reader is.
     */
    function apply(items) {
      const all = (items || []).filter(matches);
      const sorted = all.slice().sort(compare);
      const total = sorted.length;
      if (view.page > pages(total)) view.page = pages(total);
      const start = (view.page - 1) * view.pageSize;
      lastTotal = total;
      return {
        rows: sorted.slice(start, start + view.pageSize),
        total,
        unfiltered: (items || []).length,
        start,
        pages: pages(total)
      };
    }

    // -- controls ------------------------------------------------------------
    function mountControls(host) {
      controlsHost = host;
      host.textContent = '';
      host.classList.add('listctl');

      const box = document.createElement('div');
      box.className = 'listsearch';
      const input = document.createElement('input');
      input.type = 'search';
      input.placeholder = T('list_searchPlaceholder');
      input.value = view.q;
      input.autocomplete = 'off';
      // Debounced: a queue of forty re-sorts instantly and one of four
      // thousand does not.
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { view.q = input.value; view.page = 1; changed(); }, 140);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { input.value = ''; view.q = ''; view.page = 1; changed(); }
      });
      box.appendChild(input);
      host.appendChild(box);

      if (sorts.length > 1) {
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', T('list_sortBy'));
        for (const s of sorts) {
          const o = document.createElement('option');
          o.value = s.key;
          o.textContent = s.label();
          sel.appendChild(o);
        }
        sel.value = view.sort;
        sel.addEventListener('change', () => { view.sort = sel.value; view.page = 1; changed(); });
        host.appendChild(sel);
      }

      const dir = document.createElement('button');
      dir.type = 'button';
      dir.className = 'chipbtn dir';
      dir.textContent = view.dir === 'asc' ? '↑' : '↓';
      dir.title = T('list_reverse');
      dir.addEventListener('click', () => {
        view.dir = view.dir === 'asc' ? 'desc' : 'asc';
        view.page = 1;
        changed();
      });
      host.appendChild(dir);

      const count = document.createElement('span');
      count.className = 'note listcount';
      host.appendChild(count);
    }

    /** The "showing 11–20 of 34" line, written where mountControls put it. */
    function renderCount(res) {
      if (!controlsHost) return;
      const node = controlsHost.querySelector('.listcount');
      if (!node) return;
      node.textContent = res.total
        ? T('list_showing', res.start + 1, res.start + res.rows.length, res.total)
        : (res.unfiltered ? T('list_noMatch', res.unfiltered) : '');
    }

    function mountPager(host) {
      pagerHost = host;
      host.classList.add('listpager');
    }

    function renderPager(res) {
      if (!pagerHost) return;
      pagerHost.textContent = '';
      // Nothing to page through: a pager reading "1 of 1" with every control
      // greyed out is furniture.
      pagerHost.classList.toggle('hidden', res.pages <= 1);
      if (res.pages <= 1) return;
      const step = (label, to, disabled, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chipbtn';
        b.textContent = label;
        b.title = title || '';
        b.disabled = disabled;
        b.addEventListener('click', () => {
          view.page = Math.min(Math.max(1, to), res.pages);
          changed();
        });
        pagerHost.appendChild(b);
      };
      step('«', 1, view.page <= 1, T('list_first'));
      step('‹', view.page - 1, view.page <= 1, T('list_prev'));
      const where = document.createElement('span');
      where.className = 'note';
      where.textContent = T('list_page', view.page, res.pages);
      pagerHost.appendChild(where);
      step('›', view.page + 1, view.page >= res.pages, T('list_next'));
      step('»', res.pages, view.page >= res.pages, T('list_last'));
    }

    /** Draw the slice, and everything that describes it. */
    function render(items, drawRow, host) {
      const res = apply(items);
      host.textContent = '';
      for (const item of res.rows) {
        const node = drawRow(item);
        if (node) host.appendChild(node);
      }
      renderCount(res);
      renderPager(res);
      return res;
    }

    return {
      view,
      apply,
      render,
      mountControls,
      mountPager,
      reset() { view.q = ''; view.page = 1; },
      get total() { return lastTotal; }
    };
  }

  globalThis.CB_LIST_VIEW = createListView;
})();
