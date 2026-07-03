'use strict';

/*
 * Agri360 Client Portal — SPA
 * ----------------------------
 * Client-facing, no login. Two flows only:
 *   1) /form/:token            — fill + submit a focus-points questionnaire.
 *   2) /approvals/:portalToken — approve / request changes on CC deliverables.
 *
 * The :portalToken is an opaque, unguessable string (clients.portal_token).
 * It is passed straight through to the CRM, which resolves it to a client —
 * the portal never parses it as a numeric id or sends a ?clientId param.
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
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        // Let the browser set Content-Type (incl. the multipart boundary).
        init.body = body;
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
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

  // The video-request engine (form-render.js) opens the #popup <dialog> for
  // "action required" validation prompts; wire its OK button to close it.
  (function wireVrfPopup() {
    var closeBtn = document.getElementById('popupClose');
    var dlg = document.getElementById('popup');
    if (closeBtn && dlg) {
      closeBtn.addEventListener('click', function () {
        if (typeof dlg.close === 'function' && dlg.open) dlg.close();
      });
    }
  })();

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
      var fileFields = {}; // fieldId -> array of File objects
      var missing = [];
      fields.forEach(function (f) {
        var getter = inputs[f.id];
        var val = getter ? getter() : '';
        var isFile = (f.fieldType === 'file' || f.fieldType === 'file-upload');
        if (f.required && (val == null || (Array.isArray(val) ? val.length === 0 : String(val).trim() === ''))) {
          missing.push(f.label || f.id);
        }
        if (isFile) {
          fileFields[f.id] = Array.isArray(val) ? val : [];
        } else {
          responses[f.id] = val;
        }
      });
      if (missing.length) {
        errBox.textContent = 'Please fill in: ' + missing.join(', ');
        errBox.hidden = false;
        return;
      }

      // Backward-compat: only switch to multipart when files were actually chosen.
      var hasFiles = Object.keys(fileFields).some(function (id) { return fileFields[id].length > 0; });
      var payload;
      if (hasFiles) {
        var fd = new FormData();
        fd.append('responses', JSON.stringify(responses));
        var fileFieldMap = {}; // fieldId -> [ multipart part names ]
        Object.keys(fileFields).forEach(function (id) {
          var partName = 'file__' + id;
          fileFieldMap[id] = [];
          fileFields[id].forEach(function (file) {
            fd.append(partName, file, file.name);
            fileFieldMap[id].push(partName);
          });
        });
        fd.append('fileFieldMap', JSON.stringify(fileFieldMap));
        payload = fd;
      } else {
        payload = { responses: responses };
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
      api('POST', '/api/request-forms/public/' + encodeURIComponent(token) + '/submit', payload)
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
    } else if (ft === 'file' || ft === 'file-upload') {
      control = el('input', { class: 'cp-input cp-file', type: 'file', multiple: true });
      control.dataset.cpFile = '1';
      inputs[f.id] = function () {
        return Array.prototype.slice.call(control.files || []);
      };
    } else {
      // text / fallback
      control = el('input', { class: 'cp-input', type: 'text', placeholder: f.placeholder });
      inputs[f.id] = function () { return control.value; };
    }

    return el('div', { class: 'cp-field' }, [labelNode, control]);
  }

  // ════════════════════════════════════════════════════════════════
  // FLOW 2 — CC APPROVALS   /approvals/:portalToken
  // ════════════════════════════════════════════════════════════════
  // portalToken is an opaque, unguessable string (clients.portal_token).
  // It is forwarded verbatim to the CRM, which resolves it to a client —
  // no parseInt, no ?clientId.
  function loadApprovals(portalToken) {
    render(el('div', { class: 'cp-loading', text: 'Loading approvals…' }));
    api('GET', '/api/request-forms/public/portal/' + encodeURIComponent(portalToken) + '/approvals').then(function (r) {
      if (!r.ok) {
        return render(errorState('Could not load your approvals. The link may be invalid.'));
      }
      var items = extractDeliverables(r.data);
      renderApprovalList(portalToken, items);
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

  // ── asset URL resolver (website-design previews) ─────────────────
  // Uploaded design assets come back as CRM-relative paths
  // (`/uploads/client-assets/…`). The portal proxies BOTH /api/* and
  // /uploads/* to the CRM, so these stay SAME-ORIGIN to the portal — which
  // is required for the <iframe> PDF preview (the CRM serves files with CSP
  // `frame-ancestors 'self'`, blocking cross-origin framing). So relative
  // paths are returned untouched; absolute URLs / data URIs / external
  // designLinks pass through as-is.
  function assetUrl(u) {
    if (!u) return '';
    var s = String(u);
    if (/^(https?:)?\/\//i.test(s) || s.indexOf('data:') === 0 || s.indexOf('blob:') === 0) return s;
    if (s.charAt(0) !== '/') s = '/' + s;
    return s; // same-origin via the portal's /uploads proxy
  }
  function isWebsiteDesign(d) { return d && d.type === 'website-design'; }
  function isAgri4allProductUploads(d) { return d && d.type === 'agri4all-product-uploads'; }
  function isVideo(d) { return d && d.type === 'video'; }
  function isMagazine(d) { return d && d.type === 'magazine'; }
  function looksLikeVideo(u) { return /\.(mp4|mov|m4v|webm|ogg|ogv)(\?|#|$)/i.test(String(u || '')); }
  // The video deliverable carries the cut in metadata.video_upload. toCamelCase
  // does NOT recurse into the metadata JSONB blob, so the nested key arrives
  // exactly as the CRM writes it — read both snake and camel forms defensively.
  function videoUploadOf(d) {
    var meta = metaOf(d);
    var vu = meta.video_upload || meta.videoUpload || null;
    if (!vu || typeof vu !== 'object') return null;
    var url = vu.url || vu.path || vu.src || '';
    if (!url) return null;
    return {
      url: url,
      name: vu.name || vu.filename || vu.title || '',
      mimeType: vu.mimeType || vu.mime_type || vu.type || '',
    };
  }
  function looksLikeImage(u) { return /\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?|#|$)/i.test(String(u || '')); }
  function looksLikePdf(u) { return /\.pdf(\?|#|$)/i.test(String(u || '')); }
  function metaOf(d) {
    var meta = d.metadata || d.meta || {};
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = {}; } }
    return meta && typeof meta === 'object' ? meta : {};
  }

  function renderApprovalList(portalToken, items) {
    var wrap = el('div', {}, [
      el('h1', { class: 'cp-h1', text: 'Content Approvals' }),
      el('p', { class: 'cp-sub', text: 'Review the content below and approve, or request changes.' }),
      el('a', { class: 'cp-dash-link', href: '/dashboard/' + encodeURIComponent(portalToken),
        text: '← Back to dashboard' }),
    ]);

    if (!items.length) {
      wrap.appendChild(el('div', { class: 'cp-empty' }, [
        el('div', { class: 'cp-tick', text: '✓' }),
        el('p', { text: 'Nothing needs your approval right now.' }),
      ]));
      return render(wrap);
    }

    items.forEach(function (d) {
      // Design-collateral rows carry their own client-facing approval layout
      // (item.approvalLayout). Branch on kind BEFORE the type checks so the
      // configurable card renderer takes precedence over any type heuristics.
      if (d.kind === 'collateral') {
        wrap.appendChild(renderCollateralCard(portalToken, d));
        return;
      }

      // Website-design deliverables get a dedicated approval card; the CC
      // per-post path below is left fully intact.
      if (isWebsiteDesign(d)) {
        wrap.appendChild(renderWebsiteDesignCard(portalToken, d));
        return;
      }

      // Video deliverables get a dedicated approval card: an embedded HTML5
      // player for the cut + whole-deliverable Approve / Request-changes.
      if (isVideo(d)) {
        wrap.appendChild(renderVideoCard(portalToken, d));
        return;
      }

      // Agri4All product-upload approvals get their own card(s). The same
      // deliverable type reaches the client at TWO different statuses, so
      // we branch on the row's status:
      //   • 'sent_for_approval' → DESIGN approval (shows the design image)
      //   • 'agri4all-links'    → LIVE-LINKS approval (shows live listings)
      if (isAgri4allProductUploads(d)) {
        if (d.status === 'agri4all-links') {
          wrap.appendChild(renderAgri4allLinksCard(portalToken, d));
        } else {
          wrap.appendChild(renderAgri4allProductCard(portalToken, d));
        }
        return;
      }

      // Magazine print-ad / print-article deliverables get a dedicated card
      // with a publication pill (static when resolved, selectable when the
      // 'Print Ad / Print Article' choice is still undecided).
      if (isMagazine(d)) {
        wrap.appendChild(renderMagazineCard(portalToken, d));
        return;
      }

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
        card.appendChild(renderGallery(portalToken, d, cards));
      }

      wrap.appendChild(card);
    });

    render(wrap);
  }

  function renderGallery(portalToken, deliverable, cards) {
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
        openDetail(portalToken, deliverable, c);
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
          approvePost(portalToken, deliverable, c, approveBtn);
        });
        var editBtn = el('button', { class: 'cp-btn', type: 'button', text: 'Review' });
        editBtn.addEventListener('click', function () { openDetail(portalToken, deliverable, c); });
        actions.appendChild(approveBtn);
        actions.appendChild(editBtn);
      }
      body.appendChild(actions);
      postCard.appendChild(body);
      gallery.appendChild(postCard);
    });

    return gallery;
  }

  function approvePost(portalToken, deliverable, card, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
    api('POST', '/api/request-forms/public/portal/approve', {
      deliverableId: deliverable.id,
      postIndex: card.index,
      size: card.post.size || deliverable.size || undefined,
      portalToken: currentRoute().token || portalToken,
    }).then(function (res) {
      if (res.ok) {
        // Re-fetch so the CRM's auto-advance / approved state is reflected.
        var routeToken = currentRoute().token;
        loadApprovals(routeToken || portalToken);
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

  // ════════════════════════════════════════════════════════════════
  // WEBSITE-DESIGN APPROVAL CARD  (type === 'website-design')
  // ════════════════════════════════════════════════════════════════
  // Two rounds reach the client:
  //   • status 'sent_for_approval' → design mock-ups  ("Design approval")
  //   • status 'final_review'      → built site       ("Final site approval")
  // Previews the uploaded design assets + any metadata.designLinks, then
  // offers whole-deliverable Approve / Request-changes (no postIndex/size).
  function renderWebsiteDesignCard(portalToken, d) {
    var meta = metaOf(d);
    var status = d.status || '';
    var approved = status === 'approved' || status === 'resizing' || !!d.approvedAt || !!d.approval_date;
    var roundLabel = status === 'final_review' ? 'Final site approval' : 'Design approval';

    var head = el('div', { class: 'cp-card-head' }, [
      el('div', {}, [
        el('h2', { class: 'cp-card-title', text: d.title || d.name || 'Website Design' }),
        el('div', { class: 'cp-wd-round', text: roundLabel }),
      ]),
      approved
        ? el('span', { class: 'cp-badge cp-badge-approved', text: 'Approved' })
        : el('span', { class: 'cp-badge cp-badge-action', text: 'Approval required' }),
    ]);

    var card = el('div', { class: 'cp-card ' + (approved ? 'cp-card-approved' : 'cp-card-action') }, [head]);

    if (d.approvedAt || d.approval_date) {
      card.appendChild(el('p', { class: 'cp-note', text: 'Approved on ' + formatDate(d.approvedAt || d.approval_date) }));
    }

    // ── Previews ──────────────────────────────────────────────────
    var assets = Array.isArray(d.assets) ? d.assets : [];
    var links = Array.isArray(meta.designLinks) ? meta.designLinks : [];

    var imageAssets = assets.filter(function (a) {
      return a && a.url && ((a.mimeType && a.mimeType.indexOf('image/') === 0) || looksLikeImage(a.url));
    });
    var pdfAssets = assets.filter(function (a) {
      return a && a.url && ((a.mimeType === 'application/pdf') || looksLikePdf(a.url));
    });
    var otherAssets = assets.filter(function (a) {
      return a && a.url && imageAssets.indexOf(a) === -1 && pdfAssets.indexOf(a) === -1;
    });

    var hasAnything = imageAssets.length || pdfAssets.length || otherAssets.length || links.length;
    if (!hasAnything) {
      card.appendChild(el('p', { class: 'cp-note', text: 'No designs to preview yet.' }));
    }

    // Image thumbnails → lightbox (collect all preview-able image URLs so the
    // lightbox can page through them).
    var lightboxUrls = imageAssets.map(function (a) { return assetUrl(a.url); });
    links.forEach(function (lk) { if (lk && lk.url && looksLikeImage(lk.url)) lightboxUrls.push(assetUrl(lk.url)); });

    if (imageAssets.length) {
      var grid = el('div', { class: 'cp-wd-grid' });
      imageAssets.forEach(function (a) {
        var full = assetUrl(a.url);
        var thumb = el('img', {
          class: 'cp-wd-thumb',
          src: full,
          alt: a.title || 'Design preview',
          loading: 'lazy',
          title: a.title || '',
        });
        thumb.addEventListener('click', function () {
          openImageLightbox(lightboxUrls, lightboxUrls.indexOf(full));
        });
        grid.appendChild(thumb);
      });
      card.appendChild(grid);
    }

    // PDFs → inline iframe + open button.
    pdfAssets.forEach(function (a) {
      var url = assetUrl(a.url);
      var block = el('div', { class: 'cp-wd-pdf' });
      block.appendChild(el('div', { class: 'cp-wd-filelabel', text: a.title || 'PDF design' }));
      block.appendChild(el('iframe', { class: 'cp-wd-pdf-frame', src: url, title: a.title || 'PDF design' }));
      var openRow = el('div', { class: 'cp-wd-fileactions' }, [
        el('a', { class: 'cp-btn', href: url, target: '_blank', rel: 'noopener', text: 'Open PDF' }),
      ]);
      block.appendChild(openRow);
      card.appendChild(block);
    });

    // Other files → open button.
    if (otherAssets.length) {
      var fileRow = el('div', { class: 'cp-wd-fileactions' });
      otherAssets.forEach(function (a) {
        fileRow.appendChild(el('a', {
          class: 'cp-btn', href: assetUrl(a.url), target: '_blank', rel: 'noopener',
          text: a.title ? ('Open ' + a.title) : 'Open file',
        }));
      });
      card.appendChild(fileRow);
    }

    // Design links → open buttons (+ inline preview for image/pdf links).
    if (links.length) {
      var linkRow = el('div', { class: 'cp-wd-fileactions' });
      links.forEach(function (lk) {
        if (!lk || !lk.url) return;
        var url = assetUrl(lk.url);
        linkRow.appendChild(el('a', {
          class: 'cp-btn', href: url, target: '_blank', rel: 'noopener',
          text: lk.label || 'Open design',
        }));
      });
      card.appendChild(linkRow);

      links.forEach(function (lk) {
        if (!lk || !lk.url) return;
        var url = assetUrl(lk.url);
        if (looksLikePdf(lk.url)) {
          card.appendChild(el('iframe', { class: 'cp-wd-pdf-frame', src: url, title: lk.label || 'PDF design' }));
        }
        // image links already added to lightboxUrls; render a thumbnail too.
        if (looksLikeImage(lk.url)) {
          var grid2 = el('div', { class: 'cp-wd-grid' });
          var t = el('img', { class: 'cp-wd-thumb', src: url, alt: lk.label || 'Design preview', loading: 'lazy' });
          t.addEventListener('click', function () { openImageLightbox(lightboxUrls, lightboxUrls.indexOf(url)); });
          grid2.appendChild(t);
          card.appendChild(grid2);
        }
      });
    }

    // ── Actions ───────────────────────────────────────────────────
    if (approved) {
      card.appendChild(el('div', { class: 'cp-wd-approved-note' }, [
        el('span', { class: 'cp-post-approved-tag', text: '✓ Approved' }),
      ]));
      return card;
    }

    var roundsUsed = parseInt(meta.changeRequestRoundsUsed, 10) || 0;
    var roundsLeft = Math.max(0, 3 - roundsUsed);

    var warn = el('div', { class: 'cp-warn', hidden: true });
    var crBox = el('textarea', { class: 'cp-textarea', placeholder: 'Describe the changes you would like…' });
    var crWrap = el('div', { class: 'cp-wd-cr', hidden: true }, [
      el('div', { class: 'cp-editor-label', text: 'Request changes' }),
      crBox,
    ]);

    // Optional screenshot upload (mirrors the CC change-request pattern).
    var fileInput = el('input', { class: 'cp-input', type: 'file', accept: 'image/*' });
    crWrap.appendChild(el('div', { class: 'cp-editor-label', text: 'Attach a screenshot (optional)' }));
    crWrap.appendChild(fileInput);
    crWrap.appendChild(warn);

    var actions = el('div', { class: 'cp-actions' });

    var approveBtn = el('button', { class: 'cp-btn cp-btn-approve', type: 'button', text: 'Approve' });
    approveBtn.addEventListener('click', function () {
      approveWebsiteDesign(portalToken, d, approveBtn);
    });

    var changeBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Request changes' });
    var sendBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Send change request', hidden: true });

    if (roundsLeft <= 0) {
      changeBtn.disabled = true;
      changeBtn.textContent = 'No change rounds left';
    }

    changeBtn.addEventListener('click', function () {
      // Reveal the change-request box on first click.
      crWrap.hidden = false;
      changeBtn.hidden = true;
      sendBtn.hidden = false;
      crBox.focus();
    });

    sendBtn.addEventListener('click', function () {
      submitWebsiteDesignChange(portalToken, d, crBox, fileInput, sendBtn, warn);
    });

    actions.appendChild(approveBtn);
    actions.appendChild(changeBtn);
    actions.appendChild(sendBtn);
    card.appendChild(actions);

    if (roundsUsed > 0) {
      card.appendChild(el('p', { class: 'cp-note', text: roundsLeft + ' change round' + (roundsLeft === 1 ? '' : 's') + ' left.' }));
    }

    card.appendChild(crWrap);
    return card;
  }

  function approveWebsiteDesign(portalToken, d, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
    api('POST', '/api/request-forms/public/portal/approve', {
      deliverableId: d.id,
      portalToken: currentRoute().token || portalToken,
    }).then(function (res) {
      if (res.ok) {
        loadApprovals(currentRoute().token || portalToken);
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

  function submitWebsiteDesignChange(portalToken, d, crBox, fileInput, btn, warn) {
    warn.hidden = true;
    var body = (crBox.value || '').trim();
    if (!body) {
      warn.textContent = 'Please describe the change before sending.';
      warn.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';

    function send(screenshots) {
      api('POST', '/api/request-forms/public/portal/change-request', {
        deliverableId: d.id,
        portalToken: currentRoute().token || portalToken,
        body: body,
        screenshots: screenshots,
      }).then(function (res) {
        if (res.ok) {
          render(thankYouState('Your change request has been sent. We will be in touch.'));
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

  // ════════════════════════════════════════════════════════════════
  // VIDEO APPROVAL CARD  (type === 'video')
  // ════════════════════════════════════════════════════════════════
  // The video department sends the finished cut to the client at status
  // 'sent_for_approval'. The deliverable carries the upload in
  // metadata.video_upload = { url, name, mimeType }. This card mirrors the
  // website-design whole-row approval card: it shows the title/client/month,
  // an embedded HTML5 <video controls> player, and Approve / Request-changes
  // (3-round cap). The change-request reuses the same whole-deliverable
  // helpers as the website-design card (no postIndex):
  //   • Approve         → POST /approve { deliverableId }   (→ approved)
  //   • Request changes → POST /change-request { deliverableId, body,
  //                          screenshots }                  (→ changes_requested)
  function renderVideoCard(portalToken, d) {
    var meta = metaOf(d);
    var status = d.status || '';
    // Once approved (or already moved past sent_for_approval) the row shows a
    // read-only approved state. changes_requested means the team is re-editing,
    // so it won't appear in the approvals list at all.
    var approved = status === 'approved' || status === 'complete' || !!d.approvedAt || !!d.approval_date;

    var head = el('div', { class: 'cp-card-head' }, [
      el('div', {}, [
        el('h2', { class: 'cp-card-title', text: d.title || d.name || 'Video' }),
        el('div', { class: 'cp-wd-round', text: 'Video approval' }),
      ]),
      approved
        ? el('span', { class: 'cp-badge cp-badge-approved', text: 'Approved' })
        : el('span', { class: 'cp-badge cp-badge-action', text: 'Approval required' }),
    ]);

    var card = el('div', { class: 'cp-card ' + (approved ? 'cp-card-approved' : 'cp-card-action') }, [head]);

    // Client + month context line (mirrors the other cards).
    var clientName = d.clientName || d.client_name || d.client || (d.client && d.client.name);
    var month = d.deliveryMonth || d.delivery_month || '';
    var ctxBits = [];
    if (clientName) ctxBits.push('Client: ' + clientName);
    if (month) ctxBits.push(formatMonth(month));
    if (ctxBits.length) {
      card.appendChild(el('p', { class: 'cp-note', text: ctxBits.join('  ·  ') }));
    }

    if (d.approvedAt || d.approval_date) {
      card.appendChild(el('p', { class: 'cp-note', text: 'Approved on ' + formatDate(d.approvedAt || d.approval_date) }));
    }

    // ── Player ────────────────────────────────────────────────────
    // Defensive: if no upload yet, show a notice instead of a broken player.
    var upload = videoUploadOf(d);
    if (!upload) {
      card.appendChild(el('div', { class: 'cp-video-missing' }, [
        el('div', { class: 'cp-video-missing-icon', text: '🎬' }),
        el('p', { class: 'cp-note', text: 'The video is not yet uploaded. Please check back shortly.' }),
      ]));
    } else {
      var src = assetUrl(upload.url); // relative /uploads/… → same-origin via portal proxy
      var sourceAttrs = { src: src };
      if (upload.mimeType) sourceAttrs.type = upload.mimeType;
      var video = el('video', {
        class: 'cp-video-player',
        controls: true,
        preload: 'metadata',
        playsinline: true,
        controlslist: 'nodownload',
      }, [
        el('source', sourceAttrs),
        document.createTextNode('Your browser cannot play this video. '),
      ]);
      // Fallback open-in-new-tab link (also lets the client see it if the inline
      // codec is unsupported).
      var openLink = el('a', { class: 'cp-btn', href: src, target: '_blank', rel: 'noopener', text: 'Open video in new tab' });
      card.appendChild(el('div', { class: 'cp-video-wrap' }, [video]));
      if (upload.name) {
        card.appendChild(el('div', { class: 'cp-wd-filelabel', text: upload.name }));
      }
      card.appendChild(el('div', { class: 'cp-wd-fileactions' }, [openLink]));
    }

    // ── Actions ───────────────────────────────────────────────────
    if (approved) {
      card.appendChild(el('div', { class: 'cp-wd-approved-note' }, [
        el('span', { class: 'cp-post-approved-tag', text: '✓ Approved' }),
      ]));
      return card;
    }

    // No actions until there's something to review.
    if (!upload) return card;

    var roundsUsed = parseInt(meta.changeRequestRoundsUsed, 10) || 0;
    var roundsLeft = Math.max(0, 3 - roundsUsed);

    var warn = el('div', { class: 'cp-warn', hidden: true });
    var crBox = el('textarea', { class: 'cp-textarea', placeholder: 'Describe the changes you would like…' });
    var crWrap = el('div', { class: 'cp-wd-cr', hidden: true }, [
      el('div', { class: 'cp-editor-label', text: 'Request changes' }),
      crBox,
    ]);

    // Optional screenshot upload (mirrors the website-design change-request).
    var fileInput = el('input', { class: 'cp-input', type: 'file', accept: 'image/*' });
    crWrap.appendChild(el('div', { class: 'cp-editor-label', text: 'Attach a screenshot (optional)' }));
    crWrap.appendChild(fileInput);
    crWrap.appendChild(warn);

    var actions = el('div', { class: 'cp-actions' });

    var approveBtn = el('button', { class: 'cp-btn cp-btn-approve', type: 'button', text: 'Approve' });
    approveBtn.addEventListener('click', function () {
      // Whole-deliverable approve — identical body to website-design.
      approveWebsiteDesign(portalToken, d, approveBtn);
    });

    var changeBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Request changes' });
    var sendBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Send change request', hidden: true });

    if (roundsLeft <= 0) {
      changeBtn.disabled = true;
      changeBtn.textContent = 'No change rounds left';
    }

    changeBtn.addEventListener('click', function () {
      crWrap.hidden = false;
      changeBtn.hidden = true;
      sendBtn.hidden = false;
      crBox.focus();
    });

    sendBtn.addEventListener('click', function () {
      // Whole-deliverable change request — identical to website-design.
      submitWebsiteDesignChange(portalToken, d, crBox, fileInput, sendBtn, warn);
    });

    actions.appendChild(approveBtn);
    actions.appendChild(changeBtn);
    actions.appendChild(sendBtn);
    card.appendChild(actions);

    if (roundsUsed > 0) {
      card.appendChild(el('p', { class: 'cp-note', text: roundsLeft + ' change round' + (roundsLeft === 1 ? '' : 's') + ' left.' }));
    }

    card.appendChild(crWrap);
    return card;
  }

  // ════════════════════════════════════════════════════════════════
  // AGRI4ALL PRODUCT-UPLOADS DESIGN APPROVAL CARD
  //   (type === 'agri4all-product-uploads')
  // ════════════════════════════════════════════════════════════════
  // The CRM sends these at status 'sent_for_approval' (design approval).
  // Mirrors the website-design card: previews the attached design image(s)
  // from the deliverable's assets, then offers whole-deliverable
  // Approve / Request-changes (no postIndex/size). Design images are read
  // from `d.assets` (same shape the website-design payload exposes) with a
  // fallback to any image fields the row itself provides.
  function renderAgri4allProductCard(portalToken, d) {
    var meta = metaOf(d);
    var status = d.status || '';
    var approved = status === 'approved' || !!d.approvedAt || !!d.approval_date;

    var head = el('div', { class: 'cp-card-head' }, [
      el('div', {}, [
        el('h2', { class: 'cp-card-title', text: d.title || d.name || 'Product Design' }),
        el('div', { class: 'cp-wd-round', text: 'Design approval' }),
      ]),
      approved
        ? el('span', { class: 'cp-badge cp-badge-approved', text: 'Approved' })
        : el('span', { class: 'cp-badge cp-badge-action', text: 'Approval required' }),
    ]);

    var card = el('div', { class: 'cp-card ' + (approved ? 'cp-card-approved' : 'cp-card-action') }, [head]);

    // Client line (the deliverable's client name, if the payload carries one).
    var clientName = d.clientName || d.client_name || d.client || (d.client && d.client.name);
    if (clientName) {
      card.appendChild(el('p', { class: 'cp-note', text: 'Client: ' + clientName }));
    }

    if (d.approvedAt || d.approval_date) {
      card.appendChild(el('p', { class: 'cp-note', text: 'Approved on ' + formatDate(d.approvedAt || d.approval_date) }));
    }

    // ── Design image previews ─────────────────────────────────────
    // Prefer the assets array (same as website-design). If absent, fall
    // back to whatever image fields the row exposes.
    var assets = Array.isArray(d.assets) ? d.assets : [];
    var imageAssets = assets.filter(function (a) {
      return a && a.url && ((a.mimeType && a.mimeType.indexOf('image/') === 0) || looksLikeImage(a.url));
    });

    var imageUrls = imageAssets.map(function (a) { return assetUrl(a.url); });

    if (!imageUrls.length) {
      // Fallback: design-image / generic image fields on the row or meta.
      var raw = []
        .concat(d.designImages || d.design_images || meta.designImages || meta.design_images || [])
        .concat(d.images || meta.images || [])
        .concat(d.imageUrl ? [d.imageUrl] : [])
        .concat(d.image_url ? [d.image_url] : [])
        .concat(d.image ? [d.image] : []);
      raw.forEach(function (it) {
        if (!it) return;
        var u = typeof it === 'string' ? it : (it.url || it.src || '');
        if (u) imageUrls.push(assetUrl(u));
      });
    }

    if (!imageUrls.length) {
      card.appendChild(el('p', { class: 'cp-note', text: 'No designs to preview yet.' }));
    } else {
      var grid = el('div', { class: 'cp-wd-grid' });
      imageUrls.forEach(function (full) {
        var thumb = el('img', {
          class: 'cp-wd-thumb',
          src: full,
          alt: 'Design preview',
          loading: 'lazy',
        });
        thumb.addEventListener('click', function () {
          openImageLightbox(imageUrls, imageUrls.indexOf(full));
        });
        grid.appendChild(thumb);
      });
      card.appendChild(grid);
    }

    // ── Actions ───────────────────────────────────────────────────
    if (approved) {
      card.appendChild(el('div', { class: 'cp-wd-approved-note' }, [
        el('span', { class: 'cp-post-approved-tag', text: '✓ Approved' }),
      ]));
      return card;
    }

    var warn = el('div', { class: 'cp-warn', hidden: true });
    var crBox = el('textarea', { class: 'cp-textarea', placeholder: 'Describe the changes you would like…' });
    var crWrap = el('div', { class: 'cp-wd-cr', hidden: true }, [
      el('div', { class: 'cp-editor-label', text: 'Request changes' }),
      crBox,
    ]);

    // Optional screenshot upload (mirrors the website-design pattern).
    var fileInput = el('input', { class: 'cp-input', type: 'file', accept: 'image/*' });
    crWrap.appendChild(el('div', { class: 'cp-editor-label', text: 'Attach a screenshot (optional)' }));
    crWrap.appendChild(fileInput);
    crWrap.appendChild(warn);

    var actions = el('div', { class: 'cp-actions' });

    var approveBtn = el('button', { class: 'cp-btn cp-btn-approve', type: 'button', text: 'Approve' });
    approveBtn.addEventListener('click', function () {
      approveAgri4allProduct(portalToken, d, approveBtn);
    });

    var changeBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Request changes' });
    var sendBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Send change request', hidden: true });

    changeBtn.addEventListener('click', function () {
      crWrap.hidden = false;
      changeBtn.hidden = true;
      sendBtn.hidden = false;
      crBox.focus();
    });

    sendBtn.addEventListener('click', function () {
      submitAgri4allProductChange(portalToken, d, crBox, fileInput, sendBtn, warn);
    });

    actions.appendChild(approveBtn);
    actions.appendChild(changeBtn);
    actions.appendChild(sendBtn);
    card.appendChild(actions);

    card.appendChild(crWrap);
    return card;
  }

  // Whole-deliverable approve (no postIndex) — same helper shape as the
  // website-design card.
  function approveAgri4allProduct(portalToken, d, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
    api('POST', '/api/request-forms/public/portal/approve', {
      deliverableId: d.id,
      portalToken: currentRoute().token || portalToken,
    }).then(function (res) {
      if (res.ok) {
        loadApprovals(currentRoute().token || portalToken);
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

  // Change request (textarea + optional screenshot) — handles 409 limit.
  function submitAgri4allProductChange(portalToken, d, crBox, fileInput, btn, warn) {
    warn.hidden = true;
    var body = (crBox.value || '').trim();
    if (!body) {
      warn.textContent = 'Please describe the change before sending.';
      warn.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';

    function send(screenshots) {
      api('POST', '/api/request-forms/public/portal/change-request', {
        deliverableId: d.id,
        portalToken: currentRoute().token || portalToken,
        body: body,
        screenshots: screenshots,
      }).then(function (res) {
        if (res.ok) {
          render(thankYouState('Your change request has been sent. We will be in touch.'));
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

  // ════════════════════════════════════════════════════════════════
  // AGRI4ALL PRODUCT-UPLOADS LIVE-LINKS APPROVAL CARD
  //   (type === 'agri4all-product-uploads', status === 'agri4all-links')
  // ════════════════════════════════════════════════════════════════
  // The SECOND approval round. After the design is signed off, the team
  // publishes the product to Agri4All per country; the CRM then returns the
  // row at status 'agri4all-links' carrying a `previewLinks` array:
  //   [{ country, public_url, agri4all_status }]
  // This card shows the live preview links (one row per country) instead of
  // a design image, then offers the same whole-deliverable Approve /
  // Request-changes flow (description-level, with 409 limit handling).
  function renderAgri4allLinksCard(portalToken, d) {
    var meta = metaOf(d);
    var status = d.status || '';
    var approved = status === 'approved' || !!d.approvedAt || !!d.approval_date;

    var head = el('div', { class: 'cp-card-head' }, [
      el('div', {}, [
        el('h2', { class: 'cp-card-title', text: d.title || d.name || 'Product Listing' }),
        el('div', { class: 'cp-wd-round', text: 'Live listing approval' }),
      ]),
      approved
        ? el('span', { class: 'cp-badge cp-badge-approved', text: 'Approved' })
        : el('span', { class: 'cp-badge cp-badge-action', text: 'Approval required' }),
    ]);

    var card = el('div', { class: 'cp-card ' + (approved ? 'cp-card-approved' : 'cp-card-action') }, [head]);

    // Client line (the deliverable's client name, if the payload carries one).
    var clientName = d.clientName || d.client_name || d.client || (d.client && d.client.name);
    if (clientName) {
      card.appendChild(el('p', { class: 'cp-note', text: 'Client: ' + clientName }));
    }

    if (d.approvedAt || d.approval_date) {
      card.appendChild(el('p', { class: 'cp-note', text: 'Approved on ' + formatDate(d.approvedAt || d.approval_date) }));
    }

    // ── Live preview links (one row per country) ──────────────────
    var links = Array.isArray(d.previewLinks) ? d.previewLinks
      : (Array.isArray(meta.previewLinks) ? meta.previewLinks : []);

    if (!links.length) {
      card.appendChild(el('p', { class: 'cp-note', text: 'No live listings to review yet.' }));
    } else {
      var list = el('div', { class: 'cp-links' });
      links.forEach(function (lk) {
        if (!lk) return;
        var country = lk.country || lk.countryCode || lk.country_code || '';
        var url = lk.public_url || lk.publicUrl || lk.url || '';
        var lstatus = lk.agri4all_status || lk.agri4allStatus || lk.status || '';
        var statusApproved = isApprovedStatus(lstatus);

        var row = el('div', { class: 'cp-link-row' }, [
          el('span', { class: 'cp-link-country', text: country || '—' }),
          url
            ? el('a', {
                class: 'cp-link-live', href: assetUrl(url),
                target: '_blank', rel: 'noopener', text: 'View live listing',
              })
            : el('span', { class: 'cp-note', text: 'No link yet' }),
          el('span', {
            class: 'cp-badge ' + (statusApproved ? 'cp-badge-approved' : 'cp-badge-action') + ' cp-badge-sm',
            text: lstatus || 'pending',
          }),
        ]);
        list.appendChild(row);
      });
      card.appendChild(list);
    }

    // ── Actions ───────────────────────────────────────────────────
    if (approved) {
      card.appendChild(el('div', { class: 'cp-wd-approved-note' }, [
        el('span', { class: 'cp-post-approved-tag', text: '✓ Approved' }),
      ]));
      return card;
    }

    var warn = el('div', { class: 'cp-warn', hidden: true });
    var crBox = el('textarea', { class: 'cp-textarea', placeholder: 'Describe the changes you would like…' });
    var crWrap = el('div', { class: 'cp-wd-cr', hidden: true }, [
      el('div', { class: 'cp-editor-label', text: 'Request changes' }),
      crBox,
    ]);

    // Optional screenshot upload (mirrors the design-approval pattern).
    var fileInput = el('input', { class: 'cp-input', type: 'file', accept: 'image/*' });
    crWrap.appendChild(el('div', { class: 'cp-editor-label', text: 'Attach a screenshot (optional)' }));
    crWrap.appendChild(fileInput);
    crWrap.appendChild(warn);

    var actions = el('div', { class: 'cp-actions' });

    var approveBtn = el('button', { class: 'cp-btn cp-btn-approve', type: 'button', text: 'Approve' });
    approveBtn.addEventListener('click', function () {
      // Same whole-deliverable approve helper as the other approve cards.
      approveAgri4allProduct(portalToken, d, approveBtn);
    });

    var changeBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Request changes' });
    var sendBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Send change request', hidden: true });

    changeBtn.addEventListener('click', function () {
      crWrap.hidden = false;
      changeBtn.hidden = true;
      sendBtn.hidden = false;
      crBox.focus();
    });

    sendBtn.addEventListener('click', function () {
      // Description-level change request (no postIndex) — handles the 409 limit.
      submitAgri4allProductChange(portalToken, d, crBox, fileInput, sendBtn, warn);
    });

    actions.appendChild(approveBtn);
    actions.appendChild(changeBtn);
    actions.appendChild(sendBtn);
    card.appendChild(actions);

    card.appendChild(crWrap);
    return card;
  }

  // ════════════════════════════════════════════════════════════════
  // MAGAZINE APPROVAL CARD  (type === 'magazine')
  // ════════════════════════════════════════════════════════════════
  // Print-ad / print-article rows. The publication may already be resolved
  // ('Print Ad' or 'Print Article') — shown as a static, read-only pill — or
  // still undecided ('Print Ad / Print Article'), in which case the client
  // chooses one via a two-option toggle (no default selected) before the row
  // can be approved. Design previews come from metadata.items[].images, with a
  // fallback to the metadata.posts media. Approve posts the chosen publication
  // (no postIndex), then refreshes the list.
  function renderMagazineCard(portalToken, d) {
    var meta = metaOf(d);
    var status = d.status || '';
    var approved = status === 'approved' || !!d.approvedAt || !!d.approval_date;

    var publication = meta.publication || '';
    var resolved = publication === 'Print Ad' || publication === 'Print Article';
    var undecided = !resolved;

    var head = el('div', { class: 'cp-card-head' }, [
      el('div', {}, [
        el('h2', { class: 'cp-card-title', text: d.title || d.name || 'Magazine' }),
        el('div', { class: 'cp-wd-round', text: 'Magazine approval' }),
      ]),
      approved
        ? el('span', { class: 'cp-badge cp-badge-approved', text: 'Approved' })
        : el('span', { class: 'cp-badge cp-badge-action', text: 'Approval required' }),
    ]);

    var card = el('div', { class: 'cp-card ' + (approved ? 'cp-card-approved' : 'cp-card-action') }, [head]);

    // Client + month context line (mirrors the video / agri4all cards).
    var clientName = d.clientName || d.client_name || d.client || (d.client && d.client.name);
    var month = d.deliveryMonth || d.delivery_month || '';
    var ctxBits = [];
    if (clientName) ctxBits.push('Client: ' + clientName);
    if (month) ctxBits.push(formatMonth(month));
    if (ctxBits.length) {
      card.appendChild(el('p', { class: 'cp-note', text: ctxBits.join('  ·  ') }));
    }

    if (d.approvedAt || d.approval_date) {
      card.appendChild(el('p', { class: 'cp-note', text: 'Approved on ' + formatDate(d.approvedAt || d.approval_date) }));
    }

    // ── Design previews ───────────────────────────────────────────
    var imageUrls = magazineDesignImages(d);
    if (!imageUrls.length) {
      card.appendChild(el('p', { class: 'cp-note', text: 'No designs to preview yet.' }));
    } else {
      var grid = el('div', { class: 'cp-wd-grid' });
      imageUrls.forEach(function (full) {
        var thumb = el('img', {
          class: 'cp-wd-thumb',
          src: full,
          alt: 'Design preview',
          loading: 'lazy',
        });
        thumb.addEventListener('click', function () {
          openImageLightbox(imageUrls, imageUrls.indexOf(full));
        });
        grid.appendChild(thumb);
      });
      card.appendChild(grid);
    }

    // ── Publication pill / toggle ─────────────────────────────────
    // chosenPublication is the value sent on approve. Resolved rows carry it
    // straight through; undecided rows start null until the client picks.
    var chosenPublication = resolved ? publication : null;
    var approveBtn = el('button', { class: 'cp-btn cp-btn-approve', type: 'button', text: 'Approve' });

    var pubWrap = el('div', { class: 'cp-pub' });
    pubWrap.appendChild(el('div', { class: 'cp-editor-label', text: 'Publication' }));

    if (resolved) {
      // Static, read-only pill with the resolved label.
      pubWrap.appendChild(el('span', { class: 'cp-pill', text: publication }));
    } else {
      // Selectable two-option toggle, nothing selected by default.
      var toggle = el('div', { class: 'cp-pill-toggle' });
      ['Print Ad', 'Print Article'].forEach(function (opt) {
        var optBtn = el('button', { class: 'cp-pill-option', type: 'button', text: opt });
        optBtn.addEventListener('click', function () {
          chosenPublication = opt;
          Array.prototype.slice.call(toggle.querySelectorAll('.cp-pill-option')).forEach(function (b) {
            b.classList.toggle('selected', b === optBtn);
          });
          if (!approved) approveBtn.disabled = false;
        });
        toggle.appendChild(optBtn);
      });
      pubWrap.appendChild(toggle);
      pubWrap.appendChild(el('div', { class: 'cp-pill-hint', text: 'Required: choose one before approving.' }));
    }
    card.appendChild(pubWrap);

    // ── Actions ───────────────────────────────────────────────────
    if (approved) {
      card.appendChild(el('div', { class: 'cp-wd-approved-note' }, [
        el('span', { class: 'cp-post-approved-tag', text: '✓ Approved' }),
      ]));
      return card;
    }

    // Keep Approve disabled until an undecided row's publication is chosen.
    if (undecided) approveBtn.disabled = true;
    approveBtn.addEventListener('click', function () {
      if (undecided && !chosenPublication) return;
      approveMagazine(portalToken, d, chosenPublication, approveBtn);
    });

    card.appendChild(el('div', { class: 'cp-actions' }, [approveBtn]));
    return card;
  }

  // Collect design preview image URLs for a magazine deliverable: prefer the
  // metadata.items[].images arrays; fall back to the metadata.posts media.
  function magazineDesignImages(d) {
    var meta = metaOf(d);
    var urls = [];
    var items = Array.isArray(meta.items) ? meta.items : [];
    items.forEach(function (it) {
      var imgs = it && Array.isArray(it.images) ? it.images : (it && it.image ? [it.image] : []);
      imgs.forEach(function (u) { if (u) urls.push(assetUrl(u)); });
    });
    if (!urls.length) {
      mediaPosts(d).forEach(function (mp) {
        mp.images.forEach(function (u) { if (u) urls.push(assetUrl(u)); });
      });
    }
    return urls;
  }

  // Whole-deliverable approve for a magazine row. Sends the chosen publication
  // only when present (undecided rows MUST pass one; resolved rows pass their
  // existing value), then refreshes the approvals list.
  function approveMagazine(portalToken, d, publication, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
    var body = { deliverableId: d.id, portalToken: currentRoute().token || portalToken };
    if (publication) body.publication = publication;
    api('POST', '/api/request-forms/public/portal/approve', body).then(function (res) {
      if (res.ok) {
        loadApprovals(currentRoute().token || portalToken);
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

  // ════════════════════════════════════════════════════════════════
  // DESIGN-COLLATERAL APPROVAL CARD  (item.kind === 'collateral')
  // ════════════════════════════════════════════════════════════════
  // Unlike the other cards (which hard-code their layout per deliverable
  // type), a collateral row carries its OWN client-facing layout in
  // item.approvalLayout — an ordered list of blocks the CRM builder produced:
  //   { id, kind:'section', title }
  //   { id, kind:'card', cardType, title, config }
  // cardType ∈ 'media_gallery' | 'description' | 'item_details' | 'approval_actions'.
  // Media come from metadata.files = [{ name, url }]; notes/description from
  // metadata.notes / metadata.description. When approvalLayout is empty we fall
  // back to a sensible DEFAULT (item details → media gallery → approval actions).
  //
  // The same renderer serves the live approvals list AND the read-only /preview
  // route: pass opts.preview to disable Approve / Request-changes.
  function renderCollateralCard(portalToken, item, opts) {
    opts = opts || {};
    var preview = !!opts.preview;
    var meta = metaOf(item);
    var portalState = meta.portalState || meta.portal_state || '';
    var approved = portalState === 'approved' || item.currentStatus === 'approved' || item.status === 'approved';

    var head = el('div', { class: 'cp-card-head' }, [
      el('div', {}, [
        el('h2', { class: 'cp-card-title', text: item.name || item.title || 'Design Collateral' }),
        el('div', { class: 'cp-wd-round', text: 'Collateral approval' }),
      ]),
      approved
        ? el('span', { class: 'cp-badge cp-badge-approved', text: 'Approved' })
        : el('span', { class: 'cp-badge cp-badge-action', text: 'Approval required' }),
    ]);

    var card = el('div', { class: 'cp-card ' + (approved ? 'cp-card-approved' : 'cp-card-action') }, [head]);

    // Ordered blocks from the builder; fall back to a default layout.
    var layout = Array.isArray(item.approvalLayout) ? item.approvalLayout : [];
    if (!layout.length) {
      layout = [
        { kind: 'card', cardType: 'item_details', title: 'Details' },
        { kind: 'card', cardType: 'media_gallery', title: 'Media' },
        { kind: 'card', cardType: 'approval_actions', title: '' },
      ];
    }

    var ctx = { preview: preview, approved: approved };
    layout.forEach(function (block) {
      var node = renderCollateralBlock(portalToken, item, block, ctx);
      if (node) card.appendChild(node);
    });

    return card;
  }

  function renderCollateralBlock(portalToken, item, block, ctx) {
    if (!block) return null;
    if (block.kind === 'section') {
      return el('div', { class: 'cp-coll-section' }, [
        el('h3', { class: 'cp-coll-section-title', text: block.title || '' }),
      ]);
    }
    if (block.kind === 'card') {
      switch (block.cardType) {
        case 'media_gallery': return renderCollateralMedia(item, block.title);
        case 'description': return renderCollateralDescription(item, block.title);
        case 'item_details': return renderCollateralDetails(item, block.title);
        case 'approval_actions': return renderCollateralActions(portalToken, item, ctx);
        default: return null;
      }
    }
    return null;
  }

  // Small helper: an optional card sub-title above a collateral block.
  function collCardTitle(title) {
    return title ? el('div', { class: 'cp-coll-card-title', text: title }) : null;
  }

  // Media gallery — images (lightbox), videos (player), PDFs (iframe), other
  // files (open button). Reads metadata.files = [{ name, url }].
  function renderCollateralMedia(item, title) {
    var meta = metaOf(item);
    var files = Array.isArray(meta.files) ? meta.files.filter(function (f) { return f && f.url; }) : [];
    var wrap = el('div', { class: 'cp-coll-media' });
    var t = collCardTitle(title);
    if (t) wrap.appendChild(t);

    if (!files.length) {
      wrap.appendChild(el('p', { class: 'cp-note', text: 'No media to preview yet.' }));
      return wrap;
    }

    var images = files.filter(function (f) { return looksLikeImage(f.url); });
    var videos = files.filter(function (f) { return looksLikeVideo(f.url); });
    var pdfs = files.filter(function (f) { return looksLikePdf(f.url); });
    var others = files.filter(function (f) {
      return images.indexOf(f) === -1 && videos.indexOf(f) === -1 && pdfs.indexOf(f) === -1;
    });

    // Images → thumbnail grid + lightbox.
    if (images.length) {
      var imageUrls = images.map(function (f) { return assetUrl(f.url); });
      var grid = el('div', { class: 'cp-wd-grid' });
      images.forEach(function (f) {
        var full = assetUrl(f.url);
        var thumb = el('img', {
          class: 'cp-wd-thumb', src: full, alt: f.name || 'Media preview',
          loading: 'lazy', title: f.name || '',
        });
        thumb.addEventListener('click', function () {
          openImageLightbox(imageUrls, imageUrls.indexOf(full));
        });
        grid.appendChild(thumb);
      });
      wrap.appendChild(grid);
    }

    // Videos → inline HTML5 player + open link.
    videos.forEach(function (f) {
      var src = assetUrl(f.url);
      var video = el('video', {
        class: 'cp-video-player', controls: true, preload: 'metadata',
        playsinline: true, controlslist: 'nodownload',
      }, [
        el('source', { src: src }),
        document.createTextNode('Your browser cannot play this video. '),
      ]);
      wrap.appendChild(el('div', { class: 'cp-video-wrap' }, [video]));
      if (f.name) wrap.appendChild(el('div', { class: 'cp-wd-filelabel', text: f.name }));
      wrap.appendChild(el('div', { class: 'cp-wd-fileactions' }, [
        el('a', { class: 'cp-btn', href: src, target: '_blank', rel: 'noopener', text: 'Open video in new tab' }),
      ]));
    });

    // PDFs → inline iframe + open button.
    pdfs.forEach(function (f) {
      var url = assetUrl(f.url);
      var block = el('div', { class: 'cp-wd-pdf' });
      block.appendChild(el('div', { class: 'cp-wd-filelabel', text: f.name || 'PDF' }));
      block.appendChild(el('iframe', { class: 'cp-wd-pdf-frame', src: url, title: f.name || 'PDF' }));
      block.appendChild(el('div', { class: 'cp-wd-fileactions' }, [
        el('a', { class: 'cp-btn', href: url, target: '_blank', rel: 'noopener', text: 'Open PDF' }),
      ]));
      wrap.appendChild(block);
    });

    // Other files → open button.
    if (others.length) {
      var fileRow = el('div', { class: 'cp-wd-fileactions' });
      others.forEach(function (f) {
        fileRow.appendChild(el('a', {
          class: 'cp-btn', href: assetUrl(f.url), target: '_blank', rel: 'noopener',
          text: f.name ? ('Open ' + f.name) : 'Open file',
        }));
      });
      wrap.appendChild(fileRow);
    }

    return wrap;
  }

  // Description — notes / description text from the metadata.
  function renderCollateralDescription(item, title) {
    var meta = metaOf(item);
    var text = meta.notes || meta.description || '';
    var wrap = el('div', { class: 'cp-coll-desc' });
    var t = collCardTitle(title);
    if (t) wrap.appendChild(t);
    if (!text) {
      wrap.appendChild(el('p', { class: 'cp-note', text: 'No description provided.' }));
    } else {
      // Render as plain text (preserving line breaks via CSS white-space).
      wrap.appendChild(el('div', { class: 'cp-coll-desc-body', text: String(text) }));
    }
    return wrap;
  }

  // Item details — a small key/value list built from the row's own fields.
  function renderCollateralDetails(item, title) {
    var wrap = el('div', { class: 'cp-coll-details' });
    var t = collCardTitle(title);
    if (t) wrap.appendChild(t);

    var clientName = item.clientName || item.client_name || (item.client && item.client.name) || '';
    var rows = [
      ['Name', item.name || item.title || ''],
      ['Type', item.type || ''],
      ['Client', clientName],
      ['Status', item.currentStatus || item.status || ''],
    ].filter(function (r) { return r[1]; });

    if (!rows.length) {
      wrap.appendChild(el('p', { class: 'cp-note', text: 'No details available.' }));
      return wrap;
    }

    var list = el('dl', { class: 'cp-coll-dl' });
    rows.forEach(function (r) {
      list.appendChild(el('dt', { class: 'cp-coll-dt', text: r[0] }));
      list.appendChild(el('dd', { class: 'cp-coll-dd', text: String(r[1]) }));
    });
    wrap.appendChild(list);
    return wrap;
  }

  // Approval actions — Approve + Request-changes (whole-collateral), or a
  // disabled read-only pair in preview mode. Already-approved rows show a tag.
  function renderCollateralActions(portalToken, item, ctx) {
    ctx = ctx || {};
    var preview = !!ctx.preview;
    var box = el('div', { class: 'cp-coll-actions' });

    if (ctx.approved) {
      box.appendChild(el('div', { class: 'cp-wd-approved-note' }, [
        el('span', { class: 'cp-post-approved-tag', text: '✓ Approved' }),
      ]));
      return box;
    }

    var warn = el('div', { class: 'cp-warn', hidden: true });
    var crBox = el('textarea', { class: 'cp-textarea', placeholder: 'Describe the changes you would like…' });
    var crWrap = el('div', { class: 'cp-wd-cr', hidden: true }, [
      el('div', { class: 'cp-editor-label', text: 'Request changes' }),
      crBox,
    ]);
    var fileInput = el('input', { class: 'cp-input', type: 'file', accept: 'image/*' });
    crWrap.appendChild(el('div', { class: 'cp-editor-label', text: 'Attach a screenshot (optional)' }));
    crWrap.appendChild(fileInput);
    crWrap.appendChild(warn);

    var actions = el('div', { class: 'cp-actions' });
    var approveBtn = el('button', { class: 'cp-btn cp-btn-approve', type: 'button', text: 'Approve' });
    var changeBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Request changes' });
    var sendBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Send change request', hidden: true });

    if (preview) {
      // Read-only: clients can't act from the CRM preview.
      approveBtn.disabled = true;
      changeBtn.disabled = true;
      actions.appendChild(approveBtn);
      actions.appendChild(changeBtn);
      box.appendChild(actions);
      box.appendChild(el('p', { class: 'cp-note', text: "Preview — clients can't act here." }));
      return box;
    }

    approveBtn.addEventListener('click', function () {
      approveCollateral(portalToken, item.id, approveBtn);
    });
    changeBtn.addEventListener('click', function () {
      crWrap.hidden = false;
      changeBtn.hidden = true;
      sendBtn.hidden = false;
      crBox.focus();
    });
    sendBtn.addEventListener('click', function () {
      submitCollateralChange(portalToken, item.id, crBox, fileInput, sendBtn, warn);
    });

    actions.appendChild(approveBtn);
    actions.appendChild(changeBtn);
    actions.appendChild(sendBtn);
    box.appendChild(actions);
    box.appendChild(crWrap);
    return box;
  }

  // Whole-collateral approve → POST /portal/approve { kind:'collateral',
  // designCollateralId }. Refreshes the approvals list on success.
  function approveCollateral(portalToken, designCollateralId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
    api('POST', '/api/request-forms/public/portal/approve', {
      kind: 'collateral',
      designCollateralId: designCollateralId,
      portalToken: currentRoute().token || portalToken,
    }).then(function (res) {
      if (res.ok) {
        loadApprovals(currentRoute().token || portalToken);
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

  // Whole-collateral change request → POST /portal/change-request
  // { kind:'collateral', designCollateralId, body, screenshots }. Handles the
  // 409 no-rounds-left case like the other change-request helpers.
  function submitCollateralChange(portalToken, designCollateralId, crBox, fileInput, btn, warn) {
    warn.hidden = true;
    var body = (crBox.value || '').trim();
    if (!body) {
      warn.textContent = 'Please describe the change before sending.';
      warn.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';

    function send(screenshots) {
      api('POST', '/api/request-forms/public/portal/change-request', {
        kind: 'collateral',
        designCollateralId: designCollateralId,
        portalToken: currentRoute().token || portalToken,
        body: body,
        screenshots: screenshots,
      }).then(function (res) {
        if (res.ok) {
          render(thankYouState('Your change request has been sent. We will be in touch.'));
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

  // ── Read-only collateral preview  /preview/:portalToken/:itemId ───────────
  // The CRM's "Preview" button opens this to show exactly what a client sees,
  // with Approve / Request-changes disabled. The upstream CRM preview endpoint is
  // client-scoped (guards against enumerating other clients' collateral by id), so
  // it requires the client's portal_token — the CRM passes it as the first path
  // segment. A legacy tokenless link can't be served and gets a clear notice.
  function loadPreview(portalToken, itemId) {
    render(el('div', { class: 'cp-loading', text: 'Loading preview…' }));
    if (!portalToken) {
      return render(errorState('This preview link is outdated. Please reopen Preview from the CRM.'));
    }
    api('GET', '/api/request-forms/public/portal/' + encodeURIComponent(portalToken)
        + '/preview/collateral/' + encodeURIComponent(itemId)).then(function (r) {
      if (!r.ok || !r.data) {
        return render(errorState('This preview could not be found.'));
      }
      var item = r.data;
      if (!item.kind) item.kind = 'collateral';
      var wrap = el('div', {}, [
        el('div', { class: 'cp-preview-banner', text: "Preview — clients can't act here." }),
        el('h1', { class: 'cp-h1', text: 'Content Approval Preview' }),
        el('p', { class: 'cp-sub', text: 'This is exactly how the client sees this item.' }),
      ]);
      wrap.appendChild(renderCollateralCard(null, item, { preview: true }));
      render(wrap);
    }).catch(function () {
      render(errorState('Could not load the preview. Please try again.'));
    });
  }

  // Simple image lightbox (reuses the overlay shell). Pages through `urls`.
  function openImageLightbox(urls, startIndex) {
    var list = (urls || []).filter(Boolean);
    if (!list.length) return;
    var idx = startIndex >= 0 && startIndex < list.length ? startIndex : 0;

    var img = el('img', { class: 'cp-lightbox-img', src: list[idx], alt: 'Design preview' });
    var counter = el('div', { class: 'cp-lightbox-counter' });
    function refresh() {
      img.src = list[idx];
      counter.textContent = (idx + 1) + ' / ' + list.length;
    }

    var closeBtn = el('button', { class: 'cp-modal-close', type: 'button', html: '&times;' });
    closeBtn.addEventListener('click', closeOverlay);

    var box = el('div', { class: 'cp-lightbox' }, [closeBtn, img]);

    if (list.length > 1) {
      var prev = el('button', { class: 'cp-lightbox-nav cp-lightbox-prev', type: 'button', html: '&#8249;' });
      var next = el('button', { class: 'cp-lightbox-nav cp-lightbox-next', type: 'button', html: '&#8250;' });
      prev.addEventListener('click', function () { idx = (idx - 1 + list.length) % list.length; refresh(); });
      next.addEventListener('click', function () { idx = (idx + 1) % list.length; refresh(); });
      box.appendChild(prev);
      box.appendChild(next);
      box.appendChild(counter);
    }

    refresh();
    openOverlay(box);
  }

  // ── Detail / change-request view (modal) ─────────────────────────
  function openDetail(portalToken, deliverable, card) {
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
      approvePost(portalToken, deliverable, card, null);
    });
    var sendBtn = el('button', { class: 'cp-btn cp-btn-primary', type: 'button', text: 'Send change request' });
    sendBtn.addEventListener('click', function () {
      submitChangeRequest(portalToken, deliverable, card, editor, crBox, fileInput, sendBtn, warn);
    });
    actions.appendChild(approveBtn);
    actions.appendChild(sendBtn);
    bodyWrap.appendChild(actions);

    modal.appendChild(bodyWrap);
    openOverlay(modal);
  }

  function submitChangeRequest(portalToken, deliverable, card, editor, crBox, fileInput, btn, warn) {
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
        portalToken: currentRoute().token || portalToken,
      }).then(function (res) {
        if (res.ok) {
          closeOverlay();
          loadApprovals(currentRoute().token || portalToken);
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

  // delivery_month is usually a 'YYYY-MM' (or 'YYYY-MM-DD') string. Render as
  // "Mon YYYY"; fall back to the raw value if it isn't parseable.
  function formatMonth(v) {
    if (!v) return '';
    var m = String(v).match(/^(\d{4})-(\d{2})/);
    if (m) {
      var dt = new Date(Number(m[1]), Number(m[2]) - 1, 1);
      if (!isNaN(dt.getTime())) return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    }
    return String(v);
  }

  // ════════════════════════════════════════════════════════════════
  // FLOW 3 — NATIVE VIDEO REQUEST FORM   /video-request  (#prefill=<b64>)
  // ════════════════════════════════════════════════════════════════
  // Schema-driven, rendered in-portal by form-render.js (no iframe). Tokenless:
  // the #prefill hash self-carries bfId/videoIndex/rowId routing keys. The schema,
  // upload, and submit all go through this app's same-origin /api/* proxy.

  // Canonical field map — shared by toLegacyPayload + applyPrefill. Mirrors the
  // standalone video-request-form glue: { schemaId, prefillKey|null, webhookKey }.
  var VRF_FIELD_MAP = [
    { schemaId: 'company_name',      prefillKey: 'company_name',         webhookKey: 'companyName' },
    { schemaId: 'contact_person',    prefillKey: 'contact_person',       webhookKey: 'contactPerson' },
    { schemaId: 'position_title',    prefillKey: null,                   webhookKey: 'positionTitle' },
    { schemaId: 'email',             prefillKey: 'email',                webhookKey: 'email' },
    { schemaId: 'mobile',            prefillKey: 'mobile',               webhookKey: 'mobile' },
    { schemaId: 'video_type_group',  prefillKey: 'video_type_group',     webhookKey: 'videoTypeGroup' },
    { schemaId: 'video_type_other',  prefillKey: 'video_type_other',     webhookKey: 'videoTypeOther' },
    { schemaId: 'video_duration',    prefillKey: 'video_duration',       webhookKey: 'videoDuration' },
    { schemaId: 'video_description', prefillKey: 'video_description',     webhookKey: 'videoDescription' },
    { schemaId: 'target_audience',   prefillKey: null,                   webhookKey: 'targetAudience' },
    { schemaId: 'cta',               prefillKey: null,                   webhookKey: 'cta' },
    { schemaId: 'key_messages',      prefillKey: null,                   webhookKey: 'keyMessages' },
    { schemaId: 'language',          prefillKey: null,                   webhookKey: 'language' },
    { schemaId: 'voiceover',         prefillKey: null,                   webhookKey: 'voiceover' },
    { schemaId: 'vo_lang',           prefillKey: null,                   webhookKey: 'voLang' },
    { schemaId: 'subtitles',         prefillKey: null,                   webhookKey: 'subtitles' },
    { schemaId: 'subs_lang',         prefillKey: null,                   webhookKey: 'subsLang' },
    { schemaId: 'shoot_days',        prefillKey: 'video_shoot_days',     webhookKey: 'shootDays' },
    { schemaId: 'shoot_hours',       prefillKey: 'video_shoot_hours',    webhookKey: 'shootHours' },
    { schemaId: 'shoot_location',    prefillKey: 'video_shoot_location', webhookKey: 'shootLocation' }
  ];
  var VRF_PASSTHROUGH = ['locations', 'interviewees', 'booking'];
  var VRF_PHOTOGRAPHER_SUBS = ['portraits', 'backdrop', 'groups', 'group_amount', 'days', 'hours'];

  function vrfToLegacyPayload(values) {
    values = values || {};
    var out = {};
    for (var i = 0; i < VRF_FIELD_MAP.length; i++) {
      var row = VRF_FIELD_MAP[i];
      if (!row.webhookKey) continue;
      var v = values[row.schemaId];
      out[row.webhookKey] = v != null ? v : '';
    }
    for (var p = 0; p < VRF_PASSTHROUGH.length; p++) {
      var key = VRF_PASSTHROUGH[p];
      if (values[key] != null) out[key] = values[key];
    }
    if (values.video_type_group === 'photographer' && values.photographer && typeof values.photographer === 'object') {
      var ph = {};
      for (var s = 0; s < VRF_PHOTOGRAPHER_SUBS.length; s++) {
        var sub = VRF_PHOTOGRAPHER_SUBS[s];
        ph[sub] = values.photographer[sub] != null ? values.photographer[sub] : '';
      }
      out.photographer = ph;
    } else {
      out.photographer = null;
    }
    return out;
  }

  // Decode the #prefill hash. Supports plain base64 (UTF-8) and the `gz.` gzip
  // variant (DecompressionStream). Returns the payload object or null.
  function vrfDecodePrefill(encoded) {
    try {
      if (encoded.indexOf('gz.') !== 0) {
        var bin = atob(encoded);
        var u8 = new Uint8Array(bin.length);
        for (var bi = 0; bi < bin.length; bi++) u8[bi] = bin.charCodeAt(bi);
        return Promise.resolve(JSON.parse(new TextDecoder('utf-8').decode(u8)));
      }
      var b64 = encoded.slice(3).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var binaryStr = atob(b64);
      var bytes = new Uint8Array(binaryStr.length);
      for (var ci = 0; ci < binaryStr.length; ci++) bytes[ci] = binaryStr.charCodeAt(ci);
      var ds = new DecompressionStream('gzip');
      var writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      var reader = ds.readable.getReader();
      var chunks = [];
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            var totalLen = 0, k;
            for (k = 0; k < chunks.length; k++) totalLen += chunks[k].length;
            var merged = new Uint8Array(totalLen);
            var offset = 0;
            for (k = 0; k < chunks.length; k++) { merged.set(chunks[k], offset); offset += chunks[k].length; }
            return JSON.parse(new TextDecoder().decode(merged));
          }
          chunks.push(result.value);
          return pump();
        });
      }
      return pump();
    } catch (err) {
      console.error('Prefill decode error:', err);
      return Promise.resolve(null);
    }
  }

  function vrfReadPrefillHash() {
    var hash = window.location.hash;
    if (!hash || hash.indexOf('#prefill=') !== 0) return Promise.resolve(null);
    var encoded = hash.slice(9);
    if (!encoded) return Promise.resolve(null);
    return vrfDecodePrefill(decodeURIComponent(encoded));
  }

  // prefill payload keys -> schema-field-id `values`; returns {values, lockedFields}.
  function vrfApplyPrefill(prefill) {
    var values = {};
    var lockedFields = [];
    if (!prefill || typeof prefill !== 'object') return { values: values, lockedFields: lockedFields };

    var prefillToSchema = {};
    for (var i = 0; i < VRF_FIELD_MAP.length; i++) {
      var row = VRF_FIELD_MAP[i];
      if (row.prefillKey) prefillToSchema[row.prefillKey] = row.schemaId;
    }
    for (var j = 0; j < VRF_FIELD_MAP.length; j++) {
      var r = VRF_FIELD_MAP[j];
      if (r.prefillKey && prefill[r.prefillKey] != null && prefill[r.prefillKey] !== '') {
        values[r.schemaId] = prefill[r.prefillKey];
      }
    }
    if (prefill.video_photographer_included) {
      var ph = {};
      for (var p = 0; p < VRF_PHOTOGRAPHER_SUBS.length; p++) {
        var sub = VRF_PHOTOGRAPHER_SUBS[p];
        var flatKey = 'video_photographer_' + sub;
        ph[sub] = prefill[flatKey] != null ? prefill[flatKey] : '';
      }
      values.photographer = ph;
    }
    var lockedRaw = Array.isArray(prefill.locked_fields) ? prefill.locked_fields : [];
    var seen = {};
    for (var k = 0; k < lockedRaw.length; k++) {
      var pk = lockedRaw[k];
      var schemaId = null;
      if (pk === 'video_photographer_included' || pk.indexOf('video_photographer_') === 0) {
        schemaId = 'photographer';
      } else if (prefillToSchema[pk]) {
        schemaId = prefillToSchema[pk];
      }
      if (schemaId && !seen[schemaId]) { lockedFields.push(schemaId); seen[schemaId] = 1; }
    }
    return { values: values, lockedFields: lockedFields };
  }

  // Multipart upload via the same-origin proxy (server.js forwards it RAW to the
  // CRM's public upload route). Returns [{url,name,size,contentType}].
  function vrfUploadFiles(fileList) {
    var fd = new FormData();
    for (var i = 0; i < fileList.length; i++) fd.append('files', fileList[i]);
    return api('POST', '/api/video-request-form/upload', fd).then(function (res) {
      if (!res.ok) {
        var msg = (res.data && res.data.error) || ('Upload failed (' + res.status + ')');
        throw new Error(msg);
      }
      return Array.isArray(res.data) ? res.data : [];
    });
  }

  var vrfLastPrefill = null;

  // Submit -> the CRM video-request callback (authenticated server-side by the
  // proxy's X-Sister-Auth header). Single sink: the legacy client-data webhook is
  // dropped here to avoid exposing its secret in browser JS.
  function vrfSubmitAll(collected) {
    var prefill = vrfLastPrefill || {};
    var legacy = vrfToLegacyPayload(collected.values);
    var dynamic = {
      schemaVersion: collected.schemaVersion,
      values: collected.values,
      uploads: collected.uploads || []
    };
    if (!prefill.bfId) {
      // No routing target — nothing to post back to. Acknowledge anyway.
      return render(thankYouState('Your video request has been recorded. Thank you!'));
    }
    var body = Object.assign({ video_index: prefill.videoIndex || null }, legacy, dynamic);
    api('POST', '/api/booking-forms/' + encodeURIComponent(prefill.bfId) + '/video-request-callback', body)
      .then(function (res) {
        if (res.ok) {
          render(thankYouState('Your video request has been submitted. Thank you!'));
        } else {
          render(errorState('We could not submit your request (' + res.status + '). Please contact ProAgri.'));
        }
      })
      .catch(function () {
        render(errorState('We could not submit your request. Please try again.'));
      });
  }

  function loadVideoRequest() {
    if (typeof window.renderVideoRequestForm !== 'function') {
      return render(errorState('The video request form could not be loaded. Please refresh the page.'));
    }
    render(el('div', { class: 'cp-loading', text: 'Loading video request form…' }));
    api('GET', '/api/video-request-form/schema').then(function (r) {
      if (!r.ok || !r.data || !Array.isArray(r.data.steps) || !r.data.steps.length) {
        return render(errorState('Could not load the video request form. Please refresh or contact ProAgri.'));
      }
      var schema = r.data;
      vrfReadPrefillHash().then(function (prefill) {
        vrfLastPrefill = prefill || {};
        var mapped = vrfApplyPrefill(prefill);
        var wrap = el('div', { class: 'cp-vrf' });
        wrap.appendChild(el('h1', { class: 'cp-h1', text: 'Video Request' }));
        wrap.appendChild(el('p', { class: 'cp-sub', text: 'Brief our team in a few quick steps.' }));
        if (prefill) {
          wrap.appendChild(el('div', { class: 'cp-vrf-prefill', text: 'Some fields were pre-filled from your CRM data. Review and update as needed.' }));
        }
        var mount = el('div', { class: 'cp-vrf-mount' });
        wrap.appendChild(mount);
        render(wrap);
        window.renderVideoRequestForm(mount, schema, {
          mode: 'form',
          values: mapped.values,
          lockedFields: mapped.lockedFields,
          onUpload: vrfUploadFiles,
          onSubmit: vrfSubmitAll
        });
      });
    }).catch(function () {
      render(errorState('Could not load the video request form. Please try again.'));
    });
  }

  // ════════════════════════════════════════════════════════════════
  // FLOW 4 — CLIENT DASHBOARD   /dashboard/:portalToken
  // ════════════════════════════════════════════════════════════════
  function loadDashboard(portalToken) {
    render(el('div', { class: 'cp-loading', text: 'Loading your dashboard…' }));
    api('GET', '/api/request-forms/public/portal/' + encodeURIComponent(portalToken) + '/dashboard').then(function (r) {
      if (!r.ok || !r.data) {
        return render(errorState('Could not load your dashboard. The link may be invalid.'));
      }
      renderDashboard(portalToken, r.data);
    }).catch(function () {
      render(errorState('Could not load your dashboard. Please try again.'));
    });
  }

  function renderDashboard(portalToken, data) {
    var clientName = data.clientName || 'Your account';
    var pending = data.pendingCount || 0;
    var approved = data.approvedCount || 0;
    var recent = Array.isArray(data.recentApprovals) ? data.recentApprovals : [];

    var wrap = el('div', {}, [
      el('h1', { class: 'cp-h1', text: clientName }),
      el('p', { class: 'cp-sub', text: 'Your content overview.' }),
    ]);

    var cards = el('div', { class: 'cp-dash-cards' }, [
      el('div', { class: 'cp-dash-card' }, [
        el('div', { class: 'cp-dash-num', text: String(pending) }),
        el('div', { class: 'cp-dash-label', text: 'Awaiting your approval' }),
      ]),
      el('div', { class: 'cp-dash-card' }, [
        el('div', { class: 'cp-dash-num', text: String(approved) }),
        el('div', { class: 'cp-dash-label', text: 'Previously approved' }),
      ]),
    ]);
    wrap.appendChild(cards);

    if (pending > 0) {
      var go = el('a', { class: 'cp-dash-link', href: '/approvals/' + encodeURIComponent(portalToken),
        text: 'Review items awaiting approval →' });
      wrap.appendChild(go);
    }

    wrap.appendChild(el('h2', { class: 'cp-h2', text: 'Previous approvals' }));
    if (!recent.length) {
      wrap.appendChild(el('div', { class: 'cp-empty' }, [
        el('p', { text: 'No approved content yet.' }),
      ]));
    } else {
      var list = el('div', { class: 'cp-dash-list' });
      recent.forEach(function (d) {
        var meta = [];
        var month = d.deliveryMonth || d.delivery_month;
        if (month) meta.push(formatMonth(month));
        var ad = d.approvalDate || d.approval_date;
        if (ad) meta.push('Approved ' + formatDate(ad));
        list.appendChild(el('div', { class: 'cp-dash-row' }, [
          el('div', { class: 'cp-dash-row-title', text: d.title || ('Deliverable #' + d.id) }),
          el('div', { class: 'cp-dash-row-meta', text: meta.join(' · ') }),
        ]));
      });
      wrap.appendChild(list);
    }
    render(wrap);
  }

  // ── Router (path-based, with hash fallback) ──────────────────────
  function currentRoute() {
    var p = window.location.pathname;
    // /video-request is tokenless — the #prefill hash carries the routing. Match
    // it first so the (form|approvals|dashboard)/:token pattern doesn't apply.
    if (/^\/video-request\/?$/.test(p) ||
        (/^#?\/?video-request/.test(window.location.hash.replace(/^#/, '')) && p === '/')) {
      return { view: 'video-request', token: null };
    }
    // /preview/:portalToken/:itemId — read-only collateral preview (CRM "Preview"
    // button). Portal-scoped: the CRM now passes the client's portal_token as the
    // first segment so the upstream CRM call is client-scoped (see loadPreview).
    // A legacy tokenless /preview/:itemId is still matched but can no longer be
    // served (the CRM preview endpoint requires the portal token) — loadPreview
    // renders a clear "reopen from the CRM" notice for it.
    var pv = p.match(/^\/preview\/([^\/]+)(?:\/([^\/]+))?/);
    if (!pv && window.location.hash) {
      pv = window.location.hash.replace(/^#/, '').match(/^\/?preview\/([^\/]+)(?:\/([^\/]+))?/);
    }
    if (pv) {
      if (pv[2]) return { view: 'preview', token: decodeURIComponent(pv[1]), itemId: decodeURIComponent(pv[2]) };
      return { view: 'preview', token: null, itemId: decodeURIComponent(pv[1]) };
    }

    var m = p.match(/^\/(form|approvals|dashboard)\/([^\/]+)/);
    if (!m && window.location.hash) {
      m = window.location.hash.replace(/^#/, '').match(/^\/?(form|approvals|dashboard)\/([^\/]+)/);
    }
    if (m) return { view: m[1], token: decodeURIComponent(m[2]) };
    return { view: null, token: null };
  }

  function route() {
    var r = currentRoute();
    if (r.view === 'video-request') return loadVideoRequest();
    if (r.view === 'preview' && r.itemId) return loadPreview(r.token, r.itemId);
    if (r.view === 'form' && r.token) return loadForm(r.token);
    if (r.view === 'approvals' && r.token) return loadApprovals(r.token);
    if (r.view === 'dashboard' && r.token) return loadDashboard(r.token);
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
