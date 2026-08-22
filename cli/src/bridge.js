/*
 * The CLI<->page bridge. This file is NOT part of the app: the server injects a
 * <script> tag for it into index.html only when it is serving in `send` or
 * `receive` mode. The GitHub Pages build never sees it, and app/ is untouched.
 *
 * Everything here drives the app's own UI — the file input, the textarea, the
 * tabs, the Save button. It never reaches inside React state. That keeps the
 * coupling down to what a human could do by hand, which is the only interface
 * a browser-only app (ADR-0007) actually offers the outside world.
 */
(function () {
  "use strict";
  var CFG = window.__LIGHTPIPE__;
  if (!CFG || location.search.indexOf("lightpipe=off") >= 0) return;

  function log() {
    console.log.apply(console, ["[lightpipe cli]"].concat([].slice.call(arguments)));
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Polling, deliberately, not a MutationObserver. The send view mutates its
  // stats on every animation frame, so an observer would re-run the search
  // thousands of times a second and starve the rAF loop that draws the frames —
  // which showed up as a sender stuck on picture 1 and a receiver that could
  // never finish.
  function waitFor(find, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var got = find();
      if (got) return resolve(got);
      var deadline = Date.now() + (timeoutMs || 30000);
      var t = setInterval(function () {
        var g = find();
        if (g) {
          clearInterval(t);
          resolve(g);
        } else if (Date.now() > deadline) {
          clearInterval(t);
          reject(new Error("timed out waiting for the page"));
        }
      }, 250);
    });
  }

  function byText(sel, re) {
    return [].slice.call(document.querySelectorAll(sel)).find(function (el) {
      return re.test((el.textContent || "").trim());
    });
  }

  function tell(payload) {
    // Best-effort: the terminal is nicer with it, nothing breaks without it.
    return fetch("/__status", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-lp-token": CFG.token },
      body: JSON.stringify(payload),
    }).catch(function () {});
  }

  /* ---- the bottom bar: status, and the one thing that needs a real click -- */

  function bar(kind, html, withFullscreen, action) {
    var el = document.getElementById("lp-bar");
    if (!el) {
      el = document.createElement("div");
      el.id = "lp-bar";
      document.body.appendChild(el);
    }
    el.setAttribute("data-kind", kind);
    el.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;gap:14px;align-items:center;" +
      "padding:12px 16px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "background:" + (kind === "bad" ? "#5c161b" : "#0d3b2e") + ";color:#eaf3f0;" +
      "border-top:1px solid rgba(255,255,255,.2)";
    el.innerHTML = '<span style="flex:1">' + html + "</span>";
    var bigButton =
      "flex:0 0 auto;cursor:pointer;font:600 15px/1 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "padding:12px 20px;border-radius:10px;border:0;background:#eaf3f0;color:#0d3b2e";
    if (action) {
      // A real click. getDisplayMedia refuses to open its picker without one.
      var go = document.createElement("button");
      go.id = "lp-action";
      go.textContent = action.label;
      go.style.cssText = bigButton;
      go.onclick = function () {
        go.disabled = true;
        go.textContent = "starting…";
        action.onClick();
      };
      el.appendChild(go);
    }
    if (withFullscreen && document.fullscreenEnabled) {
      var b = document.createElement("button");
      b.id = "lp-fullscreen";
      b.textContent = "⛶  Go fullscreen";
      b.style.cssText = bigButton;
      // Fullscreen is the ONE thing a script cannot do for you: the browser
      // requires a real user gesture. The frame filling the screen is what the
      // camera has to read, so this button is deliberately large.
      b.onclick = function () {
        var t = document.querySelector("canvas") || document.documentElement;
        (t.requestFullscreen ? t.requestFullscreen() : Promise.reject(new Error("unsupported"))).then(
          function () { b.textContent = "⛶  Fullscreen"; },
          function (e) { log("fullscreen refused:", e.message); },
        );
      };
      el.appendChild(b);
    }
    return el;
  }

  /* ---- send ------------------------------------------------------------- */

  // React remembers the DOM value it last wrote; a plain `.value =` is ignored
  // on the next render unless the native setter is used.
  function setNativeValue(el, value) {
    var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function scrapeManifest() {
    var code = document.querySelector(".code.big");
    if (!code || !/^[0-9A-Z]{6}$/.test((code.textContent || "").trim())) return null;
    var wire = 0;
    var dl = document.querySelector("dl.kv");
    if (dl) {
      var kids = [].slice.call(dl.children);
      for (var i = 0; i < kids.length - 1; i++) {
        if (kids[i].tagName === "DT" && /on the wire/i.test(kids[i].textContent || "")) {
          var m = (kids[i + 1].textContent || "").match(/\(([\d,]+)\s*B\)/);
          if (m) wire = Number(m[1].replace(/,/g, ""));
        }
      }
    }
    return { code: (code.textContent || "").trim(), wireBytes: wire };
  }

  async function doSend() {
    var res = await fetch("/__payload", { cache: "no-store" });
    if (!res.ok) throw new Error("the CLI has no payload to send (HTTP " + res.status + ")");
    var name = decodeURIComponent(res.headers.get("x-lp-name") || "payload.bin");
    var mime = (res.headers.get("content-type") || "application/octet-stream").split(";")[0];
    var blob = await res.blob();
    log("payload", name, mime, blob.size + " B");

    // React has not necessarily painted the tabs yet at DOMContentLoaded.
    (await waitFor(function () { return byText("nav.tabs button", /^Send$/); })).click();

    if (CFG.asText) {
      // Text goes in via the textarea so the app applies its OWN note.md /
      // text/markdown envelope defaults instead of the CLI inventing them.
      (await waitFor(function () { return byText("button", /^Text \/ note$/); })).click();
      var ta = await waitFor(function () { return document.querySelector("textarea.note-input, textarea"); });
      setNativeValue(ta, await blob.text());
      (await waitFor(function () {
        var b = byText("button", /^Use this note$/);
        return b && !b.disabled ? b : null;
      })).click();
    } else {
      (await waitFor(function () { return byText("button", /^File$/); })).click();
      var input = await waitFor(function () { return document.querySelector('input[type="file"]'); });
      var dt = new DataTransfer();
      dt.items.add(new File([blob], name, { type: mime }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Scrape the manifest BEFORE starting: that panel is hidden while sending.
    var man = await waitFor(scrapeManifest, 120000).catch(function () { return null; });
    await tell({ event: "sending", name: name, size: blob.size, mime: mime, code: man && man.code, wireBytes: man && man.wireBytes });

    var start = await waitFor(function () {
      var b = byText("button", /^Start sending$/);
      return b && !b.disabled ? b : null;
    }, 120000);
    start.click(); // rendering frames needs no user gesture — this really is automatic
    log("broadcasting", name, man && man.code);
    bar(
      "ok",
      "<b>lightpipe</b> — broadcasting <b>" + esc(name) + "</b> · " + blob.size + " B · code <b>" +
        esc((man && man.code) || "??????") + "</b>. Nothing is sent back: watch the receiving device.",
      true,
    );
  }

  /* ---- receive ---------------------------------------------------------- */

  function hex(buf) {
    return [].map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function displayCode() {
    var el = document.querySelector(".notice.ok strong");
    var m = el && (el.textContent || "").match(/COMPLETE\s*✓\s*([0-9A-Z]{6})/);
    if (m) return m[1];
    var big = document.querySelector(".code.big");
    return big ? (big.textContent || "").trim() : "";
  }

  var posting = false;
  async function postBack(blob, name) {
    if (posting) return;
    posting = true;
    var code = displayCode();
    var digest = hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    var res = await fetch("/__save", {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": blob.type || "application/octet-stream",
        "x-lp-token": CFG.token,
        "x-lp-name": encodeURIComponent(name || "received.bin"),
        "x-lp-code": code,
        "x-lp-sha256": digest,
      },
      body: blob,
    });
    var body = (await res.text()).trim();
    if (!res.ok) throw new Error("HTTP " + res.status + " " + body);
    log("written by the CLI:", body);
    bar("ok", "<b>lightpipe</b> — written to <b>" + esc(body) + "</b> · code <b>" + esc(code || "??????") + "</b>. Compare it with the sending screen.");
  }

  function armSaveInterception() {
    // Force the portable download path, so there is exactly one place to hook.
    try { delete window.showSaveFilePicker; } catch (e) { /* ignore */ }
    window.showSaveFilePicker = undefined;

    var origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      var self = this;
      if (self.download && /^blob:/.test(self.href || "")) {
        fetch(self.href)
          .then(function (r) { return r.blob(); })
          .then(function (b) { return postBack(b, self.download); })
          .catch(function (err) {
            // Never hang: fall back to the download the app would have done.
            log("POST /__save failed, falling back to a browser download:", err.message);
            bar("bad", "<b>lightpipe</b> — the CLI could not write the file (" + esc(err.message) + "). Falling back to a normal browser download.");
            posting = false;
            HTMLAnchorElement.prototype.click = origClick;
            origClick.call(self);
          });
        return;
      }
      return origClick.apply(self, arguments);
    };
  }

  // The React select remembers the value it last wrote, so a plain assignment
  // is reverted on the next render; go through the native setter.
  function selectSource(value) {
    var sel = [].slice.call(document.querySelectorAll("select")).find(function (s) {
      return s.querySelector('option[value="' + value + '"]') && s.querySelector('option[value="camera"]');
    });
    if (!sel) return false;
    setNativeValue(sel, value);
    return sel.value === value;
  }

  async function doReceive() {
    if (CFG.save) armSaveInterception();
    (await waitFor(function () { return byText("nav.tabs button", /^Receive$/); })).click();
    var start = await waitFor(function () {
      var b = byText("button", /^Start receiving$/);
      return b && !b.disabled ? b : null;
    });
    var source = CFG.source === "screen" ? "screen" : "camera";
    var picked = selectSource(source);
    await new Promise(function (r) { setTimeout(r, 120); });

    if (source === "screen") {
      // getDisplayMedia REQUIRES transient activation: a scripted click cannot
      // open the window picker. So the gesture is handed to the user, once.
      bar(
        "ok",
        "<b>lightpipe</b> — ready to capture a screen or window." +
          (CFG.save ? " The finished file will be written to disk by the CLI." : "") +
          " The browser will not open its picker without a real click, so press this:",
        false,
        { label: "▶  Start screen capture", onClick: function () { (byText("button", /^Start receiving$/) || start).click(); } },
      );
      await tell({ event: "receiving", save: !!CFG.save, source: source, needsClick: true, sourceSelected: picked });
      return armSaveWatch();
    }

    // Camera access needs a permission grant. Already granted for this origin
    // -> this starts capturing with no click. First run -> the browser prompts.
    start.click();
    await tell({ event: "receiving", save: !!CFG.save, source: source, needsClick: false, sourceSelected: picked });
    bar("ok", "<b>lightpipe</b> — receiving from the camera." + (CFG.save ? " The finished file will be written to disk by the CLI." : "") + " Allow the camera if the browser asks.");
    return armSaveWatch();
  }

  async function armSaveWatch() {
    if (!CFG.save) return;
    // The app only materialises the file when Save is pressed; press it.
    var saveBtn = await waitFor(function () {
      var b = byText("button", /^Save\s/);
      return b && !b.disabled ? b : null;
    }, 6 * 60 * 60 * 1000);
    saveBtn.click();
  }

  function go() {
    var run = CFG.mode === "send" ? doSend : CFG.mode === "receive" ? doReceive : null;
    if (!run) return;
    run().catch(function (err) {
      log("failed:", err.message);
      void tell({ event: "error", message: err.message });
      bar("bad", "<b>lightpipe</b> — the CLI could not drive the page: " + esc(err.message) + ". Carry on by hand.", CFG.mode === "send");
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
  else go();
})();
