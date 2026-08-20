'use strict';

/*
 * Agri360 Client Portal - Focus points approval page
 * --------------------------------------------------
 * The client-facing view behind /focus-points/:portalToken/:deliverableId.
 * One content calendar, its month plan, and one Approve button.
 *
 * WHY THIS IS ITS OWN FILE AND NOT A FUNCTION IN app.js.
 * public/app.js is a single IIFE. Nothing inside it is reachable from outside,
 * so a renderer living here cannot call el(), api(), formatDate() or any of the
 * other helpers it needs. Rather than duplicate them (two el() implementations
 * drift, and the one that drifts is the one nobody reads), the caller passes a
 * helper bag. app.js keeps ownership of fetching, routing and live sync, this
 * file owns the pixels and the per-field saves.
 *
 * THE CONTRACT, which app.js codes against:
 *
 *   window.CPFocusPoints.render(ctx, data) -> HTMLElement
 *
 *   ctx REQUIRED:
 *     el(tag, attrs, children)  the app.js DOM helper, same signature
 *     api(method, path, body)   -> Promise<{ status, ok, data }>
 *     portalToken               the opaque clients.portal_token from the URL
 *     deliverableId             the calendar id from the URL
 *   ctx OPTIONAL, each with an internal fallback so a partial bag still works:
 *     formatDate(v)             -> display string
 *     formatMonth(v)            -> "August 2026"
 *     metaOf(d)                 -> the parsed metadata object
 *     onApproved(row)           called once after a successful approve
 *     afterRenderRestore()      called at the tail of the first mount
 *     tagItem(node, d)          live-sync item tagging
 *
 *   data is the row from GET /public/portal/:portalToken/focus-points/:id,
 *   camelCased by the CRM. It is also accepted wrapped as { deliverable } or
 *   { item }, because that handler copies the collateral preview shape and a
 *   wrapper there would otherwise silently render an empty page.
 *
 * MOBILE FIRST, ON PURPOSE. A client opens this from a WhatsApp link on a phone.
 * Three columns of number, date and description at 390px leave the description
 * about 200px wide, and the description is where the client's own words go. So
 * the table is a stack of cards, the desktop layout is the wide variant of the
 * stack rather than the other way round, and the approve button lives in a
 * sticky bar that is reachable from the first paint instead of after ten rows.
 *
 * WHY THE DESCRIPTION IS TEXT UNTIL TAPPED. Ten mounted rich editors on a
 * mid-range Android is slow to interactive, and ten toolbars make a list to read
 * look like a form to fill in. Reading is the dominant action here, so a row
 * becomes editable one at a time. The field's save-on-blur contract already
 * implied this: nothing is lost by mounting late.
 *
 * WHY THE DATE IS A NATIVE <input type="date">. A hand-rolled calendar popup on
 * a client's phone is the single most likely thing on this page to break, and
 * the one we cannot test on every device they own. The native picker is both
 * familiar and somebody else's problem.
 *
 * SAVE SEMANTICS ARE COPIED FROM THE SHIPPED CARD (app.js:1475-1567), field for
 * field: save on blur, only when the value actually changed, "Saving...", then
 * "Saved", and on any failure the field is put back to its previous value with
 * "Could not save, reverted." A client who does not get their text back after a
 * failed save types it again into a page they no longer trust.
 *
 * AND IT MUST NOT BE STOMPED BY THE LIVE-SYNC POLL. app.js re-renders the view
 * whenever the server's dataVersion changes, guarded by isRefreshBlocked()
 * (app.js:206-219). That guard already covers a focused contenteditable and any
 * node carrying data-cc-dirty="1". A save that is in flight is neither, so the
 * root carries data-cc-dirty="1" for as long as an editor is mounted or a
 * request is outstanding, which is exactly the window in which a re-render would
 * throw away a change the client has already made.
 *
 * Side-effect free on load: this file defines functions and exposes one object.
 * No fetch, no DOM read or write, no timer, until render() is called.
 */

(function () {
  // -- endpoints ----------------------------------------------------
  // Same-origin portal proxy paths. The proxy injects X-Portal-Key server side,
  // so the browser never holds a key, and every body repeats portalToken because
  // the CRM re-scopes the deliverable to that client (IDOR gate) rather than
  // trusting the id in the body.
  var EP_DESCRIPTION = '/api/request-forms/public/portal/focus-points/description';
  var EP_DATE = '/api/request-forms/public/portal/focus-points/date';
  var EP_APPROVE = '/api/request-forms/public/portal/focus-points/approve';

  var MSG_SAVING = 'Saving...';
  var MSG_SAVED = 'Saved';
  var MSG_FAILED = 'Could not save, reverted.';
  var MSG_DATE_REQUIRED = 'A date is needed, the old one is back.';

  // -- fallbacks for an incomplete helper bag -----------------------
  // Each mirrors the app.js original closely enough that the page looks the same
  // whether or not the caller passed it.
  function fbFormatDate(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function fbFormatMonth(v) {
    if (!v) return '';
    var m = String(v).match(/^(\d{4})-(\d{2})/);
    if (m) {
      var dt = new Date(Number(m[1]), Number(m[2]) - 1, 1);
      if (!isNaN(dt.getTime())) return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    }
    return String(v);
  }

  function fbMetaOf(d) {
    var meta = (d && (d.metadata || d.meta)) || {};
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = {}; } }
    return meta && typeof meta === 'object' ? meta : {};
  }

  // -- html handling ------------------------------------------------
  // A description arrives as HTML, because the backfill copies it out of the
  // post's captionHtml which the staff card writes with a rich editor.
  //
  // Both helpers below parse into an INERT document (DOMParser), never into a
  // detached div. Setting innerHTML on a detached div still runs an <img onerror>
  // in every browser that matters, and this string round trips through a client
  // device we do not control.
  function inertBody(html) {
    try {
      var doc = new DOMParser().parseFromString('<body>' + String(html == null ? '' : html) + '</body>', 'text/html');
      return doc && doc.body ? doc.body : null;
    } catch (e) {
      return null;
    }
  }

  // Read state: the description as plain text, whitespace collapsed. Matches
  // plainText() in app.js in output, not in mechanism.
  function toPlainText(html) {
    var body = inertBody(html);
    if (!body) return String(html == null ? '' : html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return (body.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Edit state: the description with its formatting, minus anything that can
  // execute. Not a general purpose sanitiser and not a security boundary on its
  // own, the CRM is the trust boundary. It exists so that one bad legacy row
  // cannot run script inside a client's browser on the one page in this app that
  // has no login at all.
  var DROP_TAGS = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1, FORM: 1, BASE: 1 };
  function sanitizeHtml(html) {
    var body = inertBody(html);
    if (!body) return '';
    var walk = body.querySelectorAll('*');
    for (var i = walk.length - 1; i >= 0; i--) {
      var node = walk[i];
      if (DROP_TAGS[node.tagName]) {
        if (node.parentNode) node.parentNode.removeChild(node);
        continue;
      }
      var attrs = node.attributes;
      for (var j = attrs.length - 1; j >= 0; j--) {
        var name = attrs[j].name.toLowerCase();
        var value = String(attrs[j].value || '');
        var isUrlAttr = name === 'href' || name === 'src' || name === 'xlink:href';
        if (name.indexOf('on') === 0 || (isUrlAttr && /^\s*javascript:/i.test(value))) {
          node.removeAttribute(attrs[j].name);
        }
      }
    }
    return body.innerHTML;
  }

  // Strict calendar round trip, same rule as the CRM lib (api/lib/focus-points.js)
  // and for the same reason: a regex alone accepts 2026-02-30, and a native date
  // input can hand back a partial value while the client is still typing into it.
  function isIsoDate(value) {
    if (typeof value !== 'string') return false;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    var probe = new Date(Date.UTC(y, mo - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
  }

  // -- focus point normalising, read side ---------------------------
  // The write side lives in the CRM (api/lib/focus-points.js) and owns id, order
  // and number. This is the portal's read-only mirror of the same shape: sort by
  // order, fall back to array position when order is missing, and never invent an
  // id. A row with no id renders read only, because every write on this page
  // addresses a row BY ID and a positional guess would edit somebody else's row
  // the moment staff reorder the month.
  function focusPointsOf(meta) {
    var raw = meta && Array.isArray(meta.focusPoints) ? meta.focusPoints : [];
    var list = [];
    raw.forEach(function (fp, idx) {
      if (!fp || typeof fp !== 'object') return;
      var order = typeof fp.order === 'number' && isFinite(fp.order) ? fp.order : idx;
      var number = typeof fp.number === 'number' && isFinite(fp.number) ? fp.number : null;
      list.push({
        id: fp.id != null && String(fp.id).trim() !== '' ? String(fp.id).trim() : null,
        order: order,
        seq: idx,
        number: number,
        description: fp.description == null ? '' : String(fp.description),
        postDate: isIsoDate(fp.postDate) ? String(fp.postDate) : '',
      });
    });
    list.sort(function (a, b) { return a.order - b.order || a.seq - b.seq; });
    list.forEach(function (fp, idx) { if (fp.number == null) fp.number = idx + 1; });
    return list;
  }

  // -- row unwrapping -----------------------------------------------
  function rowOf(data) {
    if (!data || typeof data !== 'object') return {};
    if (data.deliverable && typeof data.deliverable === 'object') return data.deliverable;
    if (data.item && typeof data.item === 'object') return data.item;
    return data;
  }

  function clientNameOf(row, data) {
    return (data && data.clientName) || row.clientName || row.client_name
      || (row.client && row.client.name) || '';
  }

  function monthOf(row, points) {
    var raw = row.deliveryMonth || row.delivery_month || row.month || '';
    if (raw) return raw;
    // No delivery month on the row: take it from the first dated focus point, so
    // the sticky bar can still name what the client is approving.
    for (var i = 0; i < points.length; i++) {
      if (points[i].postDate) return points[i].postDate.slice(0, 7);
    }
    return '';
  }

  // Approved rows must still render, that is the whole point of the receipt
  // state: a client reopening the link from their WhatsApp history has to land
  // somewhere that says it is done, not on a button that 409s.
  function approvedStampOf(meta) {
    return meta.focusPointsReceivedAt || meta.focusPointsApprovedAt || null;
  }

  function isEditable(row, meta) {
    if (approvedStampOf(meta)) return false;
    if (meta.portalState === 'focus_points_approved') return false;
    // Legacy rows carry the awaiting flag in metadata rather than in the status,
    // which is how the approvals listing finds them today (request-forms.js:918),
    // so either signal opens the page for editing.
    return row.status === 'focus_points_sent' || meta.portalState === 'focus_points_sent';
  }

  // -- the one confirm sheet ----------------------------------------
  // Bottom anchored, backdrop and Esc dismiss, body scroll locked while open,
  // focus moved in and returned to the trigger on close, confirm button last.
  // The sticky bar sits exactly where a one-handed thumb rests while scrolling,
  // and approving cannot be undone by the client, so the bar's cost is this
  // sheet. Local to this file rather than shared: the portal has no sheet
  // component and the CRM's window.ddSheet is in the other repo.
  function openConfirmSheet(opts) {
    var trigger = opts.trigger || null;
    var host = document.createElement('div');
    host.className = 'cp-fp-sheet-host';

    var backdrop = document.createElement('div');
    backdrop.className = 'cp-fp-sheet-backdrop';

    var sheet = document.createElement('div');
    sheet.className = 'cp-fp-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', opts.title || 'Confirm');

    var grab = document.createElement('div');
    grab.className = 'cp-fp-sheet-grab';
    sheet.appendChild(grab);

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cp-fp-sheet-x';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    sheet.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'cp-fp-sheet-body';
    var heading = document.createElement('h2');
    heading.className = 'cp-fp-sheet-title';
    heading.textContent = opts.title || '';
    body.appendChild(heading);
    (opts.lines || []).forEach(function (line) {
      var p = document.createElement('p');
      p.className = 'cp-fp-sheet-line';
      p.textContent = line;
      body.appendChild(p);
    });
    sheet.appendChild(body);

    var actions = document.createElement('div');
    actions.className = 'cp-fp-sheet-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cp-btn cp-fp-sheet-cancel';
    cancel.textContent = opts.cancelLabel || 'Not yet';
    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'cp-btn cp-btn-approve cp-fp-sheet-go';
    go.textContent = opts.confirmLabel || 'Confirm';
    // Confirm is LAST, never first. The button that cannot be undone does not sit
    // where the thumb already is when the sheet slides up under it.
    actions.appendChild(cancel);
    actions.appendChild(go);
    sheet.appendChild(actions);

    host.appendChild(backdrop);
    host.appendChild(sheet);

    var prevOverflow = document.body.style.overflow;
    var closed = false;

    function close(confirmed) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      if (host.parentNode) host.parentNode.removeChild(host);
      if (trigger && typeof trigger.focus === 'function') {
        try { trigger.focus(); } catch (e) { /* detached, nothing to return to */ }
      }
      if (confirmed && typeof opts.onConfirm === 'function') opts.onConfirm();
    }

    function onKey(e) {
      if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); close(false); return; }
      if (e.key !== 'Tab') return;
      // Two-stop focus trap. There are exactly three focusables in here and the
      // list never grows, so a general trap would be more code than the thing it
      // guards.
      var stops = [closeBtn, cancel, go];
      var idx = stops.indexOf(document.activeElement);
      if (idx === -1) { e.preventDefault(); stops[0].focus(); return; }
      var next = e.shiftKey ? idx - 1 : idx + 1;
      if (next < 0) next = stops.length - 1;
      if (next >= stops.length) next = 0;
      e.preventDefault();
      stops[next].focus();
    }

    backdrop.addEventListener('click', function () { close(false); });
    grab.addEventListener('click', function () { close(false); });
    closeBtn.addEventListener('click', function () { close(false); });
    cancel.addEventListener('click', function () { close(false); });
    go.addEventListener('click', function () { close(true); });
    document.addEventListener('keydown', onKey, true);

    document.body.style.overflow = 'hidden';
    document.body.appendChild(host);
    try { go.focus(); } catch (e) { /* no-op */ }
    return { close: function () { close(false); } };
  }

  // -- the page -----------------------------------------------------
  function render(ctx, data) {
    ctx = ctx || {};
    var el = ctx.el;
    var api = ctx.api;
    var formatDate = typeof ctx.formatDate === 'function' ? ctx.formatDate : fbFormatDate;
    var formatMonth = typeof ctx.formatMonth === 'function' ? ctx.formatMonth : fbFormatMonth;
    var metaOf = typeof ctx.metaOf === 'function' ? ctx.metaOf : fbMetaOf;

    var root = document.createElement('div');
    root.className = 'cp-fp';

    function textNode(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      n.textContent = text == null ? '' : String(text);
      return n;
    }

    if (typeof el !== 'function' || typeof api !== 'function') {
      // A bag this incomplete is a wiring bug, not a client-facing failure mode.
      // Say so on the page rather than throwing out of app.js's router, which
      // would leave the client on a blank screen with no way to report it.
      root.appendChild(textNode('p', 'cp-warn cp-fp-warn', 'This page could not be opened. Please contact ProAgri.'));
      return root;
    }

    var row = rowOf(data);
    var meta = metaOf(row);
    var deliverableId = ctx.deliverableId != null ? ctx.deliverableId : row.id;
    var portalToken = ctx.portalToken;
    var points = focusPointsOf(meta);
    var clientName = clientNameOf(row, data);
    var monthLabel = formatMonth(monthOf(row, points));
    var editable = isEditable(row, meta);
    var approvedAt = approvedStampOf(meta);

    // data-cc-dirty is read by app.js's isRefreshBlocked(). It is set while an
    // editor is open or a save is in flight and cleared when the last one
    // settles, so the 3s poll cannot re-render the page out from under a change
    // the client has already made.
    var pending = 0;
    function markDirty(delta) {
      pending += delta;
      if (pending > 0) root.setAttribute('data-cc-dirty', '1');
      else root.removeAttribute('data-cc-dirty');
    }

    // Rebuilt in place on approval. The caller holds this node, so the receipt
    // has to replace the contents of the same element rather than return a new
    // one, and every listener the old contents held goes with them.
    function mount() {
      while (root.firstChild) root.removeChild(root.firstChild);
      root.appendChild(buildHead());
      if (!points.length) {
        root.appendChild(textNode('p', 'cp-note cp-fp-empty',
          'There are no focus points on this calendar yet. ProAgri will send them through shortly.'));
        return;
      }
      var list = document.createElement('div');
      list.className = 'cp-fp-list';
      points.forEach(function (fp) { list.appendChild(buildCard(fp)); });
      root.appendChild(list);
      // Scroll padding so the last card clears the sticky bar. A client who
      // cannot read their last focus point does not approve it.
      root.appendChild(el('div', { class: 'cp-fp-pad' }, []));
      root.appendChild(editable ? buildBar() : buildReceiptBar());
    }

    function buildHead() {
      var head = document.createElement('div');
      head.className = 'cp-fp-head';
      if (clientName) head.appendChild(textNode('div', 'cp-fp-client', clientName));
      head.appendChild(textNode('h1', 'cp-fp-title',
        monthLabel ? 'Content Calendar · ' + monthLabel : 'Content Calendar'));
      head.appendChild(textNode('div', 'cp-fp-sub', 'Focus points approval'));
      if (editable) {
        head.appendChild(textNode('p', 'cp-note cp-fp-intro',
          'These are the planned posts for the month. Change the text or the date if you want something different. Changes save on their own.'));
      } else {
        head.appendChild(textNode('p', 'cp-note cp-fp-intro', approvedAt
          ? 'You approved these on ' + formatDate(approvedAt) + '. ProAgri is working on the artwork.'
          : 'These focus points have been approved. ProAgri is working on the artwork.'));
      }
      return head;
    }

    function buildCard(fp) {
      var card = document.createElement('section');
      card.className = 'cp-fp-card';
      if (fp.id) card.setAttribute('data-fp-id', fp.id);

      card.appendChild(textNode('div', 'cp-fp-num', String(fp.number)));

      // A row with no id is read only whatever the status says. See focusPointsOf.
      var rowEditable = editable && !!fp.id;

      var descWrap = document.createElement('div');
      descWrap.className = 'cp-fp-descwrap';
      var descFlag = textNode('span', 'cp-cc-saveflag cp-fp-saveflag', '');
      var plain = toPlainText(fp.description);

      var view = textNode('div', 'cp-fp-desc', plain || 'No description yet.');
      if (!plain) view.classList.add('cp-fp-desc-empty');
      descWrap.appendChild(view);

      if (rowEditable) {
        view.setAttribute('role', 'button');
        view.setAttribute('tabindex', '0');
        var hint = textNode('div', 'cp-fp-hint', 'tap to edit');
        descWrap.appendChild(hint);

        var openEditor = function () {
          // Mount the editor for THIS row only, then hand it the caret. Ten
          // mounted editors is the thing this page exists not to do.
          var editor = document.createElement('div');
          editor.className = 'cp-editor cp-fp-editor';
          editor.setAttribute('contenteditable', 'true');
          editor.innerHTML = sanitizeHtml(fp.description);
          var seed = editor.innerHTML;
          markDirty(1);

          var settled = false;
          editor.addEventListener('blur', function () {
            if (settled) return;
            settled = true;
            var html = editor.innerHTML;
            var closeEditor = function (finalHtml) {
              fp.description = finalHtml;
              var text = toPlainText(finalHtml);
              view.textContent = text || 'No description yet.';
              if (text) view.classList.remove('cp-fp-desc-empty');
              else view.classList.add('cp-fp-desc-empty');
              if (editor.parentNode) editor.parentNode.removeChild(editor);
              view.hidden = false;
              hint.hidden = false;
              markDirty(-1);
            };
            if (html === seed) { closeEditor(seed); return; }
            descFlag.textContent = MSG_SAVING;
            markDirty(1);
            api('POST', EP_DESCRIPTION, {
              deliverableId: deliverableId,
              focusPointId: fp.id,
              description: html,
              portalToken: portalToken,
            }).then(function (res) {
              markDirty(-1);
              if (res && res.ok) {
                descFlag.textContent = MSG_SAVED;
                closeEditor(html);
              } else {
                descFlag.textContent = (res && res.data && res.data.error) || MSG_FAILED;
                closeEditor(seed);
              }
            }).catch(function () {
              markDirty(-1);
              descFlag.textContent = MSG_FAILED;
              closeEditor(seed);
            });
          });

          view.hidden = true;
          hint.hidden = true;
          descWrap.insertBefore(editor, descFlag);
          try { editor.focus(); } catch (e) { /* no-op */ }
          // Caret to the end, so a tap to fix a typo does not start by selecting
          // everything the client already wrote.
          try {
            var range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          } catch (e) { /* selection API unavailable, the tap still focused it */ }
        };

        view.addEventListener('click', openEditor);
        view.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); openEditor(); }
        });
      }

      descWrap.appendChild(descFlag);
      card.appendChild(descWrap);

      var dateRow = document.createElement('div');
      dateRow.className = 'cp-fp-daterow';
      dateRow.appendChild(textNode('span', 'cp-fp-datelabel', 'Date'));

      if (rowEditable) {
        var dateFlag = textNode('span', 'cp-cc-saveflag cp-fp-saveflag cp-fp-dateflag', '');
        var input = document.createElement('input');
        input.type = 'date';
        input.className = 'cp-fp-date';
        input.value = fp.postDate || '';
        input.setAttribute('aria-label', 'Post date for focus point ' + fp.number);
        var dateSeed = input.value;
        var saveDate = function () {
          var next = String(input.value || '');
          if (next === dateSeed) return;
          if (!isIsoDate(next)) {
            // The date endpoint takes ISO only and 400s on anything else, so a
            // cleared or half typed value is refused here rather than turned into
            // a server error the client cannot act on.
            input.value = dateSeed;
            dateFlag.textContent = MSG_DATE_REQUIRED;
            return;
          }
          dateFlag.textContent = MSG_SAVING;
          markDirty(1);
          api('POST', EP_DATE, {
            deliverableId: deliverableId,
            focusPointId: fp.id,
            postDate: next,
            portalToken: portalToken,
          }).then(function (res) {
            markDirty(-1);
            if (res && res.ok) {
              dateSeed = next;
              fp.postDate = next;
              dateFlag.textContent = MSG_SAVED;
            } else {
              input.value = dateSeed;
              dateFlag.textContent = (res && res.data && res.data.error) || MSG_FAILED;
            }
          }).catch(function () {
            markDirty(-1);
            input.value = dateSeed;
            dateFlag.textContent = MSG_FAILED;
          });
        };
        // change fires on the native picker's own commit, blur catches a typed
        // value the client walks away from. saveDate no-ops when nothing moved,
        // so both firing costs nothing.
        input.addEventListener('change', saveDate);
        input.addEventListener('blur', saveDate);
        dateRow.appendChild(input);
        dateRow.appendChild(dateFlag);
      } else {
        dateRow.appendChild(textNode('span', 'cp-fp-datestatic',
          fp.postDate ? formatDate(fp.postDate) : 'No date set'));
      }

      card.appendChild(dateRow);
      return card;
    }

    function buildBar() {
      var bar = document.createElement('div');
      bar.className = 'cp-fp-bar';
      var count = points.length;
      var noun = count === 1 ? 'post' : 'posts';
      // Name what the button covers. The client is approving the month, not the
      // card they happen to be looking at.
      bar.appendChild(textNode('div', 'cp-fp-barnote', monthLabel
        ? count + ' ' + noun + ' planned for ' + monthLabel
        : count + ' ' + noun + ' planned'));

      var warn = textNode('div', 'cp-warn cp-fp-warn', '');
      warn.hidden = true;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cp-btn cp-btn-approve cp-btn-block cp-fp-approve';
      btn.textContent = 'Approve focus points';
      btn.addEventListener('click', function () {
        openConfirmSheet({
          trigger: btn,
          title: 'Approve these focus points?',
          lines: [
            'This tells ProAgri the month is approved. You will not be able to change these afterwards.',
            monthLabel ? count + ' ' + noun + ' for ' + monthLabel + '.' : count + ' ' + noun + '.',
          ],
          cancelLabel: 'Not yet',
          confirmLabel: 'Approve focus points',
          onConfirm: function () { doApprove(btn, warn); },
        });
      });

      bar.appendChild(btn);
      bar.appendChild(warn);
      return bar;
    }

    function buildReceiptBar() {
      var bar = document.createElement('div');
      bar.className = 'cp-fp-bar cp-fp-bar-done';
      bar.appendChild(textNode('span', 'cp-fp-donetick', '✓'));
      bar.appendChild(textNode('div', 'cp-fp-barnote',
        approvedAt ? 'Approved on ' + formatDate(approvedAt) : 'Approved'));
      return bar;
    }

    function doApprove(btn, warn) {
      btn.disabled = true;
      btn.textContent = 'Approving...';
      warn.hidden = true;
      markDirty(1);
      api('POST', EP_APPROVE, {
        deliverableId: deliverableId,
        portalToken: portalToken,
      }).then(function (res) {
        markDirty(-1);
        // 409 is "already past focus_points_sent", which is the stale-tab and the
        // double-click case. That is a success from where the client sits: the
        // month IS approved, so show the receipt rather than an error.
        if (res && (res.ok || res.status === 409)) {
          var returned = res.ok ? rowOf(res.data) : null;
          var returnedMeta = returned ? metaOf(returned) : null;
          approvedAt = (returnedMeta && approvedStampOf(returnedMeta)) || approvedAt || new Date().toISOString();
          editable = false;
          mount();
          try { window.scrollTo(0, 0); } catch (e) { /* no-op */ }
          if (typeof ctx.onApproved === 'function') {
            try { ctx.onApproved(returned || row); } catch (e) { /* the page is already correct */ }
          }
          return;
        }
        btn.disabled = false;
        btn.textContent = 'Approve focus points';
        warn.textContent = (res && res.data && res.data.error) || 'Could not approve. Please try again.';
        warn.hidden = false;
      }).catch(function () {
        markDirty(-1);
        btn.disabled = false;
        btn.textContent = 'Approve focus points';
        warn.textContent = 'Could not approve. Please try again.';
        warn.hidden = false;
      });
    }

    mount();
    if (typeof ctx.tagItem === 'function') { try { ctx.tagItem(root, row); } catch (e) { /* optional */ } }
    if (typeof ctx.afterRenderRestore === 'function') { try { ctx.afterRenderRestore(); } catch (e) { /* optional */ } }
    return root;
  }

  window.CPFocusPoints = {
    render: render,
    // Exposed for the wiring agent's own guards and for a console check that the
    // right build is on the page. Nothing in this file reads them.
    isIsoDate: isIsoDate,
    focusPointsOf: focusPointsOf,
  };
})();
