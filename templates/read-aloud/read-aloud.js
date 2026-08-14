"use strict";
(() => {
  // src/content/read-aloud-signal.ts
  var READ_ALOUD_STOP = "GLASSDOCS_READ_ALOUD_STOP";
  var READ_ALOUD_STARTED = "GLASSDOCS_READ_ALOUD_STARTED";
  function isReadAloudSignal(event, type) {
    const w = globalThis.window;
    if (!w || event.source !== w) return false;
    if (event.origin !== globalThis.location?.origin) return false;
    return event.data?.type === type;
  }
  function postReadAloudSignal(type) {
    const w = globalThis.window;
    if (!w) return;
    try {
      w.postMessage({ type }, globalThis.location?.origin ?? "/");
    } catch {
    }
  }

  // src/content/readable-text.ts
  var FLOAT_BAR_ID = "glassdocs-float-bar";
  var READ_ALOUD_ID = "glassdocs-read-aloud";
  var NODE_ELEMENT = 1;
  var NODE_TEXT = 3;
  var INLINE = /* @__PURE__ */ new Set([
    "A",
    "ABBR",
    "B",
    "BDI",
    "BDO",
    "BR",
    "BUTTON",
    "CITE",
    "CODE",
    "DATA",
    "DEL",
    "DFN",
    "EM",
    "I",
    "INS",
    "KBD",
    "LABEL",
    "MARK",
    "Q",
    "RP",
    "RT",
    "RUBY",
    "S",
    "SAMP",
    "SMALL",
    "SPAN",
    "STRONG",
    "SUB",
    "SUP",
    "TIME",
    "U",
    "VAR",
    "WBR"
  ]);
  var KIND = {
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    LI: "listitem"
  };
  function isSkipped(el) {
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NAV") return true;
    if (el.id === FLOAT_BAR_ID || el.id === READ_ALOUD_ID) return true;
    if (tag === "A" && el.classList?.contains("headerlink")) return true;
    if (el.hidden === true) return true;
    return false;
  }
  function flush(ctx) {
    const text = ctx.buf.join("").replace(/\s+/g, " ").trim();
    ctx.buf.length = 0;
    if (!text) return;
    const block = { kind: ctx.kind, text };
    if (ctx.kind === "heading" && ctx.level) block.level = ctx.level;
    if (ctx.id) block.id = ctx.id;
    ctx.out.push(block);
  }
  function idOf(el) {
    const id = el.id;
    return typeof id === "string" && id !== "" ? id : void 0;
  }
  function isHidden(el, ctx) {
    if (isSkipped(el)) return true;
    return ctx.vis && typeof el.checkVisibility === "function" && !el.checkVisibility();
  }
  function walk(node, ctx) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === NODE_TEXT) {
        ctx.buf.push(child.nodeValue ?? "");
        continue;
      }
      if (child.nodeType !== NODE_ELEMENT) continue;
      const el = child;
      if (isHidden(el, ctx)) continue;
      const tag = el.tagName;
      if (INLINE.has(tag)) {
        walk(el, ctx);
        continue;
      }
      flush(ctx);
      if (tag === "PRE") {
        const code = (el.textContent ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
        if (code) {
          const block = { kind: "code", text: code };
          const anchor = idOf(el) ?? ctx.id;
          if (anchor) block.id = anchor;
          ctx.out.push(block);
        }
        continue;
      }
      const saved = { kind: ctx.kind, level: ctx.level, id: ctx.id };
      const kind = KIND[tag];
      if (kind) {
        ctx.kind = kind;
        ctx.level = kind === "heading" ? Number(tag.slice(1)) : void 0;
      }
      ctx.id = idOf(el) ?? saved.id;
      walk(el, ctx);
      flush(ctx);
      ctx.kind = saved.kind;
      ctx.level = saved.level;
      ctx.id = saved.id;
    }
  }
  function mainContentRoot(doc = document) {
    for (const sel of ["main article", "article", '[role="main"]', "main"]) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return doc.body;
  }
  function readableBlocks(root = document.body) {
    if (!root) return [];
    const ctx = {
      out: [],
      buf: [],
      kind: "para",
      id: idOf(root),
      vis: typeof root.checkVisibility === "function" && root.checkVisibility()
    };
    walk(root, ctx);
    flush(ctx);
    return ctx.out;
  }

  // src/lib/published-audio.ts
  var AUDIO_FILE_RE = /^\/audio\/gd-audio-[0-9a-f]{20}\.[A-Za-z0-9]+$/;
  var SHA_RE = /^[0-9a-f]{40}$/;
  function metaContent(doc, name, pattern) {
    const raw = doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content");
    if (typeof raw !== "string" || !pattern.test(raw)) return null;
    return raw;
  }
  function readAudioMetaFromDom(doc) {
    return {
      file: metaContent(doc, "audio-file", AUDIO_FILE_RE),
      audioSha: metaContent(doc, "audio-sha", SHA_RE),
      pageSha: metaContent(doc, "source-sha", SHA_RE)
    };
  }
  function resolvePublishedAudio(file, audioSha, pageSha) {
    if (typeof file !== "string" || !AUDIO_FILE_RE.test(file)) return { state: "none" };
    if (typeof audioSha !== "string" || !SHA_RE.test(audioSha)) return { state: "none" };
    if (typeof pageSha !== "string" || !SHA_RE.test(pageSha)) return { state: "none" };
    if (audioSha !== pageSha) return { state: "stale" };
    return { state: "play", file };
  }
  function mimeForClip(file) {
    if (typeof file !== "string") return null;
    const dot = file.lastIndexOf(".");
    if (dot < 0) return null;
    switch (file.slice(dot + 1).toLowerCase()) {
      case "opus":
        return "audio/ogg; codecs=opus";
      case "mp3":
        return "audio/mpeg";
      default:
        return null;
    }
  }

  // src/sidepanel/clip-source.ts
  var CLIP_LABEL = "AI voice";
  function createClipSource(doc, url) {
    const el = doc.createElement("audio");
    el.preload = "none";
    el.src = url;
    const endedFns = [];
    const errorFns = [];
    let live = false;
    const fail = (why) => {
      if (!live) return;
      live = false;
      for (const fn of [...errorFns]) fn(why);
    };
    el.addEventListener("ended", () => {
      if (!live) return;
      live = false;
      for (const fn of [...endedFns]) fn();
    });
    el.addEventListener("error", () => {
      fail(`clip playback failed (media error ${el.error?.code ?? "unknown"})`);
    });
    return {
      label: CLIP_LABEL,
      start() {
        live = true;
        el.currentTime = 0;
        const p = el.play();
        if (p && typeof p.catch === "function") {
          p.catch((e) => {
            fail(`clip playback was refused (${e instanceof Error ? e.message : String(e)})`);
          });
        }
      },
      pause() {
        el.pause();
      },
      resume() {
        const p = el.play();
        if (p && typeof p.catch === "function") {
          p.catch((e) => {
            fail(`clip playback was refused (${e instanceof Error ? e.message : String(e)})`);
          });
        }
      },
      stop() {
        live = false;
        el.pause();
        el.currentTime = 0;
        el.removeAttribute("src");
        el.load();
      },
      onEnded(fn) {
        endedFns.push(fn);
      },
      onError(fn) {
        errorFns.push(fn);
      }
      // onYielded is deliberately absent — see the header.
    };
  }

  // src/sidepanel/read-aloud.ts
  var isThenable = (v) => typeof v?.then === "function";
  function createTransport(resolve, onDiagnostic) {
    let source = null;
    let current = "idle";
    let starting = false;
    const watchers = [];
    const set = (next) => {
      if (next === current) return;
      current = next;
      for (const fn of [...watchers]) fn(current);
    };
    const drop = () => {
      source?.stop();
      source = null;
    };
    const begin = (next) => {
      if (!next) {
        set("idle");
        return;
      }
      source = next;
      next.onEnded(() => {
        if (source !== next) return;
        set("ended");
      });
      next.onYielded?.(() => {
        if (source !== next) return;
        source = null;
        set("idle");
      });
      next.onError((message) => {
        if (source !== next) return;
        onDiagnostic?.("read-aloud source error", { message });
        drop();
        set("idle");
      });
      set("playing");
      return next.start();
    };
    const play = () => {
      drop();
      const next = resolve();
      return isThenable(next) ? next.then(begin) : begin(next);
    };
    return {
      state: () => current,
      async toggle() {
        if (starting) return;
        if (current === "playing") {
          source?.pause();
          set("paused");
          return;
        }
        if (current === "paused") {
          source?.resume();
          set("playing");
          return;
        }
        starting = true;
        try {
          await play();
        } finally {
          starting = false;
        }
      },
      stop() {
        drop();
        set("idle");
      },
      yieldTo() {
        source = null;
        set("idle");
      },
      onStateChange(fn) {
        watchers.push(fn);
      }
    };
  }

  // src/sidepanel/speech-source.ts
  var NOTHING_TO_READ = "Nothing to read on this page";
  var NO_LOCAL_VOICE = "No on-device voice is installed, so reading aloud would send this page to a remote speech service";
  var MAX_CHUNK = 200;
  var VOICES_TIMEOUT_MS = 2e3;
  var PAUSE_POLL_MS = 50;
  var PAUSE_CONFIRM_MS = 500;
  function getSynth() {
    return globalThis.speechSynthesis ?? null;
  }
  function getUtteranceCtor() {
    return globalThis.SpeechSynthesisUtterance ?? null;
  }
  function sentences(text) {
    const out = [];
    for (const part of text.split(new RegExp("(?<=[.!?])\\s+"))) {
      let rest = part.trim();
      if (!rest) continue;
      while (rest.length > MAX_CHUNK) {
        let cut = rest.lastIndexOf(" ", MAX_CHUNK);
        if (cut <= 0) cut = MAX_CHUNK;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) out.push(rest);
    }
    return out;
  }
  function toChunks(blocks) {
    const out = [];
    for (const block of blocks) {
      if (block.kind === "code") continue;
      let text = (block.text ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (block.kind === "heading" && !/[.!?]$/.test(text)) text += ".";
      out.push(...sentences(text));
    }
    return out;
  }
  function waitForVoices(synth) {
    return new Promise((resolve) => {
      if (typeof synth.addEventListener !== "function") {
        resolve();
        return;
      }
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== void 0) clearTimeout(timer);
        synth.removeEventListener?.("voiceschanged", finish);
        resolve();
      };
      timer = setTimeout(finish, VOICES_TIMEOUT_MS);
      synth.addEventListener("voiceschanged", finish);
    });
  }
  async function allVoices(synth) {
    const first = synth.getVoices?.() ?? [];
    if (first.length > 0) return first;
    await waitForVoices(synth);
    return synth.getVoices?.() ?? [];
  }
  function baseTag(lang) {
    return String(lang ?? "").split(/[-_]/)[0].toLowerCase();
  }
  function pickLocal(voices) {
    const local = voices.filter((v) => v.localService === true);
    if (local.length === 0) return null;
    const preferred = local.find((v) => v.default === true);
    if (preferred) return preferred;
    const want = baseTag(globalThis.navigator?.language ?? "");
    const matched = want ? local.find((v) => baseTag(v.lang) === want) : void 0;
    return matched ?? local[0];
  }
  async function resolveLocalVoice() {
    const synth = getSynth();
    if (!synth || !getUtteranceCtor()) return null;
    return pickLocal(await allVoices(synth));
  }
  function createSpeechSourceWith(blocks, voice) {
    const chunks = toChunks(blocks);
    if (chunks.length === 0) return null;
    const synth = getSynth();
    const Utterance = getUtteranceCtor();
    if (!synth || !Utterance) return null;
    let index = 0;
    let run = 0;
    let pauseRequested = false;
    let pausedByCancel = false;
    const endedFns = [];
    const errorFns = [];
    const yieldFns = [];
    const speakChunk = (i) => {
      if (i >= chunks.length) {
        for (const fn of [...endedFns]) fn();
        return;
      }
      index = i;
      const mine = run;
      const utterance = new Utterance(chunks[i]);
      utterance.voice = voice;
      utterance.onend = () => {
        if (mine !== run || pauseRequested) return;
        speakChunk(i + 1);
      };
      utterance.onerror = (event) => {
        if (mine !== run) return;
        const code = event?.error;
        if (code === "canceled" || code === "interrupted") {
          for (const fn of [...yieldFns]) fn();
          return;
        }
        for (const fn of [...errorFns]) fn(String(code ?? "speech failed"));
      };
      synth.speak(utterance);
    };
    return {
      label: "Read aloud",
      start() {
        run++;
        synth.cancel();
        pauseRequested = false;
        pausedByCancel = false;
        speakChunk(0);
      },
      pause() {
        pauseRequested = true;
        synth.pause();
        let waited = 0;
        const check = () => {
          if (!pauseRequested || synth.paused) return;
          waited += PAUSE_POLL_MS;
          if (waited < PAUSE_CONFIRM_MS) {
            setTimeout(check, PAUSE_POLL_MS);
            return;
          }
          pausedByCancel = true;
          run++;
          synth.cancel();
        };
        setTimeout(check, PAUSE_POLL_MS);
      },
      resume() {
        pauseRequested = false;
        if (pausedByCancel) {
          pausedByCancel = false;
          run++;
          speakChunk(index);
          return;
        }
        synth.resume();
      },
      stop() {
        run++;
        pauseRequested = false;
        pausedByCancel = false;
        index = 0;
        synth.cancel();
      },
      onEnded(fn) {
        endedFns.push(fn);
      },
      onError(fn) {
        errorFns.push(fn);
      },
      onYielded(fn) {
        yieldFns.push(fn);
      }
    };
  }

  // src/page/read-aloud-page.ts
  var PLAY = "\u25B6";
  var PAUSE = "\u23F8";
  var STOP = "\u23F9";
  var READ_TITLE = "Read this page aloud with a speech voice installed on your device";
  var LISTEN = "Listen";
  var AI = "AI";
  var AI_TITLE = "Play the AI-generated narration of this page";
  var LABEL_CLASS = "glassdocs-ra-label";
  var AI_LABEL_CLASS = "glassdocs-ra-ai-label";
  var GLYPH_CLASS = "glassdocs-ra-glyph";
  var BUTTON_STYLE = [
    "font:inherit",
    "line-height:1",
    "padding:0.25em 0.6em",
    "color:inherit",
    "background:transparent",
    "border:1px solid currentColor",
    "border-radius:0.35em",
    "opacity:0.75",
    "cursor:pointer"
  ].join(";");
  var HEADER_BUTTON_STYLE = [
    "font:inherit",
    "font-size:.9rem",
    "line-height:1rem",
    "color:inherit",
    "background:transparent",
    "border:0",
    "cursor:pointer"
  ].join(";");
  var HEADER_PLAY_STYLE = [HEADER_BUTTON_STYLE, "display:flex", "align-items:center", "gap:.3rem"].join(";");
  var DISABLED_STYLE = [BUTTON_STYLE, "opacity:0.4", "cursor:default"].join(";");
  var HEADER_DISABLED_STYLE = [HEADER_PLAY_STYLE, "opacity:.4", "cursor:default"].join(";");
  function button(doc, glyph, title, style) {
    const el = doc.createElement("button");
    el.type = "button";
    el.title = title;
    el.setAttribute("aria-label", title);
    el.style.cssText = style;
    const g = doc.createElement("span");
    g.className = GLYPH_CLASS;
    g.textContent = glyph;
    el.append(g);
    return el;
  }
  function labelSpan(doc, text, cls, inHeader) {
    const label = doc.createElement("span");
    label.className = cls;
    label.textContent = text;
    label.style.cssText = inHeader ? "font-size:.7rem;letter-spacing:-.025em" : "margin-left:0.4em";
    return label;
  }
  function resolveSlot(doc, root) {
    const palette = doc.querySelector('form.md-header__option[data-md-component="palette"]');
    if (palette?.parentNode) {
      return { parent: palette.parentNode, before: palette.nextSibling, placement: "header" };
    }
    const nav = doc.querySelector("nav.md-header__inner");
    if (nav) {
      return { parent: nav, before: nav.querySelector(".md-header__source"), placement: "header" };
    }
    const h1 = root.querySelector("h1");
    if (h1?.parentNode) {
      return { parent: h1.parentNode, before: h1.nextSibling, placement: "article" };
    }
    return { parent: root, before: root.firstChild, placement: "article" };
  }
  var STYLE_ID = "glassdocs-read-aloud-style";
  var HEADER_CSS = `#${READ_ALOUD_ID}[data-placement=header] .${LABEL_CLASS}{display:none}@media screen and (min-width:60em){#${READ_ALOUD_ID}[data-placement=header] .${LABEL_CLASS}{display:inline}}`;
  function injectHeaderStyle(doc) {
    const host = doc.head ?? doc.documentElement;
    if (!host || host.querySelector(`#${STYLE_ID}`)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = HEADER_CSS;
    host.appendChild(style);
  }
  function mount(doc, root, voice, reason, clip) {
    const slot = resolveSlot(doc, root);
    const inHeader = slot.placement === "header";
    const bar = doc.createElement("div");
    bar.id = READ_ALOUD_ID;
    bar.dataset.placement = slot.placement;
    bar.style.cssText = inHeader ? "display:flex;align-items:center;margin:0" : "display:flex;gap:0.4em;align-items:center;margin:0 0 1.2em";
    const title = voice ? READ_TITLE : reason ?? READ_TITLE;
    const playBtn = button(doc, PLAY, title, inHeader ? HEADER_PLAY_STYLE : BUTTON_STYLE);
    const aiBtn = clip ? button(doc, PLAY, AI_TITLE, inHeader ? HEADER_PLAY_STYLE : BUTTON_STYLE) : null;
    const stopBtn = button(doc, STOP, "Stop reading", inHeader ? HEADER_BUTTON_STYLE : BUTTON_STYLE);
    if (inHeader) {
      playBtn.className = "md-header__button";
      if (aiBtn) aiBtn.className = "md-header__button";
      stopBtn.className = "md-header__button";
      injectHeaderStyle(doc);
    }
    playBtn.append(labelSpan(doc, LISTEN, LABEL_CLASS, inHeader));
    if (aiBtn) aiBtn.append(labelSpan(doc, AI, AI_LABEL_CLASS, inHeader));
    stopBtn.hidden = true;
    if (aiBtn) bar.append(playBtn, aiBtn, stopBtn);
    else bar.append(playBtn, stopBtn);
    if (!voice) {
      playBtn.disabled = true;
      playBtn.style.cssText = inHeader ? HEADER_DISABLED_STYLE : DISABLED_STYLE;
    }
    if (!voice && !clip) {
      slot.parent.insertBefore(bar, slot.before);
      return;
    }
    let pending = voice ? "tts" : "clip";
    let active = null;
    const resolve = () => {
      if (pending === "clip") {
        if (!clip) return null;
        const source2 = createClipSource(doc, clip.file);
        active = "clip";
        postReadAloudSignal(READ_ALOUD_STARTED);
        return source2;
      }
      if (!voice) return null;
      const blocks = readableBlocks(mainContentRoot(doc));
      const source = createSpeechSourceWith(blocks, voice);
      if (source) {
        active = "tts";
        postReadAloudSignal(READ_ALOUD_STARTED);
      }
      return source;
    };
    const transport = createTransport(resolve);
    globalThis.window?.addEventListener("message", (event) => {
      if (!isReadAloudSignal(event, READ_ALOUD_STOP)) return;
      transport.stop();
    });
    const playGlyph = playBtn.querySelector(`.${GLYPH_CLASS}`);
    const aiGlyph = aiBtn ? aiBtn.querySelector(`.${GLYPH_CLASS}`) : null;
    const paint = (btn, glyphEl, resting, mine, state) => {
      const isActive = active === mine;
      const playing = isActive && state === "playing";
      if (glyphEl) glyphEl.textContent = playing ? PAUSE : PLAY;
      const next = playing ? "Pause reading" : isActive && state === "paused" ? "Resume reading" : resting;
      btn.title = next;
      btn.setAttribute("aria-label", next);
    };
    transport.onStateChange((state) => {
      if (state === "idle" || state === "ended") active = null;
      paint(playBtn, playGlyph, title, "tts", state);
      if (aiBtn) paint(aiBtn, aiGlyph, AI_TITLE, "clip", state);
      stopBtn.hidden = !(state === "playing" || state === "paused");
    });
    const startWith = (which) => {
      if (active && active !== which) transport.stop();
      pending = which;
      void transport.toggle();
    };
    if (voice) playBtn.addEventListener("click", () => startWith("tts"));
    if (aiBtn) aiBtn.addEventListener("click", () => startWith("clip"));
    stopBtn.addEventListener("click", () => transport.stop());
    globalThis.window?.addEventListener("pagehide", () => transport.stop());
    slot.parent.insertBefore(bar, slot.before);
  }
  function resolveClip(doc) {
    const meta = readAudioMetaFromDom(doc);
    const verdict = resolvePublishedAudio(meta.file, meta.audioSha, meta.pageSha);
    if (verdict.state !== "play" || !verdict.file) return null;
    const mime = mimeForClip(verdict.file);
    if (!mime) return null;
    const probe = doc.createElement("audio");
    if (typeof probe.canPlayType !== "function") return null;
    if (probe.canPlayType(mime) === "") return null;
    return { file: verdict.file };
  }
  async function initReadAloudPage(doc = document) {
    const root = mainContentRoot(doc);
    if (!root) return false;
    const clip = resolveClip(doc);
    if (toChunks(readableBlocks(root)).length === 0) {
      mount(doc, root, null, NOTHING_TO_READ, clip);
      return true;
    }
    const voice = await resolveLocalVoice();
    if (!voice) {
      mount(doc, root, null, NO_LOCAL_VOICE, clip);
      return true;
    }
    mount(doc, root, voice, null, clip);
    return true;
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => void initReadAloudPage());
    } else {
      void initReadAloudPage();
    }
  }
})();
