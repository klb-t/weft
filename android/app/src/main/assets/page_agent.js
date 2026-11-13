// Injected into the page on every platform. The same file runs in desktop
// Chromium (via CDP) and in the Android WebView. It never returns a secret value.
(function () {
  const cfg = globalThis.__weftConfig || {
    secret_types: ["password"],
    secret_autocomplete: ["current-password", "new-password", "cc-number", "cc-csc", "cc-exp", "cc-name"],
    secret_name_regex: "password|passwd|hasło|haslo|cvv|cvc|\\botp\\b|\\bpin\\b",
    max_text: 400,
  };
  const max = cfg.max_text || 400;

  function nameRegex() {
    try {
      return new RegExp(cfg.secret_name_regex, "i");
    } catch (e) {
      return null;
    }
  }

  function isSecret(el) {
    if (!el || el.nodeType !== 1) return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if ((cfg.secret_types || []).some((t) => String(t).toLowerCase() === type)) return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if ((cfg.secret_autocomplete || []).some((a) => ac.includes(String(a).toLowerCase()))) return true;
    const re = nameRegex();
    if (!re) return false;
    const blob = [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("aria-label"), el.placeholder]
      .filter(Boolean)
      .join(" ");
    return re.test(blob);
  }

  function clip(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function labelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria);
    if (el.id && window.CSS && CSS.escape) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) return clip(lab.textContent);
    }
    return clip(el.innerText || el.textContent || el.getAttribute("placeholder") || el.getAttribute("name") || "");
  }

  function nodes() {
    return Array.from(
      document.querySelectorAll(
        'a,button,input,textarea,select,summary,[role="button"],[role="link"],[contenteditable="true"]',
      ),
    ).slice(0, 200);
  }

  function refOf(el, index) {
    if (!el.dataset.weftRef) el.dataset.weftRef = "e" + (index + 1);
    return el.dataset.weftRef;
  }

  function byRef(ref) {
    const list = nodes();
    for (let i = 0; i < list.length; i++) if (refOf(list[i], i) === ref) return list[i];
    return null;
  }

  function snapshot() {
    const elements = nodes().map((el, i) => {
      const secret = isSecret(el);
      const item = {
        ref: refOf(el, i),
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        name: labelOf(el),
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") || "").toLowerCase(),
        autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(),
        secret,
      };
      if (!secret && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value) {
        item.value_preview = clip(el.value).slice(0, 80);
      }
      return item;
    });
    return {
      schema: "loom.weft.snapshot/1",
      url: String(location.href),
      title: document.title || "",
      elements,
      has_password_field: elements.some((e) => e.secret && (e.type === "password" || e.autocomplete.includes("password"))),
      has_payment_field: elements.some((e) => e.autocomplete.indexOf("cc-") === 0),
      permission_prompt: false,
    };
  }

  function fire(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function act(action) {
    const op = action && action.op;
    if (op === "scroll") {
      window.scrollBy(0, Number(action.dy || 400));
      return { ok: true };
    }
    if (op === "wait") return { ok: true };
    const el = action && action.ref ? byRef(action.ref) : null;
    const needs = ["click", "type", "fill", "press", "hover", "select", "extract", "focus"];
    if (needs.includes(op) && !el) return { ok: false, error: "missing_ref" };
    if ((op === "type" || op === "fill" || op === "select") && isSecret(el)) {
      return { ok: false, error: "secret_refused_by_page" };
    }
    if (op === "click") {
      el.click();
      return { ok: true };
    }
    if (op === "hover") {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return { ok: true };
    }
    if (op === "focus") {
      el.focus();
      return { ok: true };
    }
    if (op === "extract") return { ok: true, text: isSecret(el) ? "" : clip(el.innerText || el.textContent) };
    if (op === "type" || op === "fill" || op === "select") {
      el.focus();
      el.value = action.text || action.value || "";
      fire(el);
      return { ok: true };
    }
    if (op === "press") {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: action.key || "Enter", bubbles: true }));
      return { ok: true };
    }
    if (op === "submit") {
      const form = el ? el.form || el.closest("form") : document.querySelector("form");
      if (!form) return { ok: false, error: "missing_form" };
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
      return { ok: true };
    }
    return { ok: false, error: "page_op" };
  }

  function fillTrusted(ref, text) {
    const el = byRef(ref);
    if (!el) return { ok: false, error: "missing_ref" };
    el.focus();
    el.value = String(text);
    fire(el);
    return { ok: true, echoed: false };
  }

  globalThis.__weft = { snapshot, act, fillTrusted, isSecret };
})();
