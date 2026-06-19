'use strict';

/*
 * Agri360 Client Portal — SPA
 * ----------------------------
 * Client-facing, no login. Two flows only:
 *   1) /form/:token        — fill + submit a focus-points questionnaire.
 *   2) /approvals/:token   — approve / request changes on CC deliverables.
 *
 * All data calls go through this app's own same-origin /api/* proxy, which
 * injects the shared X-Portal-Key header server-side. The browser never sees
 * the key.
 */

(function () {
  var appEl = document.getElementById('app');
  var overlayEl = document.getElementById('overlay');

  // ── tiny DOM helpers ──────────────────────────────────────────────
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] === true) node.setAttribute(k, '');
        else if (attrs[k] != null && attrs[k] !== false) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function render(node) { clear(appEl); appEl.appendChild(node); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function plainText(html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // ── API helper (same-origin proxy) ───────────────────────────────
  function api(method, pathName, body) {
    var init = { method: method, headers: { 'Accept': 'application/json' } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(pathName, init).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  // ── overlay (modal) ──────────────────────────────────────────────
  function openOverlay(content) {
    clear(overlayEl);
    overlayEl.appendChild(content);
    overlayEl.hidden = false;
    overlayEl.onclick = function (e) { if (e.target === overlayEl) closeOverlay(); };
  }
  function closeOverlay() { overlayEl.hidden = true; clear(overlayEl); }

  // ════════════════════════════════════════════════════════════════
  // FLOW 1 — FOCUS-POINTS FORM   /form/:token
  // ════════════════════════════════════════════════════════════════
  function loadForm(token) {
    render(el('div', { class: 'cp-loading', text: 'Loading form…' }));
    api('GET', '/api/request-forms/public/' + encodeURIComponent(token)).then(function (r) {
      if (!r.ok || !r.data) {
        return render(errorState('This form could not be found or has expired.'));
      }
      renderForm(token, r.data);
    }).catch(function () {
      render(errorState('Could not load the form. Please try again.'));
    });
  }

  function renderForm(token, form) {
    if (form.status === 'submitted' || form.status === 'completed') {
      return render(thankYouState('This form has already been submitted. Thank you!'));
    }

    var fields = normaliseFields(form.fields);
    var inputs = {}; // fieldId -> getter()

    var wrap = el('div', {}, [
      el('h1', { class: 'cp-h1', text: form.name || 'Questionnaire' }),
      el('p', { class: 'cp-sub', text: 'Please complete the questions below and submit.' }),
    ]);

    var card = el('div', { class: 'cp-card' });

    fields.forEach(function (f) {
      var field = renderField(f, inputs);
      if (field) card.appendChild(field);
    });

    var errBox = el('div', { class: 'cp-warn', hidden: true });
    card.appendChild(errBox);

    var submitBtn = el('button', {
      class: 'cp-btn cp-btn-primary cp-btn-block', type: 'button', text: 'Submit',
    });

    submitBtn.addEventListener('click', function () {
      errBox.hidden = true;
      var responses = {};
      var missing = [];
      fields.forEach(function (f) {
        var getter = inputs[f.id];
        var val = getter ? getter() : '';
        if (f.required && (val == null || (Array.isArray(val) ? val.length === 0 : String(val).trim() === ''))) {
          missing.push(f.label || f.id);
        }
        responses[f.id] = val;
      });
      if (missing.length) {
        errBox.textContent = 'Please fill in: ' + missing.join(', ');
        errBox.hidden = false;
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
      api('POST', '/api/request-forms/public/' + encodeURIComponent(token) + '/submit', { responses: responses })
        .then(function (res) {
          if (res.ok) {
            render(thankYouState('Your responses have been submitted. Thank you!'));
          } else {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit';
            errBox.textContent = (res.data && res.data.error) || 'Submission failed. Please try again.';
            errBox.hidden = false;
          }
        }).catch(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit';
          errBox.textContent = 'Submission failed. Please try again.';
          errBox.hidden = false;
        });
    });

    card.appendChild(submitBtn);
    wrap.appendChild(card);
    render(wrap);
  }

  // Accept fields either as an array of {id,fieldType,label,...} or the
  // legacy nested card shape {fields:[...]}. Returns a flat field array.
  function normaliseFields(raw) {
    var out = [];
    if (!raw) return out;
    var list = Array.isArray(raw) ? raw : (Array.isArray(raw.fields) ? raw.fields : []);
    list.forEach(function (item) {
      if (item && Array.isArray(item.fields)) {
        item.fields.forEach(function (f) { out.push(f); });
      } else if (item) {
        out.push(item);
      }
    });
    return out.map(function (f, i) {
      return {
        id: f.id != null ? String(f.id) : ('f' + i),
        fieldType: f.fieldType || f.type || 'text',
        label: f.label || f.question || '',
        placeholder: f.placeholder || '',
        required: !!f.required,
        options: f.options || f.choices || [],
      };
    });
  }

  function renderField(f, inputs) {
    var labelText = f.label || 'Question';
    var labelNode = el('label', { class: 'cp-field-label' }, [
      document.createTextNode(labelText),
    ]);
    if (f.required) labelNode.appendChild(el('span', { class: 'req', text: '*' }));

    var control;
    var ft = f.fieldType;

    if (ft === 'textarea') {
      control = el('textarea', { class: 'cp-textarea', placeholder: f.placeholder });
      inputs[f.id] = function () { return control.value; };
    } else if (ft === 'number') {
      control = el('input', { class: 'cp-input', type: 'number', placeholder: f.placeholder });
      inputs[f.id] = function () { return control.value; };
    } else if (ft === 'date') {
      control = el('input', { class: 'cp-input', type: 'date' });
      inputs[f.id] = function () { return control.value; };
    } else if (ft === 'select' && f.options.length) {
      control = el('select', { class: 'cp-select' }, [el('option', { value: '', text: '— Select —' })]);
      f.options.forEach(function (o) {
        var v = typeof o === 'string' ? o : (o.value || o.label || '');
        control.appendChild(el('option', { value: v, text: v }));
      });
      inputs[f.id] = function () { return control.value; };
    } else if (ft === 'radio' && f.options.length) {
      control = el('div', { class: 'cp-radio-group' });
      var rname = 'r_' + f.id;
      f.options.forEach(function (o) {
        var v = typeof o === 'string' ? o : (o.value || o.label || '');
        control.appendChild(el('label', { class: 'cp-radio-row' }, [
          el('input', { type: 'radio', name: rname, value: v }),
          document.createTextNode(v),
        ]));
      });
      inputs[f.id] = function () {
        var c = control.querySelector('input:checked');
        return c ? c.value : '';
      };
    } else if (ft === 'checkbox' && f.options.length) {
      control = el('div', { class: 'cp-checkbox-group' });
      f.options.forEach(function (o) {
        var v = typeof o === 'string' ? o : (o.value || o.label || '');
        control.appendChild(el('label', { class: 'cp-checkbox-row' }, [
          el('input', { type: 'checkbox', value: v }),
          document.createTextNode(v),
        ]));
      });
      inputs[f.id] = function () {
        return Array.prototype.slice.call(control.querySelectorAll('input:checked')).map(function (c) { return c.value; });
      };
    } else {
      // text / file (file rendered as a text URL note) / fallback
      control = el('input', { class: 'cp-input', type: 'text', placeholder: f.placeholder });
      inputs[f.id] = function () { return control.value; };
    }

    return el('div', { class: 'cp-field' }, [labelNode, control]);
  }

  // ════════════════════════════════════════════════════════════════
  // FLOW 2 — CC APPROVALS   /approvals/:clientToken
  // ════════════════════════════════════════════════════════════════
  function loadApprovals(clientToken) {
    render(el('div', { class: 'cp-loading', text: 'Loading approvals…' }));
    api('GET', '/api/request-forms/public/portal/' + encodeURIComponent(clientToken) + '/approvals').then(function (r) {
      if (!r.ok) {
        return render(errorState('Could not load your approvals. The link may be invalid.'));
      }
      var items = extractDeliverables(r.data);
      renderApprovalList(clientToken, items);
    }).catch(function () {
      render(errorState('Could not load your approvals. Please try again.'));
    });
  }

  function extractDeliverables(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.deliverables)) return data.deliverables;
    if (data && Array.isArray(data.items)) return data.items;
    return [];
  }

  function postsOf(d) {
    var meta = d.metadata || d.meta || {};
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = {}; } }
    return Array.isArray(meta.posts) ? meta.posts : [];
  }
  // A "card" = a post entry that has media. Skip empty ones.
  function mediaPosts(d) {
    return postsOf(d).map(function (p, idx) {
      var images = Array.isArray(p.images) ? p.images : (p.image ? [p.image] : []);
      return { post: p, index: idx, images: images };
    }).filter(function (mp) { return mp.images.length > 0; });
  }
  function isApprovedStatus(s) {
    return s === 'approved';
  }

  function renderApprovalList(clientToken, items) {
    var wrap = el('div', {}, [
      el('h1', { class: 'cp-h1', text: 'Content Approvals' }),
      el('p', { class: 'cp-sub', text: 'Review the content below and approve, or request changes.' }),
    ]);

    if (!items.length) {
      wrap.appendChild(el('div', { class: 'cp-empty' }, [
        el('div', { class: 'cp-tick', text: '✓' }),
        el('p', { text: 'Nothing needs your approval right now.' }),
      ]));
      return render(wrap);
    }

    items.forEach(function (d) {
      var cards = mediaPosts(d);
      var allApproved = cards.length > 0 && cards.every(function (c) { return isApprovedStatus(c.post.status); });

      var head = el('div', { class: 'cp-card-head' }, [
        el('h2', { class: 'cp-card-title', text: d.title || d.name || 'Content Calendar' }),
        allApproved
          ? el('span', { class: 'cp-badge cp-badge-approved', text: 'Approved' })
          : el('span', { class: 'cp-badge cp-badge-action', text: 'Approval required' }),
      ]);

      var card = el('div', { class: 'cp-card ' + (allApproved ? 'cp-card-approved' : 'cp-card-action') }, [head]);

      if (d.approvedAt || d.approval_date) {
        card.appendChild(el('p', { class: 'cp-note', text: 'Approved on ' + formatDate(d.approvedAt || d.approval_date) }));
      }

      if (!cards.length) {
        card.appendChild(el('p', { class: 'cp-note', text: 'No media to review for this item yet.' }));
      } else {
        card.appendChild(renderGallery(clientToken, d, cards));
      }

      wrap.appendChild(card);
    });

    render(wrap);
  }

  function renderGallery(clientToken, deliverable, cards) {
    var gallery = el('div', { class: 'cp-gallery' });

    cards.forEach(function (c) {
      var approved = isApprovedStatus(c.post.status);
      var size = c.post.size || (deliverable.size) || '';
      var postCard = el('div', { class: 'cp-post' + (approved ? ' approved' : '') });

      var thumb = el('img', {
        class: 'cp-post-thumb',
        src: c.images[0],
        alt: 'Post ' + (c.index + 1),
        loading: 'lazy',
      });
      thumb.addEventListener('click', function () {
        openDetail(clientToken, deliverable, c);
      });
      postCard.appendChild(thumb);

      var body = el('div', { class: 'cp-post-body' });
      var metaBits = [];
      if (c.post.date) metaBits.push(formatDate(c.post.date));
      if (size) metaBits.push(String(size));
      body.appendChild(el('div', { class: 'cp-post-meta', text: metaBits.join(' · ') || ('Post ' + (c.index + 1)) }));
      body.appendChild(el('div', { class: 'cp-post-cap', text: plainText(c.post.caption) || '(no caption)' }));

      var actions = el('div', { class: 'cp-post-actions' });
      if (approved) {
        actions.appendChild(el('span', { class: 'cp-post-approved-tag', text: '✓ Approved' }));
      } else {
        var approveBtn = el('button', { class: 'cp-btn cp-btn-approve', type: 'button', text: 'Approve' });
        approveBtn.addEventListener('click', function () {
          approvePost(clientToken, deliverable, c, approveBtn);
        });
        var editBtn = el('button', { class: 'cp-btn', type: 'button', text: 'Review' });
        editBtn.addEventListener('click', function () { openDetail(clientToken, deliverable, c); });
        actions.appendChild(approveBtn);
        actions.appendChild(editBtn);
      }
      body.appendChild(actions);
      postCard.appendChild(body);
      gallery.appendChild(postCard);
    });

    return gallery;
  }

  function approvePost(clientToken, deliverable, card, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
    api('POST', '/api/request-forms/public/portal/approve', {
      deliverableId: deliverable.id,
      postIndex: card.index,
      size: card.post.size || deliverable.size || undefined,
    }).then(function (res) {
      if (res.ok) {
        // Re-fetch so the CRM's auto-advance / approved state is reflected.
        var routeToken = currentRoute().token;
        loadApprovals(routeToken || clientToken);
      } else if (btn) {
        btn.disabled = false;
        btn.textContent = 'Approve';
        alert((res.data && res.data.error) || 'Could not approve. Please try again.');
      }
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Approve'; }
      alert('Could not approve. Please try again.');
    });
  }

  // ── Detail / change-request view (modal) ─────────────────────────
  function openDetail(clientToken, deliverable, card) {
    var modal = el('div', { class: 'cp-modal' });

    var closeBtn = el('button', { class: 'cp-modal-close', type: 'button', html: '&times;' });
    closeBtn.addEventListener('click', closeOverlay);

    modal.appendChild(el('div', { class: 'cp-modal-head' }, [
      el('h3', { class: 'cp-modal-title', text: (deliverable.title || 'Post') + ' — #' + (card.index + 1) }),
      closeBtn,
    ]));

    var bodyWrap = el('div', { class: 'cp-modal-body' });

    // Image(s)
    card.images.forEach(function (url) {
      bodyWrap.appendChild(el('img', { class: 'cp-modal-img', src: url, alt: 'Post media' }));
    });

    // Rich-text caption editor
    bodyWrap.appendChild(el('div', { class: 'cp-editor-label', text: 'Caption (you can edit)' }));
    var toolbar = el('div', { class: 'cp-toolbar' });
    var editor = el('div', { class: 'cp-editor', contenteditable: 'true', html: card.post.caption || '' });
    [['bold', 'B'], ['italic', 'I'], ['underline', 'U'], ['insertUnorderedList', '•']].forEach(function (pair) {
      var b = el('button', { type: 'button', html: pair[1] });
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { document.execCommand(pair[0], false, null); editor.focus(); });
      toolbar.appendChild(b);
    });
    bodyWrap.appendChild(toolbar);
    bodyWrap.appendChild(editor);

    // Change-request box
    bodyWrap.appendChild(el('div', { class: 'cp-editor-label', text: 'Request a change (optional)' }));
    var crBox = el('textarea', { class: 'cp-textarea', placeholder: 'Describe what you would like changed…' });
    bodyWrap.appendChild(crBox);

    bodyWrap.appendChild(el('div', { class: 'cp-editor-label', text: 'Attach a screenshot (optional)' }));
    var fileInput = el('input', { class: 'cp-input', type: 'file', accept: 'image/*' });
    bodyWrap.appendChild(fileInput);

    var warn = el('div', { class: 'cp-warn', hidden: true });
    bodyWrap.appendChild(warn);

    var actions = el('div', { class: 'cp-actions' });
    var approveBtn = el('button', { class: 'cp-btn cp-btn-approve', type: 'button', text: 'Approve as-is' });
    approveBtn.addEventListener('click', function () {
      closeOverlay();
      approvePost(clientToken, deliverable, card, null);
    });
    var sendBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Send change request' });
    sendBtn.addEventListener('click', function () {
      submitChangeRequest(clientToken, deliverable, card, editor, crBox, fileInput, sendBtn, warn);
    });
    actions.appendChild(approveBtn);
    actions.appendChild(sendBtn);
    bodyWrap.appendChild(actions);

    modal.appendChild(bodyWrap);
    openOverlay(modal);
  }

  function submitChangeRequest(clientToken, deliverable, card, editor, crBox, fileInput, btn, warn) {
    warn.hidden = true;
    var body = crBox.value.trim();
    var captionEdits = editor.innerHTML;
    if (!body && captionEdits === (card.post.caption || '')) {
      warn.textContent = 'Add a change note or edit the caption before sending.';
      warn.hidden = false;
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Sending…';

    function send(screenshots) {
      api('POST', '/api/request-forms/public/portal/change-request', {
        deliverableId: deliverable.id,
        postIndex: card.index,
        body: body,
        screenshots: screenshots,
        captionEdits: captionEdits,
      }).then(function (res) {
        if (res.ok) {
          closeOverlay();
          loadApprovals(currentRoute().token || clientToken);
        } else if (res.status === 409) {
          btn.disabled = false;
          btn.textContent = 'Send change request';
          warn.textContent = 'No change rounds left — please approve.';
          warn.hidden = false;
        } else {
          btn.disabled = false;
          btn.textContent = 'Send change request';
          warn.textContent = (res.data && res.data.error) || 'Could not send. Please try again.';
          warn.hidden = false;
        }
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = 'Send change request';
        warn.textContent = 'Could not send. Please try again.';
        warn.hidden = false;
      });
    }

    var file = fileInput.files && fileInput.files[0];
    if (file) {
      var reader = new FileReader();
      reader.onload = function () { send([reader.result]); };
      reader.onerror = function () { send([]); };
      reader.readAsDataURL(file);
    } else {
      send([]);
    }
  }

  // ── shared states ────────────────────────────────────────────────
  function thankYouState(msg) {
    return el('div', { class: 'cp-thankyou' }, [
      el('div', { class: 'cp-tick', text: '✓' }),
      el('h1', { class: 'cp-h1', text: 'Thank you!' }),
      el('p', { class: 'cp-sub', text: msg || '' }),
    ]);
  }
  function errorState(msg) {
    return el('div', { class: 'cp-error' }, [
      el('h1', { class: 'cp-h1', text: 'Something went wrong' }),
      el('p', { class: 'cp-sub', text: msg || '' }),
    ]);
  }

  function formatDate(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // ── Router (path-based, with hash fallback) ──────────────────────
  function currentRoute() {
    var p = window.location.pathname;
    var m = p.match(/^\/(form|approvals)\/([^\/]+)/);
    if (!m && window.location.hash) {
      m = window.location.hash.replace(/^#/, '').match(/^\/?(form|approvals)\/([^\/]+)/);
    }
    if (m) return { view: m[1], token: decodeURIComponent(m[2]) };
    return { view: null, token: null };
  }

  function route() {
    var r = currentRoute();
    if (r.view === 'form' && r.token) return loadForm(r.token);
    if (r.view === 'approvals' && r.token) return loadApprovals(r.token);
    return render(landing());
  }

  function landing() {
    return el('div', { class: 'cp-empty' }, [
      el('h1', { class: 'cp-h1', text: 'ProAgri Client Portal' }),
      el('p', { class: 'cp-sub', text: 'Please open the link you were sent to view your form or content approvals.' }),
    ]);
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  route();
})();
