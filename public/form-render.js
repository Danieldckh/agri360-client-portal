// Native cp- render engine for the in-portal Video Request Form.
/*!
 * form-render.js — schema-driven Video Request Form render engine.
 *
 * Rendered ENTIRELY in the portal's own native `cp-` design system (the same
 * design language as the /form and /approvals views) — NO Tailwind. All visual
 * styling lives in styles.css under the `.cp-vrf-*` classes.
 *
 * Dependency-free, no-build, vanilla ES5-ish browser script. Exposes two globals:
 *   window.renderVideoRequestForm(mountEl, schema, opts)
 *   window.collectVideoRequestForm(mountEl, schema)
 *
 * The render output carries the same data-* attributes (data-field-id,
 * data-field-type, data-input, data-file-store, data-booking-store, showIf
 * hooks) so collect() walks the DOM exactly as before — only presentation
 * changed from Tailwind utilities to cp- classes.
 *
 * Includes the video-type cards (.cp-vrf-typecard), the duration quick-pick
 * chips (.cp-vrf-chip), and the month calendar + time-slot grid.
 */
(function () {
  "use strict";

  /* ───────────────────────── tiny DOM helpers ───────────────────────── */

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var val = attrs[key];
        if (val == null) continue;
        if (key === "className") el.className = val;
        else if (key === "textContent") el.textContent = val;
        else if (key === "htmlFor") el.htmlFor = val;
        else if (key === "checked") el.checked = !!val;
        else if (key === "disabled") el.disabled = !!val;
        else if (key === "readOnly") el.readOnly = !!val;
        else if (key === "selected") el.selected = !!val;
        else if (key === "value") el.value = val;
        else el.setAttribute(key, val);
      }
    }
    if (children != null) {
      if (!Array.isArray(children)) children = [children];
      for (var c = 0; c < children.length; c++) {
        var child = children[c];
        if (child == null || child === false) continue;
        if (typeof child === "string" || typeof child === "number") {
          el.appendChild(document.createTextNode(String(child)));
        } else {
          el.appendChild(child);
        }
      }
    }
    return el;
  }

  function clearEl(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function pad(n) { return String(n).length < 2 ? "0" + n : String(n); }

  // cp- class strings (mirror the portal's /form + /approvals views).
  var CLS = {
    input: "cp-input",
    textarea: "cp-textarea",
    select: "cp-select",
    label: "cp-field-label",
    help: "cp-vrf-help",
    fieldWrap: "cp-vrf-field",
    card: "cp-vrf-subcard",
    btnGhost: "cp-btn",
    btnRed: "cp-btn cp-btn-primary",
    lockedTag: "cp-vrf-locked-tag"
  };

  function normalizeOption(o) {
    if (o && typeof o === "object") return { value: o.value, label: o.label != null ? o.label : o.value };
    return { value: o, label: o };
  }

  function isLocked(field, ctx) {
    return ctx.locked.indexOf(field.id) !== -1;
  }

  function lockedTag() {
    return h("span", { className: CLS.lockedTag, title: "Sourced from the CRM — read only" }, ["locked"]);
  }

  function labelEl(field, ctx, forId) {
    var kids = [document.createTextNode(field.label || "")];
    if (field.required) kids.push(h("span", { className: "req", textContent: "*" }));
    if (isLocked(field, ctx)) kids.push(lockedTag());
    return h("label", { className: CLS.label, htmlFor: forId || null }, kids);
  }

  function helpEl(field) {
    return field.help ? h("div", { className: CLS.help }, [field.help]) : null;
  }

  // Apply locked styling to a control element in-place.
  function applyLock(control, field, ctx) {
    if (!isLocked(field, ctx)) return control;
    var tag = (control.tagName || "").toLowerCase();
    if (tag === "select" || (tag === "input" && (control.type === "checkbox" || control.type === "radio" || control.type === "file"))) {
      control.disabled = true;
    } else {
      control.readOnly = true;
    }
    control.classList.add("cp-vrf-locked");
    return control;
  }

  /* ───────────────────────── value coercion for prefill ───────────────────────── */

  function prefillValue(ctx, field, fallback) {
    if (ctx.values && Object.prototype.hasOwnProperty.call(ctx.values, field.id) && ctx.values[field.id] != null) {
      return ctx.values[field.id];
    }
    if (field.default != null) return field.default;
    return fallback != null ? fallback : "";
  }

  /* ───────────────────────── field renderers ───────────────────────── */
  // Each renderer returns a wrapper DIV carrying data-field-id + data-field-type
  // so collect() can walk the DOM reliably without any external state.

  function wrap(field, inner) {
    var w = h("div", { className: CLS.fieldWrap }, inner);
    w.setAttribute("data-field-id", field.id);
    w.setAttribute("data-field-type", field.type);
    if (field.showIf) {
      w.setAttribute("data-showif-field", field.showIf.field);
      w.setAttribute("data-showif-equals", String(field.showIf.equals));
    }
    return w;
  }

  function renderTextlike(field, ctx) {
    var type = field.type === "email" ? "email" : field.type === "tel" ? "tel" : "text";
    var input = h("input", {
      type: type,
      className: CLS.input,
      placeholder: field.placeholder || "",
      value: String(prefillValue(ctx, field, "")),
      "data-input": "1"
    });
    if (type === "tel") input.setAttribute("inputmode", "tel");
    applyLock(input, field, ctx);
    input.addEventListener("input", ctx.onChange);

    var kids = [labelEl(field, ctx), input, helpEl(field)];

    // Quick-pick chips (duration-style) — fill the text input.
    if (field.variant === "chips" && Array.isArray(field.options) && field.options.length) {
      var chipRow = h("div", { className: "cp-vrf-chips" });
      var hint = h("div", { className: "cp-vrf-hint", textContent: "Quick picks (tap to fill):" });
      for (var i = 0; i < field.options.length; i++) {
        (function (opt) {
          var o = normalizeOption(opt);
          var chip = h("button", {
            type: "button",
            className: "cp-vrf-chip",
            textContent: o.label
          });
          if (String(input.value) === String(o.value)) chip.classList.add("active");
          chip.addEventListener("click", function () {
            if (input.disabled || input.readOnly) return;
            var all = chipRow.querySelectorAll(".cp-vrf-chip");
            for (var a = 0; a < all.length; a++) all[a].classList.remove("active");
            chip.classList.add("active");
            input.value = o.value;
            ctx.onChange();
          });
          chipRow.appendChild(chip);
        })(field.options[i]);
      }
      // keep chip highlight in sync with manual typing
      input.addEventListener("input", function () {
        var all = chipRow.querySelectorAll(".cp-vrf-chip");
        for (var a = 0; a < all.length; a++) {
          all[a].classList.toggle("active", all[a].textContent === input.value);
        }
      });
      kids.push(hint, chipRow);
    }
    return wrap(field, kids);
  }

  function renderTextarea(field, ctx) {
    var ta = h("textarea", {
      rows: field.rows || 3,
      className: CLS.textarea,
      placeholder: field.placeholder || "",
      "data-input": "1"
    });
    ta.value = String(prefillValue(ctx, field, ""));
    applyLock(ta, field, ctx);
    ta.addEventListener("input", ctx.onChange);
    return wrap(field, [labelEl(field, ctx), ta, helpEl(field)]);
  }

  function renderNumber(field, ctx) {
    var input = h("input", {
      type: "number",
      className: CLS.input,
      placeholder: field.placeholder || "",
      value: String(prefillValue(ctx, field, "")),
      "data-input": "1"
    });
    if (field.min != null) input.setAttribute("min", field.min);
    if (field.max != null) input.setAttribute("max", field.max);
    applyLock(input, field, ctx);
    input.addEventListener("input", ctx.onChange);
    return wrap(field, [labelEl(field, ctx), input, helpEl(field)]);
  }

  function renderSelect(field, ctx) {
    var sel = h("select", { className: CLS.select, "data-input": "1" });
    var cur = String(prefillValue(ctx, field, field.default != null ? field.default : ""));
    var opts = field.options || [];
    for (var i = 0; i < opts.length; i++) {
      var o = normalizeOption(opts[i]);
      var opt = h("option", { value: o.value, textContent: o.label });
      if (String(o.value) === cur) opt.selected = true;
      sel.appendChild(opt);
    }
    applyLock(sel, field, ctx);
    sel.addEventListener("change", ctx.onChange);
    return wrap(field, [labelEl(field, ctx), sel, helpEl(field)]);
  }

  function renderRadio(field, ctx) {
    var cur = String(prefillValue(ctx, field, field.default != null ? field.default : ""));
    var locked = isLocked(field, ctx);
    var groupName = "vrf_radio_" + field.id;

    if (field.variant === "cards") {
      // Native cp- card grid (port of the live form's type-card grid).
      var grid = h("div", { className: "cp-vrf-cardgrid" });
      var hidden = h("input", { type: "hidden", "data-input": "1", value: cur });
      var opts = field.options || [];
      for (var i = 0; i < opts.length; i++) {
        (function (opt) {
          var o = normalizeOption(opt);
          var title = h("div", { className: "cp-vrf-typecard-title", textContent: o.label });
          var dot = h("span", { className: "cp-vrf-typecard-dot" });
          var dotWrap = h("div", { className: "cp-vrf-typecard-dotwrap" }, [dot]);
          var row = h("div", { className: "cp-vrf-typecard-row" }, [h("div", null, [title]), dotWrap]);
          var card = h("button", {
            type: "button",
            className: "cp-vrf-typecard",
            "data-value": o.value
          }, [row]);
          if (String(o.value) === cur) card.classList.add("active");
          if (locked) { card.disabled = true; }
          card.addEventListener("click", function () {
            if (locked) return;
            var all = grid.querySelectorAll(".cp-vrf-typecard");
            for (var a = 0; a < all.length; a++) all[a].classList.remove("active");
            card.classList.add("active");
            hidden.value = o.value;
            ctx.onChange();
          });
          grid.appendChild(card);
        })(opts[i]);
      }
      return wrap(field, [labelEl(field, ctx), grid, hidden, helpEl(field)]);
    }

    // Default inline radio group.
    var box = h("div", { className: "cp-vrf-radio-inline" });
    var optsR = field.options || [];
    for (var r = 0; r < optsR.length; r++) {
      var oR = normalizeOption(optsR[r]);
      var radio = h("input", { type: "radio", name: groupName, value: oR.value, "data-input": "1" });
      if (String(oR.value) === cur) radio.checked = true;
      if (locked) radio.disabled = true;
      radio.addEventListener("change", ctx.onChange);
      box.appendChild(h("label", { className: "cp-vrf-opt" }, [radio, h("span", { textContent: oR.label })]));
    }
    return wrap(field, [labelEl(field, ctx), box, helpEl(field)]);
  }

  function renderCheckbox(field, ctx) {
    var trueV = field.trueValue != null ? field.trueValue : "Yes";
    var falseV = field.falseValue != null ? field.falseValue : "No";
    var cur = prefillValue(ctx, field, falseV);
    var cb = h("input", { type: "checkbox", "data-input": "1" });
    cb.checked = String(cur) === String(trueV);
    cb.setAttribute("data-true", trueV);
    cb.setAttribute("data-false", falseV);
    if (isLocked(field, ctx)) cb.disabled = true;
    cb.addEventListener("change", ctx.onChange);
    var lbl = h("label", { className: "cp-vrf-opt" }, [cb, h("span", { textContent: field.label })]);
    var kids = [lbl, helpEl(field)];
    if (isLocked(field, ctx)) lbl.appendChild(lockedTag());
    var w = wrap(field, kids);
    // checkbox label IS the field label, so don't duplicate.
    return w;
  }

  function renderDateTime(field, ctx) {
    var input = h("input", {
      type: field.type === "date" ? "date" : "time",
      className: CLS.input,
      value: String(prefillValue(ctx, field, "")),
      "data-input": "1"
    });
    applyLock(input, field, ctx);
    input.addEventListener("change", ctx.onChange);
    return wrap(field, [labelEl(field, ctx), input, helpEl(field)]);
  }

  function fileDescriptorsFromValue(v) {
    if (Array.isArray(v)) return v.slice();
    return [];
  }

  function renderFile(field, ctx) {
    var locked = isLocked(field, ctx);
    var input = h("input", {
      type: "file",
      className: "cp-vrf-file",
      "data-file-input": "1"
    });
    if (field.accept) input.setAttribute("accept", field.accept);
    if (field.multiple) input.setAttribute("multiple", "multiple");
    if (locked) input.disabled = true;

    var chips = h("div", { className: "cp-vrf-filechips" });
    // Hidden store of uploaded descriptors (JSON), read by collect().
    var store = h("input", { type: "hidden", "data-file-store": "1" });
    var existing = fileDescriptorsFromValue(prefillValue(ctx, field, []));
    store.value = JSON.stringify(existing);

    function renderChips() {
      clearEl(chips);
      var descs = [];
      try { descs = JSON.parse(store.value || "[]"); } catch (e) { descs = []; }
      for (var i = 0; i < descs.length; i++) {
        (function (d, idx) {
          var isImg = d.contentType && d.contentType.indexOf("image/") === 0;
          var inner = [];
          if (isImg && d.url) {
            inner.push(h("img", { src: d.url, alt: d.name || "" }));
          }
          inner.push(h("span", { className: "cp-vrf-filechip-name", textContent: d.name || d.url || "file" }));
          if (!locked) {
            var rm = h("button", { type: "button", className: "cp-vrf-filechip-rm", title: "Remove", textContent: "×" });
            rm.addEventListener("click", function () {
              var arr;
              try { arr = JSON.parse(store.value || "[]"); } catch (e) { arr = []; }
              arr.splice(idx, 1);
              store.value = JSON.stringify(arr);
              renderChips();
              ctx.onChange();
            });
            inner.push(rm);
          }
          chips.appendChild(h("div", { className: "cp-vrf-filechip" }, inner));
        })(descs[i], i);
      }
    }
    renderChips();

    input.addEventListener("change", function () {
      var files = input.files;
      if (!files || !files.length) return;
      if (typeof ctx.onUpload !== "function") {
        console.warn("form-render: file field but no onUpload provided");
        return;
      }
      input.disabled = true;
      Promise.resolve(ctx.onUpload(files)).then(function (descriptors) {
        var arr;
        try { arr = JSON.parse(store.value || "[]"); } catch (e) { arr = []; }
        var got = Array.isArray(descriptors) ? descriptors : [];
        store.value = JSON.stringify(field.multiple ? arr.concat(got) : got);
        renderChips();
        input.value = "";
        input.disabled = locked;
        ctx.onChange();
      }).catch(function (err) {
        console.error("form-render: upload failed", err);
        input.disabled = locked;
      });
    });

    return wrap(field, [labelEl(field, ctx), input, store, chips, helpEl(field)]);
  }

  function renderHeading(field, ctx) {
    var w = wrap(field, [
      h("div", { className: "cp-vrf-subcard" }, [
        h("h2", { className: "cp-vrf-heading-title", textContent: field.label }),
        field.help ? h("p", { className: "cp-vrf-heading-help", textContent: field.help }) : null
      ])
    ]);
    return w;
  }

  // group WITHOUT repeat -> inline subsection of its fields.
  function renderGroupInline(field, ctx) {
    var subWrap = h("div", { className: "cp-vrf-subgrid cp-vrf-cols-3" });
    var groupVals = (ctx.values && ctx.values[field.id]) || {};
    var subCtx = subContext(ctx, groupVals);
    var subs = field.fields || [];
    for (var i = 0; i < subs.length; i++) {
      var el = renderField(subs[i], subCtx);
      if (el) subWrap.appendChild(el);
    }
    var card = h("div", { className: "cp-vrf-subcard" }, [
      h("h3", { className: "cp-vrf-subcard-title", textContent: field.label }),
      subWrap
    ]);
    var w = wrap(field, [card]);
    w.setAttribute("data-group", "inline");
    return w;
  }

  // group WITH repeat -> count control + N blocks; collected as array.
  function renderGroupRepeat(field, ctx) {
    var rep = field.repeat || {};
    var min = rep.min != null ? rep.min : 1;
    var max = rep.max != null ? rep.max : 10;
    var existingArr = (ctx.values && Array.isArray(ctx.values[field.id])) ? ctx.values[field.id] : [];
    var count = Math.max(min, Math.min(max, existingArr.length || min));

    var blocks = h("div", { className: "cp-vrf-blocks" });
    blocks.setAttribute("data-group-blocks", "1");

    var countControl;
    if (rep.countControl === "number") {
      countControl = h("input", { type: "number", className: CLS.input, value: String(count) });
      countControl.setAttribute("min", min);
      countControl.setAttribute("max", max);
    } else {
      countControl = h("select", { className: CLS.select });
      for (var c = min; c <= max; c++) {
        var opt = h("option", { value: c, textContent: String(c) });
        if (c === count) opt.selected = true;
        countControl.appendChild(opt);
      }
    }
    countControl.setAttribute("data-count-control", "1");

    function buildBlocks(n) {
      clearEl(blocks);
      for (var idx = 0; idx < n; idx++) {
        var blockVals = existingArr[idx] || {};
        var subCtx = subContext(ctx, blockVals);
        var inner = h("div", { className: "cp-vrf-subgrid cp-vrf-cols-2" });
        var subs = field.fields || [];
        for (var f = 0; f < subs.length; f++) {
          var el = renderField(subs[f], subCtx);
          if (el) inner.appendChild(el);
        }
        var block = h("div", { className: "cp-vrf-subcard" }, [
          h("h3", { className: "cp-vrf-subcard-title", textContent: field.label + " " + (idx + 1) }),
          inner
        ]);
        block.setAttribute("data-group-index", String(idx));
        blocks.appendChild(block);
      }
      ctx.refreshVisibility();
    }

    function onCount() {
      var n = parseInt(countControl.value || String(min), 10);
      if (isNaN(n)) n = min;
      n = Math.max(min, Math.min(max, n));
      // snapshot current values so resizing keeps already-entered data
      existingArr = collectGroupArray(blocks, field);
      buildBlocks(n);
      ctx.onChange();
    }
    countControl.addEventListener("change", onCount);
    countControl.addEventListener("input", onCount);

    buildBlocks(count);

    var countWrap = h("div", { className: "cp-vrf-count" }, [
      h("label", { className: CLS.label, textContent: rep.countLabel || ("Number of " + field.label) }),
      countControl
    ]);

    var w = wrap(field, [countWrap, blocks]);
    w.setAttribute("data-group", "repeat");
    return w;
  }

  function renderGroup(field, ctx) {
    return (field.repeat && typeof field.repeat === "object")
      ? renderGroupRepeat(field, ctx)
      : renderGroupInline(field, ctx);
  }

  /* ───────────────────────── booking (calendar + slots) ───────────────────────── */

  function renderBooking(field, ctx) {
    var slotStart = field.slotStart || "07:00";
    var slotEnd = field.slotEnd || "16:00";
    var stepMin = field.slotStepMin || 30;

    var state = { date: null, time: null, iso: null };
    var pre = (ctx.values && ctx.values[field.id]) || {};
    if (pre && pre.date) { state.date = pre.date; state.time = pre.time || null; state.iso = pre.iso || (pre.date + "T00:00:00"); }

    var store = h("input", { type: "hidden", "data-booking-store": "1" });
    function syncStore() { store.value = JSON.stringify(state); }
    syncStore();

    var monthLabel = h("div", { className: "cp-vrf-cal-title" });
    var prevBtn = h("button", { type: "button", className: "cp-vrf-cal-nav", textContent: "‹" });
    var nextBtn = h("button", { type: "button", className: "cp-vrf-cal-nav", textContent: "›" });
    var calGrid = h("div", { className: "cp-vrf-cal-grid" });
    var slotGrid = h("div", { className: "cp-vrf-slots" });
    var summary = h("div", { className: "cp-vrf-summary", textContent: "Selected: —" });

    var locked = isLocked(field, ctx);

    var view = (function () {
      var d = state.iso ? new Date(state.iso) : new Date();
      return { y: d.getFullYear(), m: d.getMonth() };
    })();

    function parseHM(s) { var p = String(s).split(":"); return { h: parseInt(p[0], 10) || 0, m: parseInt(p[1], 10) || 0 }; }

    function renderSlots() {
      clearEl(slotGrid);
      var a = parseHM(slotStart), b = parseHM(slotEnd);
      var startMin = a.h * 60 + a.m, endMin = b.h * 60 + b.m;
      for (var t = startMin; t <= endMin; t += stepMin) {
        (function (tm) {
          var label = pad(Math.floor(tm / 60)) + ":" + pad(tm % 60);
          var cls = "cp-vrf-slot";
          if (state.time === label) cls += " slot-active";
          var btn = h("button", { type: "button", className: cls, textContent: label });
          if (locked) { btn.disabled = true; }
          btn.addEventListener("click", function () {
            if (locked) return;
            if (!state.date) return;
            var all = slotGrid.querySelectorAll(".cp-vrf-slot");
            for (var s = 0; s < all.length; s++) all[s].classList.remove("slot-active");
            btn.classList.add("slot-active");
            state.time = label;
            syncStore(); updateSummary(); ctx.onChange();
          });
          slotGrid.appendChild(btn);
        })(t);
      }
    }

    function updateSummary() {
      if (state.date && state.time) {
        var human = new Date(state.date + "T00:00:00");
        summary.textContent = "Selected: " + human.toLocaleDateString() + " at " + state.time;
      } else {
        summary.textContent = "Selected: —";
      }
    }

    function renderCalendar() {
      var y = view.y, m = view.m;
      monthLabel.textContent = new Date(y, m, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
      clearEl(calGrid);
      var dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      for (var dn = 0; dn < dayNames.length; dn++) {
        calGrid.appendChild(h("div", { className: "cp-vrf-cal-dayname", textContent: dayNames[dn] }));
      }
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var leading = new Date(y, m, 1).getDay();
      var total = new Date(y, m + 1, 0).getDate();
      for (var li = 0; li < leading; li++) calGrid.appendChild(h("div"));
      for (var d = 1; d <= total; d++) {
        (function (day) {
          var dateObj = new Date(y, m, day);
          var disabled = dateObj < today || locked;
          var dateStr = y + "-" + pad(m + 1) + "-" + pad(day);
          var cls = "cp-vrf-cal-day";
          if (disabled) cls += " disabled";
          if (state.date === dateStr) cls += " is-selected";
          var btn = h("button", { type: "button", className: cls, textContent: String(day) });
          if (!disabled) {
            btn.addEventListener("click", function () {
              var all = calGrid.querySelectorAll(".cp-vrf-cal-day");
              for (var a = 0; a < all.length; a++) all[a].classList.remove("is-selected");
              btn.classList.add("is-selected");
              state.date = dateStr;
              state.iso = dateStr + "T00:00:00";
              state.time = null;
              syncStore(); renderSlots(); updateSummary(); ctx.onChange();
            });
          }
          calGrid.appendChild(btn);
        })(d);
      }
      renderSlots(); updateSummary();
    }

    prevBtn.addEventListener("click", function () { if (view.m === 0) { view.m = 11; view.y--; } else view.m--; renderCalendar(); });
    nextBtn.addEventListener("click", function () { if (view.m === 11) { view.m = 0; view.y++; } else view.m++; renderCalendar(); });

    renderCalendar();

    var calCard = h("div", { className: "cp-vrf-cal" }, [
      h("div", { className: "cp-vrf-cal-head" }, [prevBtn, monthLabel, nextBtn]),
      calGrid
    ]);
    var slotCard = h("div", { className: "cp-vrf-slots-card" }, [
      h("div", { className: "cp-vrf-slots-title", textContent: "Available times" }),
      slotGrid, summary
    ]);
    var grid = h("div", { className: "cp-vrf-booking" }, [calCard, slotCard]);

    var kids = [labelEl(field, ctx), grid, store, helpEl(field)];
    return wrap(field, kids);
  }

  /* ───────────────────────── render dispatch ───────────────────────── */

  function renderField(field, ctx) {
    switch (field.type) {
      case "text":
      case "email":
      case "tel": return renderTextlike(field, ctx);
      case "textarea": return renderTextarea(field, ctx);
      case "number": return renderNumber(field, ctx);
      case "select": return renderSelect(field, ctx);
      case "radio": return renderRadio(field, ctx);
      case "checkbox": return renderCheckbox(field, ctx);
      case "date":
      case "time": return renderDateTime(field, ctx);
      case "file": return renderFile(field, ctx);
      case "heading": return renderHeading(field, ctx);
      case "group": return renderGroup(field, ctx);
      case "booking": return renderBooking(field, ctx);
      default:
        console.warn("form-render: unknown field type", field.type, field.id);
        return wrap(field, [h("div", { className: "cp-vrf-error", textContent: "Unsupported field type: " + field.type })]);
    }
  }

  // A child context for fields nested inside a group (sub-values + same callbacks).
  function subContext(ctx, vals) {
    return {
      mode: ctx.mode,
      values: vals || {},
      locked: ctx.locked,
      onUpload: ctx.onUpload,
      onChange: ctx.onChange,
      refreshVisibility: ctx.refreshVisibility,
      nested: true
    };
  }

  /* ───────────────────────── collect (DOM walk) ───────────────────────── */

  function readControlValue(wrapEl, type) {
    if (type === "checkbox") {
      var cb = wrapEl.querySelector('input[type="checkbox"][data-input]');
      if (!cb) return "";
      return cb.checked ? cb.getAttribute("data-true") : cb.getAttribute("data-false");
    }
    if (type === "radio") {
      // cards use a hidden data-input; default radios use checked radios
      var hidden = wrapEl.querySelector('input[type="hidden"][data-input]');
      if (hidden) return hidden.value;
      var checked = wrapEl.querySelector('input[type="radio"][data-input]:checked');
      return checked ? checked.value : "";
    }
    if (type === "file") {
      var store = wrapEl.querySelector('input[data-file-store]');
      if (!store) return [];
      try { return JSON.parse(store.value || "[]"); } catch (e) { return []; }
    }
    if (type === "booking") {
      var bs = wrapEl.querySelector('input[data-booking-store]');
      if (!bs) return { date: null, time: null, iso: null };
      try { return JSON.parse(bs.value || "{}"); } catch (e) { return { date: null, time: null, iso: null }; }
    }
    // text/email/tel/number/textarea/select/date/time
    var input = wrapEl.querySelector('[data-input]');
    return input ? input.value : "";
  }

  // Collect a single (non-group, non-nested) leaf field wrapper.
  function collectLeaf(wrapEl) {
    var type = wrapEl.getAttribute("data-field-type");
    return readControlValue(wrapEl, type);
  }

  // For a repeat-group's blocks container, return an array of objects.
  function collectGroupArray(blocksEl, field) {
    var blocks = blocksEl.querySelectorAll('[data-group-index]');
    var out = [];
    for (var b = 0; b < blocks.length; b++) {
      out.push(collectFieldsInScope(blocks[b], field.fields || []));
    }
    return out;
  }

  // Walk only the IMMEDIATE field wrappers belonging to `fields` within scopeEl.
  function collectFieldsInScope(scopeEl, fields) {
    var obj = {};
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var wrapEl = findOwnFieldWrap(scopeEl, f.id);
      if (!wrapEl) continue;
      if (isHidden(wrapEl)) continue; // showIf-hidden -> excluded
      obj[f.id] = collectAny(wrapEl, f);
    }
    return obj;
  }

  // Find the field wrapper for id that belongs directly to scopeEl (not to a deeper group).
  function findOwnFieldWrap(scopeEl, id) {
    var all = scopeEl.querySelectorAll('[data-field-id="' + cssEscape(id) + '"]');
    for (var i = 0; i < all.length; i++) {
      if (nearestGroupScope(all[i], scopeEl) === scopeEl) return all[i];
    }
    return null;
  }

  // The scope a wrapper belongs to = the closest ancestor that is either a
  // group-index block or the top scopeEl. Used to avoid pulling nested-group
  // children up into the parent.
  function nearestGroupScope(el, topScope) {
    var p = el.parentNode;
    while (p && p !== topScope) {
      if (p.nodeType === 1 && (p.hasAttribute("data-group-index"))) return p;
      p = p.parentNode;
    }
    return topScope;
  }

  function collectAny(wrapEl, field) {
    if (field.type === "group") {
      if (field.repeat && typeof field.repeat === "object") {
        var blocks = wrapEl.querySelector('[data-group-blocks]');
        return blocks ? collectGroupArray(blocks, field) : [];
      }
      // inline group -> object
      return collectFieldsInScope(wrapEl, field.fields || []);
    }
    return collectLeaf(wrapEl);
  }

  function isHidden(el) {
    // hidden by showIf -> our code sets style.display = "none" on the wrapper
    if (!el) return true;
    if (el.getAttribute("data-vrf-hidden") === "1") return true;
    return false;
  }

  // Minimal CSS.escape fallback for attribute selectors.
  function cssEscape(s) {
    return String(s).replace(/["\\\]\[]/g, "\\$&");
  }

  function isEmptyVal(v) {
    if (v == null) return true;
    if (typeof v === "string") return v.trim() === "";
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") {
      if (Object.prototype.hasOwnProperty.call(v, "date")) return !v.date || !v.time;
      var keys = Object.keys(v);
      for (var i = 0; i < keys.length; i++) if (!isEmptyVal(v[keys[i]])) return false;
      return true;
    }
    return false;
  }

  /* ───────────────────────── public: collect ───────────────────────── */

  function collectVideoRequestForm(mountEl, schema) {
    var root = mountEl.querySelector('[data-vrf-root]') || mountEl;
    var values = {};
    var firstError = null;
    var allFields = []; // {field, scope}

    // Top-level fields: gather per step, in document order.
    var steps = (schema && schema.steps) || [];
    for (var s = 0; s < steps.length; s++) {
      var fields = steps[s].fields || [];
      for (var f = 0; f < fields.length; f++) {
        var field = fields[f];
        var wrapEl = findOwnFieldWrap(root, field.id);
        if (!wrapEl) continue;
        var hidden = isHidden(wrapEl);
        var val = hidden ? undefined : collectAny(wrapEl, field);
        if (!hidden) values[field.id] = val;
        allFields.push({ field: field, value: val, hidden: hidden });
      }
    }

    // Validation: required leaf fields (and required leaves inside groups).
    function validateFields(fields, scopeVals, where) {
      for (var i = 0; i < fields.length; i++) {
        var fld = fields[i];
        if (fld.type === "heading") continue;
        var v = scopeVals[fld.id];
        if (fld.type === "group") {
          if (v === undefined) continue; // hidden group
          if (fld.repeat && Array.isArray(v)) {
            for (var b = 0; b < v.length; b++) {
              var e = validateFields(fld.fields || [], v[b] || {}, fld.id + "[" + (b + 1) + "]");
              if (e) return e;
            }
          } else if (v && typeof v === "object") {
            var e2 = validateFields(fld.fields || [], v, fld.id);
            if (e2) return e2;
          }
          continue;
        }
        if (fld.required) {
          if (v === undefined) continue; // hidden -> skip
          if (isEmptyVal(v)) return { id: fld.id, label: fld.label, where: where };
        }
      }
      return null;
    }

    for (var st = 0; st < steps.length && !firstError; st++) {
      firstError = validateFields(steps[st].fields || [], values, steps[st].id);
    }

    return {
      values: values,
      valid: !firstError,
      firstError: firstError,
      schemaVersion: schema ? schema.version : undefined
    };
  }

  /* ───────────────────────── showIf visibility ───────────────────────── */

  // Re-evaluate every showIf wrapper against the current value of its controller.
  function buildRefreshVisibility(root, schema) {
    return function refreshVisibility() {
      var conds = root.querySelectorAll('[data-showif-field]');
      for (var i = 0; i < conds.length; i++) {
        var wrapEl = conds[i];
        var ctrlId = wrapEl.getAttribute("data-showif-field");
        var equals = wrapEl.getAttribute("data-showif-equals");
        // controller is the nearest field wrapper with that id in the same scope
        var scope = nearestVisibilityScope(wrapEl, root);
        var ctrlWrap = findOwnFieldWrap(scope, ctrlId);
        var cur = ctrlWrap ? String(collectLeaf(ctrlWrap)) : "";
        var show = cur === String(equals);
        wrapEl.style.display = show ? "" : "none";
        wrapEl.setAttribute("data-vrf-hidden", show ? "0" : "1");
      }
    };
  }

  // For visibility, the scope a conditional field looks in is its own group block
  // (so a showIf inside a repeated location references that location's controller).
  function nearestVisibilityScope(el, root) {
    var p = el.parentNode;
    while (p && p !== root) {
      if (p.nodeType === 1 && p.hasAttribute("data-group-index")) return p;
      p = p.parentNode;
    }
    return root;
  }

  /* ───────────────────────── public: render ───────────────────────── */

  function renderVideoRequestForm(mountEl, schema, opts) {
    opts = opts || {};
    var mode = opts.mode === "preview" ? "preview" : "form";
    clearEl(mountEl);

    var root = h("div", { className: "cp-vrf-root" });
    root.setAttribute("data-vrf-root", "1");
    mountEl.appendChild(root);

    var refreshVisibility = buildRefreshVisibility(root, schema);

    var ctx = {
      mode: mode,
      values: opts.values || {},
      locked: Array.isArray(opts.lockedFields) ? opts.lockedFields : [],
      onUpload: opts.onUpload,
      refreshVisibility: refreshVisibility,
      onChange: function () { refreshVisibility(); }
    };

    var steps = (schema && schema.steps) || [];

    /* ---- preview mode: stack ALL steps, no nav, disabled submit ---- */
    if (mode === "preview") {
      for (var s = 0; s < steps.length; s++) {
        var step = steps[s];
        var stepCard = h("section", { className: "cp-card" });
        stepCard.setAttribute("data-step-id", step.id);
        stepCard.appendChild(h("div", { className: "cp-vrf-prevhead" }, [
          h("span", { className: "cp-vrf-step-tag", textContent: "Step " + (s + 1) }),
          h("h2", { className: "cp-vrf-prevhead-title", textContent: step.title })
        ]));
        var grid = h("div", { className: "cp-vrf-step" });
        var fields = step.fields || [];
        for (var f = 0; f < fields.length; f++) {
          var el = renderField(fields[f], ctx);
          if (el) grid.appendChild(el);
        }
        stepCard.appendChild(grid);
        root.appendChild(stepCard);
      }
      root.appendChild(h("div", { className: "cp-actions" }, [
        h("button", { type: "button", disabled: true, className: CLS.btnRed, textContent: "Submit (preview)" })
      ]));
      refreshVisibility();
      return;
    }

    /* ---- form mode: wizard with progress + Back/Next/Submit ---- */
    var TOTAL = steps.length;
    var current = 0;

    var headerLabel = h("div", { className: "cp-vrf-step-label" });
    var headerCounter = h("div", { className: "cp-vrf-step-counter" });
    var progressBar = h("div", { className: "cp-vrf-progress-bar" });
    var header = h("div", { className: "cp-vrf-head" }, [
      h("div", { className: "cp-vrf-head-row" }, [headerLabel, headerCounter]),
      h("div", { className: "cp-vrf-progress-track" }, [progressBar])
    ]);

    var body = h("div", { className: "cp-vrf-body" });
    var stepEls = [];
    for (var si = 0; si < steps.length; si++) {
      var stp = steps[si];
      var sec = h("section", { className: "cp-vrf-step" });
      sec.setAttribute("data-step-id", stp.id);
      sec.setAttribute("data-step-index", String(si));
      sec.style.display = "none";
      var sFields = stp.fields || [];
      for (var sf = 0; sf < sFields.length; sf++) {
        var fe = renderField(sFields[sf], ctx);
        if (fe) sec.appendChild(fe);
      }
      body.appendChild(sec);
      stepEls.push(sec);
    }

    var backBtn = h("button", { type: "button", className: CLS.btnGhost, textContent: "Back" });
    var nextBtn = h("button", { type: "button", className: CLS.btnRed, textContent: "Next" });
    var submitBtn = h("button", { type: "button", className: CLS.btnRed, textContent: "Submit Request" });
    var nav = h("div", { className: "cp-vrf-nav" }, [
      backBtn,
      h("div", { className: "cp-vrf-nav-right" }, [nextBtn, submitBtn])
    ]);

    var card = h("div", { className: "cp-vrf-card" }, [header, body, nav]);
    root.appendChild(card);

    function updateChrome() {
      for (var i = 0; i < stepEls.length; i++) stepEls[i].style.display = (i === current ? "" : "none");
      var pct = TOTAL > 1 ? Math.round((current / (TOTAL - 1)) * 100) : 100;
      progressBar.style.width = pct + "%";
      headerLabel.textContent = steps[current] ? steps[current].title : "Step";
      headerCounter.textContent = "Step " + (current + 1) + " of " + TOTAL;
      backBtn.style.visibility = current === 0 ? "hidden" : "visible";
      var last = current === TOTAL - 1;
      nextBtn.style.display = last ? "none" : "";
      submitBtn.style.display = last ? "" : "none";
      refreshVisibility();
    }

    // Validate only the visible required fields in the current step before advancing.
    function validateCurrentStep() {
      var collected = collectVideoRequestForm(mountEl, schema);
      if (!steps[current]) return null;
      var stepFieldIds = collectStepFieldIds(steps[current]);
      if (collected.firstError && stepFieldIds.indexOf(collected.firstError.id) !== -1) {
        return collected.firstError;
      }
      // firstError may belong to a later step; only block on this step's errors.
      var localErr = firstErrorInStep(steps[current], collected.values);
      return localErr;
    }

    function goNext() {
      var err = validateCurrentStep();
      if (err) { flashError(err); return; }
      if (current < TOTAL - 1) { current++; updateChrome(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    }
    function goBack() { if (current > 0) { current--; updateChrome(); window.scrollTo({ top: 0, behavior: "smooth" }); } }

    function doSubmit() {
      var collected = collectVideoRequestForm(mountEl, schema);
      if (!collected.valid) {
        // jump to the step containing the first error
        var idx = stepIndexOfField(steps, collected.firstError.id);
        if (idx >= 0 && idx !== current) { current = idx; updateChrome(); }
        flashError(collected.firstError);
        return;
      }
      if (typeof opts.onSubmit === "function") opts.onSubmit(collected);
    }

    backBtn.addEventListener("click", goBack);
    nextBtn.addEventListener("click", goNext);
    submitBtn.addEventListener("click", doSubmit);

    current = 0;
    updateChrome();
  }

  /* ── validation helpers shared by the wizard ── */

  function collectStepFieldIds(step) {
    var ids = [];
    (function walk(fields) {
      for (var i = 0; i < fields.length; i++) {
        ids.push(fields[i].id);
        if (fields[i].type === "group" && Array.isArray(fields[i].fields)) walk(fields[i].fields);
      }
    })(step.fields || []);
    return ids;
  }

  function firstErrorInStep(step, values) {
    function check(fields, scopeVals, where) {
      for (var i = 0; i < fields.length; i++) {
        var fld = fields[i];
        if (fld.type === "heading") continue;
        var v = scopeVals[fld.id];
        if (fld.type === "group") {
          if (v === undefined) continue;
          if (fld.repeat && Array.isArray(v)) {
            for (var b = 0; b < v.length; b++) {
              var e = check(fld.fields || [], v[b] || {}, where);
              if (e) return e;
            }
          } else if (v && typeof v === "object") {
            var e2 = check(fld.fields || [], v, where);
            if (e2) return e2;
          }
          continue;
        }
        if (fld.required && v !== undefined && isEmptyVal(v)) {
          return { id: fld.id, label: fld.label, where: where };
        }
      }
      return null;
    }
    return check(step.fields || [], values, step.id);
  }

  function stepIndexOfField(steps, id) {
    for (var s = 0; s < steps.length; s++) {
      if (collectStepFieldIds(steps[s]).indexOf(id) !== -1) return s;
    }
    return -1;
  }

  function flashError(err) {
    var msg = "Please complete: " + (err.label || err.id);
    // Prefer a native dialog if present (live form has #popup); else alert.
    var dlg = document.getElementById("popup");
    var msgEl = document.getElementById("popupMsg");
    if (dlg && msgEl && typeof dlg.showModal === "function") {
      msgEl.textContent = msg;
      if (!dlg.open) dlg.showModal();
    } else {
      try { window.alert(msg); } catch (e) { console.warn(msg); }
    }
  }

  /* ───────────────────────── exports ───────────────────────── */
  window.renderVideoRequestForm = renderVideoRequestForm;
  window.collectVideoRequestForm = collectVideoRequestForm;
})();
