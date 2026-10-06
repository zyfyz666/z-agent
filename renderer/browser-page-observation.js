/* Read-only page observations shared by the browser bridge and its DOM tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZBrowserPageObservation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // This function is serialized into the guest page. Keep all browser-side
  // dependencies inside it so it also works in isolated Electron webviews.
  function observe(mode, options) {
    const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const integer = (value, fallback, min, max) => Number.isFinite(Number(value))
      ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
    const password = element => element.tagName === 'INPUT' && String(element.type).toLowerCase() === 'password';
    const enabled = element => !element.disabled && !element.matches?.(':disabled') && element.getAttribute('aria-disabled') !== 'true';
    const editable = element => enabled(element) && !element.readOnly && element.getAttribute('aria-readonly') !== 'true'
      && (element.isContentEditable || element.tagName === 'TEXTAREA'
        || (element.tagName === 'INPUT' && !['hidden','button','submit','reset','checkbox','radio','range','file','image','color'].includes(String(element.type).toLowerCase())));
    const styles = new WeakMap();
    const styleFor = element => {
      if (!styles.has(element)) styles.set(element, element.ownerDocument.defaultView.getComputedStyle(element));
      return styles.get(element);
    };
    const parentOf = element => element.parentElement || element.getRootNode?.()?.host || null;
    const styleVisible = element => {
      const style = styleFor(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) !== 0;
    };
    const visible = element => {
      if (!element?.isConnected) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      let current = element;
      while (current) {
        if (!styleVisible(current)) return false;
        const parent = parentOf(current);
        if (parent) current = parent;
        else {
          const view = current.ownerDocument.defaultView;
          current = view && view !== window ? view.frameElement : null;
        }
      }
      return true;
    };
    const topRect = element => {
      const rect = element.getBoundingClientRect();
      let x = rect.left, y = rect.top;
      let view = element.ownerDocument.defaultView;
      while (view && view !== window) {
        const frame = view.frameElement;
        if (!frame) break;
        const outer = frame.getBoundingClientRect();
        x += outer.left + frame.clientLeft;
        y += outer.top + frame.clientTop;
        view = frame.ownerDocument.defaultView;
      }
      return { x, y, width: rect.width, height: rect.height };
    };
    const inViewport = element => {
      let target = element;
      while (target) {
        const view = target.ownerDocument.defaultView;
        const rect = target.getBoundingClientRect();
        let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
        let right = Math.min(view.innerWidth, rect.right), bottom = Math.min(view.innerHeight, rect.bottom);
        for (let ancestor = parentOf(target); ancestor; ancestor = parentOf(ancestor)) {
          const style = styleFor(ancestor), clip = ancestor.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
        }
        if (right <= left || bottom <= top) return false;
        target = view && view !== window ? view.frameElement : null;
      }
      return true;
    };
    const labelFor = element => {
      const direct = clean(element.getAttribute('aria-label'));
      if (direct) return direct;
      const ids = clean(element.getAttribute('aria-labelledby'));
      if (ids) {
        const root = element.getRootNode();
        const value = ids.split(/\s+/).map(id => (root.getElementById?.(id) || element.ownerDocument.getElementById(id))?.textContent || '').join(' ');
        if (clean(value)) return clean(value);
      }
      const labels = Array.from(element.labels || []);
      if (labels.length && clean(labels.map(label => label.innerText).join(' '))) return clean(labels.map(label => label.innerText).join(' '));
      const parentLabel = element.closest('label');
      if (parentLabel && clean(parentLabel.innerText)) return clean(parentLabel.innerText);
      return clean(element.getAttribute('placeholder')) || clean(element.getAttribute('title'))
        || clean(element.getAttribute('alt')) || clean(element.innerText)
        || (password(element) ? '' : clean(element.value)) || clean(element.getAttribute('name'));
    };
    const roleFor = element => {
      const explicit = clean(element.getAttribute('role'));
      if (explicit) return explicit.split(' ')[0].toLowerCase();
      const tag = element.tagName.toLowerCase();
      if (tag === 'a' && element.hasAttribute('href')) return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'textarea' || element.isContentEditable) return 'textbox';
      if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'p') return 'paragraph';
      if (tag === 'li') return 'listitem';
      if (tag === 'img') return 'img';
      if (tag === 'table') return 'table';
      if (tag === 'td') return 'cell';
      if (tag === 'th') return 'columnheader';
      if (tag === 'input') {
        const type = String(element.type || 'text').toLowerCase();
        if (['checkbox', 'radio'].includes(type)) return type;
        if (type === 'range') return 'slider';
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
        return 'textbox';
      }
      return 'generic';
    };
    const stateFor = element => {
      const state = {};
      if (!enabled(element)) state.disabled = true;
      if (element.checked || element.getAttribute('aria-checked') === 'true') state.checked = true;
      if (element.selected || element.getAttribute('aria-selected') === 'true') state.selected = true;
      if (element.required || element.getAttribute('aria-required') === 'true') state.required = true;
      if (element.readOnly || element.getAttribute('aria-readonly') === 'true') state.readonly = true;
      for (const attribute of ['expanded', 'pressed']) {
        const value = element.getAttribute(`aria-${attribute}`);
        if (value === 'true' || value === 'false') state[attribute] = value === 'true';
      }
      if ('value' in element && element.value !== '') {
        if (password(element)) state.hasValue = true;
        else state.value = String(element.value).slice(0, 240);
      }
      return state;
    };
    const inaccessibleFrames = [], framesRead = [], frameRecords = new WeakMap();
    const frameDocument = frame => {
      if (frameRecords.has(frame)) return frameRecords.get(frame);
      const details = { title: clean(frame.title).slice(0, 180), url: String(frame.src || 'about:blank').slice(0, 1000), name: clean(frame.name).slice(0, 120) };
      let doc = null, reason = '';
      try {
        doc = frame.contentDocument;
        if (!doc) {
          // Accessing location distinguishes a cross-origin frame from one
          // whose document has not loaded yet; no cross-origin DOM is read.
          void frame.contentWindow?.location.href;
          reason = 'not-ready';
        }
      } catch { reason = 'cross-origin'; }
      if (!doc) inaccessibleFrames.push({ ...details, reason: reason || 'unavailable' });
      else framesRead.push({ ...details, url: doc.URL || details.url });
      frameRecords.set(frame, doc);
      return doc;
    };

    function pageText(start) {
      const chunks = [], stack = [{ node: start, pre: false }];
      const blockTags = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DD','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TR','UL']);
      while (stack.length) {
        const entry = stack.pop();
        if (entry.separator) { chunks.push(entry.separator); continue; }
        const node = entry.node;
        if (!node) continue;
        if (node.nodeType === 3) { chunks.push(entry.pre ? node.nodeValue : node.nodeValue.replace(/\s+/g, ' ')); continue; }
        if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) continue;
        if (node.nodeType === 1) {
          if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(node.tagName) || password(node) || !styleVisible(node)) continue;
          if (node.tagName === 'BR') { chunks.push('\n'); continue; }
          if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
            const doc = frameDocument(node);
            if (doc) { chunks.push('\n\n'); stack.push({ separator: '\n\n' }, { node: doc.body || doc.documentElement, pre: false }); }
            continue;
          }
        }
        const block = node.nodeType === 1 && blockTags.has(node.tagName);
        if (block) { chunks.push('\n\n'); stack.push({ separator: '\n\n' }); }
        const pre = entry.pre || node.tagName === 'PRE';
        let children = node.shadowRoot ? Array.from(node.shadowRoot.childNodes) : Array.from(node.childNodes || []);
        if (node.tagName === 'SLOT') {
          const assigned = node.assignedNodes?.({ flatten: true });
          if (assigned?.length) children = assigned;
        }
        for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], pre });
      }
      return chunks.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    const common = () => ({ url: location.href, title: document.title || '', inaccessibleFrames, framesRead });
    if (mode === 'readPage') {
      let target = document.body || document.documentElement;
      if (options.ref) {
        if (options.snapshotId && options.snapshotId !== window.__zBrowserSnapshotId) return { ok: false, code: 'STALE_REF', error: '页面引用已更新，请重新获取快照。' };
        target = window.__zBrowserRefs?.get(String(options.ref));
        if (!target?.isConnected || !visible(target)) return { ok: false, code: 'STALE_REF', error: '目标引用已失效，请重新获取快照。' };
        let view = target.ownerDocument.defaultView;
        while (view && view !== window) {
          if (!view.frameElement || view.frameElement.contentDocument !== view.document) return { ok: false, code: 'STALE_REF', error: '目标框架已变化，请重新获取快照。' };
          view = view.frameElement.ownerDocument.defaultView;
        }
      }
      const fullText = pageText(target);
      const offset = integer(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(options.limit, 16000, 1, 16000);
      const text = fullText.slice(offset, offset + limit);
      const hasMore = offset + text.length < fullText.length;
      return { ok: true, ...common(), ref: options.ref || undefined, text, totalChars: fullText.length, offset, limit,
        nextOffset: hasMore ? offset + text.length : null, hasMore, truncated: offset > 0 || hasMore };
    }

    const interactiveSelector = ['a[href]','button','input:not([type="hidden"])','textarea','select','summary',
      '[contenteditable="true"]','[role="button"]','[role="link"]','[role="textbox"]','[role="checkbox"]',
      '[role="radio"]','[role="switch"]','[role="tab"]','[role="menuitem"]','[role="option"]','[role="combobox"]',
      '[role="slider"]','[tabindex]:not([tabindex="-1"])'].join(',');
    const query = clean(options.query), requestedText = clean(options.text);
    const label = clean(options.label), requestedName = clean(options.name);
    const role = clean(options.role).toLowerCase();
    const textMatches = (actual, expected) => !expected || (options.exact === true
      ? actual === expected : actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase()));
    const visibleTextFor = element => password(element) ? '' : clean(element.innerText);
    const matchesFilters = (name, itemRole, visibleText) => (!role || itemRole === role)
      && (!query || textMatches(name, query) || textMatches(visibleText, query))
      && textMatches(visibleText, requestedText) && textMatches(name, label) && textMatches(name, requestedName);
    if (mode === 'waitCondition' && options.ref) {
      if (options.snapshotId && options.snapshotId !== window.__zBrowserSnapshotId) return { matched: false, count: 0, reason: 'stale-ref', code: 'STALE_REF' };
      const target = window.__zBrowserRefs?.get(String(options.ref));
      if (!target) return { matched: false, count: 0, reason: 'stale-ref', code: 'STALE_REF' };
      const attached = target.isConnected, displayed = attached && visible(target);
      const contentMatches = matchesFilters(labelFor(target), roleFor(target), visibleTextFor(target));
      const state = options.state || 'visible';
      const stateMatches = state === 'detached' ? !attached : state === 'hidden' ? !displayed : state === 'attached' ? attached
        : state === 'enabled' ? displayed && enabled(target) : state === 'editable' ? displayed && editable(target) : displayed;
      return { matched: contentMatches && stateMatches, count: attached && contentMatches ? 1 : 0, reason: contentMatches ? state : 'text-mismatch' };
    }
    const roots = [document], seenRoots = new Set(), seen = new Set(), matches = [];
    let candidateCount = 0;
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index];
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if ((element.tagName === 'IFRAME' || element.tagName === 'FRAME') && visible(element)) roots.push(frameDocument(element));
        if (seen.has(element)) continue;
        const interactive = element.matches(interactiveSelector);
        const semantic = (mode === 'find' || mode === 'waitCondition') && !['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(element.tagName)
          && (element.hasAttribute('role') || /^(H[1-6]|P|LABEL|LI|TD|TH|IMG)$/.test(element.tagName)
          || Array.from(element.childNodes).some(node => node.nodeType === 3 && clean(node.nodeValue)));
        if (!interactive && !semantic) continue;
        const displayed = visible(element);
        if (!displayed && mode !== 'waitCondition') continue;
        seen.add(element); candidateCount++;
        const name = labelFor(element), itemRole = roleFor(element), viewport = inViewport(element);
        if (!matchesFilters(name, itemRole, visibleTextFor(element))) continue;
        if (options.viewportOnly === true && !viewport) continue;
        matches.push({ element, name, role: itemRole, inViewport: viewport, visible: displayed });
      }
    }
    if (mode === 'waitCondition') {
      const state = options.state || 'visible';
      // A phrase may span adjacent inline nodes without any one semantic
      // element owning it. Text-only visibility waits may inspect the rendered
      // page text; role/name/label waits still require a matching element.
      if (requestedText && !query && !role && !label && !requestedName && !options.exact && ['visible', 'hidden'].includes(state)) {
        const found = textMatches(clean(pageText(document.body || document.documentElement)), requestedText);
        return { matched: state === 'hidden' ? !found : found, count: found ? Math.max(1, matches.length) : 0,
          visibleCount: found ? Math.max(1, matches.filter(item => item.visible).length) : 0, reason: state, inaccessibleFrames };
      }
      const count = matches.length, visibleCount = matches.filter(item => item.visible).length;
      const matched = state === 'detached' ? count === 0 : state === 'hidden' ? visibleCount === 0 : state === 'attached' ? count > 0
        : state === 'enabled' ? matches.some(item => item.visible && enabled(item.element))
          : state === 'editable' ? matches.some(item => item.visible && editable(item.element)) : visibleCount > 0;
      return { matched, count, visibleCount, reason: state, inaccessibleFrames };
    }
    // Traverse everything before paginating so controls below a long list are
    // discoverable after scrolling or through a targeted query.
    if (options.viewportFirst !== false) matches.sort((a, b) => Number(b.inViewport) - Number(a.inViewport));
    const offset = integer(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(options.limit, mode === 'find' ? 60 : 180, 1, 500);
    const startRef = integer(options.startRef, window.__zBrowserNextRef || 1, 1, 1_000_000_000);
    const refs = new Map();
    const items = matches.slice(offset, offset + limit).map((match, index) => {
      const element = match.element, rect = topRect(element), ref = `e${startRef + index}`;
      refs.set(ref, element);
      return { ref, role: match.role, tag: element.tagName.toLowerCase(), type: clean(element.getAttribute('type')).toLowerCase(),
        name: match.name.slice(0, 220), state: stateFor(element), inViewport: match.inViewport,
        rect: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), width: Math.round(rect.width), height: Math.round(rect.height) } };
    });
    window.__zBrowserRefs = refs;
    window.__zBrowserNextRef = startRef + items.length;
    window.__zBrowserSnapshotId = String(options.snapshotId || `observation-${Date.now()}-${startRef}`);
    const body = pageText(document.body || document.documentElement);
    const hasMore = offset + items.length < matches.length;
    return { ok: true, ...common(), readyState: document.readyState, snapshotId: window.__zBrowserSnapshotId,
      viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
      items, total: matches.length, totalMatches: matches.length, candidateCount, offset, limit, hasMore,
      nextOffset: hasMore ? offset + items.length : null, nextRef: window.__zBrowserNextRef,
      bodyText: body.slice(0, 3200), bodyTextTruncated: body.length > 3200, truncated: offset > 0 || hasMore };
  }

  const script = (mode, options = {}) => `(${observe.toString()})(${JSON.stringify(mode)},${JSON.stringify(options || {})})`;
  return Object.freeze({
    snapshot: options => script('snapshot', options),
    readPage: options => script('readPage', options),
    find: options => script('find', options),
    waitCondition: options => script('waitCondition', options),
    MAX_SNAPSHOT_ITEMS: 500,
    MAX_TEXT_LENGTH: 16000
  });
});
