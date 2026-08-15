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
  function isSkipped(el2) {
    const tag = el2.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NAV") return true;
    if (el2.id === FLOAT_BAR_ID || el2.id === READ_ALOUD_ID) return true;
    if (tag === "A" && el2.classList?.contains("headerlink")) return true;
    if (el2.hidden === true) return true;
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
  function idOf(el2) {
    const id = el2.id;
    return typeof id === "string" && id !== "" ? id : void 0;
  }
  function isHidden(el2, ctx) {
    if (isSkipped(el2)) return true;
    return ctx.vis && typeof el2.checkVisibility === "function" && !el2.checkVisibility();
  }
  function walk(node, ctx) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === NODE_TEXT) {
        ctx.buf.push(child.nodeValue ?? "");
        continue;
      }
      if (child.nodeType !== NODE_ELEMENT) continue;
      const el2 = child;
      if (isHidden(el2, ctx)) continue;
      const tag = el2.tagName;
      if (INLINE.has(tag)) {
        walk(el2, ctx);
        continue;
      }
      flush(ctx);
      if (tag === "PRE") {
        const code = (el2.textContent ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
        if (code) {
          const block = { kind: "code", text: code };
          const anchor = idOf(el2) ?? ctx.id;
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
      ctx.id = idOf(el2) ?? saved.id;
      walk(el2, ctx);
      flush(ctx);
      ctx.kind = saved.kind;
      ctx.level = saved.level;
      ctx.id = saved.id;
    }
  }
  function mainContentRoot(doc = document) {
    for (const sel of ["main article", "article", '[role="main"]', "main"]) {
      const el2 = doc.querySelector(sel);
      if (el2) return el2;
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
  var NO_ITEMS = Object.freeze([]);
  var CLIP_LABEL = "AI voice";
  function createClipSource(doc, url) {
    const el2 = doc.createElement("audio");
    el2.preload = "none";
    el2.src = url;
    const endedFns = [];
    const errorFns = [];
    const progressFns = [];
    const emitProgress = () => {
      const p = {
        index: 0,
        total: 1,
        charIndex: null,
        seconds: Number.isFinite(el2.currentTime) ? el2.currentTime : 0,
        duration: Number.isFinite(el2.duration) ? el2.duration : null
      };
      for (const fn of [...progressFns]) fn(p);
    };
    el2.addEventListener("timeupdate", emitProgress);
    el2.addEventListener("loadedmetadata", emitProgress);
    let live = false;
    const fail = (why) => {
      if (!live) return;
      live = false;
      for (const fn of [...errorFns]) fn(why);
    };
    el2.addEventListener("ended", () => {
      if (!live) return;
      live = false;
      for (const fn of [...endedFns]) fn();
    });
    el2.addEventListener("error", () => {
      fail(`clip playback failed (media error ${el2.error?.code ?? "unknown"})`);
    });
    return {
      label: CLIP_LABEL,
      start() {
        live = true;
        el2.currentTime = 0;
        const p = el2.play();
        if (p && typeof p.catch === "function") {
          p.catch((e) => {
            fail(`clip playback was refused (${e instanceof Error ? e.message : String(e)})`);
          });
        }
      },
      pause() {
        el2.pause();
      },
      resume() {
        const p = el2.play();
        if (p && typeof p.catch === "function") {
          p.catch((e) => {
            fail(`clip playback was refused (${e instanceof Error ? e.message : String(e)})`);
          });
        }
      },
      stop() {
        live = false;
        el2.pause();
        el2.currentTime = 0;
        el2.removeAttribute("src");
        el2.load();
      },
      onEnded(fn) {
        endedFns.push(fn);
      },
      onError(fn) {
        errorFns.push(fn);
      },
      // onYielded is deliberately absent — see the header.
      // ── position and seeking (#214) ──────────────────────────────────
      items: NO_ITEMS,
      /** Native, exact and continuous. The player's bar is draggable for this
       *  source and this source only, because this is the only one that can land
       *  where the reader put the thumb. */
      seek: "seconds",
      seekTo(seconds) {
        el2.currentTime = Math.min(el2.duration || 0, Math.max(0, seconds));
        emitProgress();
      },
      onProgress(fn) {
        progressFns.push(fn);
      }
    };
  }

  // src/sidepanel/read-aloud.ts
  var isThenable = (v) => typeof v?.then === "function";
  function createTransport(resolve, onDiagnostic) {
    let source = null;
    let current = "idle";
    let starting = false;
    const watchers = [];
    const progressWatchers = [];
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
      next.onProgress((p) => {
        if (source !== next) return;
        for (const fn of [...progressWatchers]) fn(p);
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
      },
      onProgress(fn) {
        progressWatchers.push(fn);
      },
      seekUnit: () => source?.seek ?? null,
      seekTo(position) {
        source?.seekTo(position);
      },
      items: () => source?.items ?? []
    };
  }

  // src/sidepanel/read-aloud-player.ts
  var SKIP_SECONDS = 10;
  var CLASS_ROOT = "glassdocs-ra-player";
  var CLASS_BAR = "glassdocs-ra-bar";
  var CLASS_FILL = "glassdocs-ra-fill";
  var CLASS_POSITION = "glassdocs-ra-position";
  var CLASS_TRANSPORT = "glassdocs-ra-transport";
  var CLASS_STOP = "glassdocs-ra-stop";
  var CLASS_PREV = "glassdocs-ra-prev";
  var CLASS_NEXT = "glassdocs-ra-next";
  var CLASS_NOW = "glassdocs-ra-now";
  var CLASS_COMING = "glassdocs-ra-coming";
  var CLASS_READ = "glassdocs-ra-read";
  var CLASS_SECTION_ROW = "glassdocs-ra-section";
  function groupSections(items) {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const section = items[i].section;
      const last = out[out.length - 1];
      if (last && last.section === section) last.count++;
      else out.push({ section, from: i, count: 1 });
    }
    return out;
  }
  function groupIndexOf(groups, index) {
    for (let g = groups.length - 1; g >= 0; g--) if (index >= groups[g].from) return g;
    return groups.length ? 0 : -1;
  }
  function totalChars(items) {
    let n = 0;
    for (const item of items) n += item.text.length;
    return n;
  }
  function charsBefore(items, index) {
    let n = 0;
    for (let i = 0; i < index && i < items.length; i++) n += items[i].text.length;
    return n;
  }
  function barFraction(snap) {
    if (snap.state === "ended") return 1;
    const p = snap.progress;
    if (!p) return 0;
    if (snap.seek === "seconds" || snap.items.length === 0) {
      if (p.duration == null || p.duration <= 0 || p.seconds == null) return 0;
      return clamp01(p.seconds / p.duration);
    }
    const total = totalChars(snap.items);
    if (total <= 0) return 0;
    const done = charsBefore(snap.items, p.index) + (p.charIndex ?? 0);
    return clamp01(done / total);
  }
  function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
  }
  function etaSeconds(fraction, elapsedPlayingMs, completedItems) {
    if (completedItems < 1) return null;
    if (!(fraction > 0) || fraction >= 1) return null;
    if (!(elapsedPlayingMs > 0)) return null;
    return elapsedPlayingMs / 1e3 * ((1 - fraction) / fraction);
  }
  function formatEta(seconds) {
    if (seconds < 45) return "about a minute left (est.)";
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `about ${Math.max(1, mins)} min left (est.)`;
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return `about ${hours} h ${rest} min left (est.)`;
  }
  function formatClock(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "\u2013:\u2013";
    const whole = Math.floor(seconds);
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }
  function positionLine(snap, elapsedPlayingMs) {
    const p = snap.progress;
    if (snap.items.length === 0) {
      const seconds = p?.seconds ?? null;
      const duration = p?.duration ?? null;
      return `${formatClock(seconds)} / ${formatClock(duration)}`;
    }
    const index = p?.index ?? 0;
    const groups = groupSections(snap.items);
    const named = groups.some((g2) => g2.section !== null);
    const g = groupIndexOf(groups, index);
    const where = named ? `Section ${g + 1} of ${groups.length}` : `Sentence ${Math.min(index + 1, snap.items.length)} of ${snap.items.length}`;
    const eta = etaSeconds(barFraction(snap), elapsedPlayingMs, index);
    return eta == null ? where : `${where} \xB7 ${formatEta(eta)}`;
  }
  function fractionAt(clientX, rect) {
    if (!(rect.width > 0)) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  }
  function el(doc, tag, cls, style = "") {
    const node = doc.createElement(tag);
    node.className = cls;
    if (style) node.style.cssText = style;
    return node;
  }
  function controlButton(doc, cls) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.style.cssText = "font:inherit;font-size:.8em;line-height:1;padding:.3em .5em;color:inherit;background:transparent;border:1px solid currentColor;border-radius:.3em;cursor:pointer;opacity:.85";
    return btn;
  }
  function setLabel(btn, visible, full) {
    btn.textContent = visible;
    btn.title = full;
    btn.setAttribute("aria-label", full);
  }
  function createReadAloudPlayer(doc, host, now = () => Date.now()) {
    const root = el(doc, "div", CLASS_ROOT, "display:flex;flex-direction:column;gap:.45em");
    const bar = el(
      doc,
      "div",
      CLASS_BAR,
      "position:relative;height:.5em;border-radius:.25em;background:currentColor;opacity:.25;overflow:hidden"
    );
    const fill = el(doc, "div", CLASS_FILL, "position:absolute;left:0;top:0;bottom:0;width:0%;background:currentColor");
    bar.append(fill);
    const barWrap = el(doc, "div", "glassdocs-ra-bar-wrap", "padding:.2em 0");
    barWrap.append(bar);
    const position = el(doc, "div", CLASS_POSITION, "font-size:.75em;opacity:.85");
    const transport = el(doc, "div", CLASS_TRANSPORT, "display:flex;gap:.4em;align-items:center;flex-wrap:wrap");
    const stopBtn = controlButton(doc, CLASS_STOP);
    setLabel(stopBtn, "\u23F9", "Stop reading");
    const prevBtn = controlButton(doc, CLASS_PREV);
    const nextBtn = controlButton(doc, CLASS_NEXT);
    transport.append(stopBtn, prevBtn, nextBtn);
    const nowWrap = el(doc, "div", CLASS_NOW, "font-size:.78em");
    const nowHead = el(doc, "div", "glassdocs-ra-head", "opacity:.6;text-transform:uppercase;letter-spacing:.05em;font-size:.9em");
    const nowText = el(doc, "div", "glassdocs-ra-now-text", "margin-top:.15em");
    nowWrap.append(nowHead, nowText);
    const comingWrap = el(doc, "div", CLASS_COMING, "font-size:.78em");
    const comingHead = el(doc, "div", "glassdocs-ra-head", "opacity:.6;text-transform:uppercase;letter-spacing:.05em;font-size:.9em");
    comingHead.textContent = "Coming up";
    const comingList = el(doc, "div", "glassdocs-ra-coming-list", "display:flex;flex-direction:column;gap:.1em;margin-top:.15em");
    comingWrap.append(comingHead, comingList);
    const readWrap = el(doc, "div", CLASS_READ, "font-size:.78em");
    const readToggle = doc.createElement("button");
    readToggle.type = "button";
    readToggle.className = "glassdocs-ra-read-toggle";
    readToggle.style.cssText = "font:inherit;font-size:.9em;padding:0;color:inherit;background:transparent;border:0;cursor:pointer;opacity:.6;text-transform:uppercase;letter-spacing:.05em";
    const readList = el(doc, "div", "glassdocs-ra-read-list", "margin-top:.15em;opacity:.75");
    let readOpen = false;
    readList.hidden = true;
    readWrap.append(readToggle, readList);
    readToggle.addEventListener("click", () => {
      readOpen = !readOpen;
      readList.hidden = !readOpen;
      readToggle.textContent = readOpen ? "Read \u25BE" : "Read \u25B8";
      readToggle.setAttribute("aria-expanded", readOpen ? "true" : "false");
    });
    readToggle.textContent = "Read \u25B8";
    readToggle.setAttribute("aria-expanded", "false");
    root.append(barWrap, position, transport, nowWrap, comingWrap, readWrap);
    let snap = { state: "idle", items: [], seek: null, progress: null };
    let elapsedMs = 0;
    let playingSince = null;
    const elapsedPlaying = () => elapsedMs + (playingSince == null ? 0 : Math.max(0, now() - playingSince));
    const phase = (state) => {
      if (state === "playing") {
        if (playingSince == null) playingSince = now();
        return;
      }
      if (playingSince != null) {
        elapsedMs += Math.max(0, now() - playingSince);
        playingSince = null;
      }
      if (state === "idle") elapsedMs = 0;
    };
    bar.addEventListener("click", (event) => {
      if (snap.seek !== "seconds") return;
      const duration = snap.progress?.duration ?? null;
      if (duration == null || duration <= 0) return;
      const rect = bar.getBoundingClientRect();
      const x = event.clientX;
      if (typeof x !== "number") return;
      host.seekTo(fractionAt(x, rect) * duration);
    });
    stopBtn.addEventListener("click", () => host.stop());
    prevBtn.addEventListener("click", () => {
      if (snap.seek === "seconds") {
        host.seekTo(Math.max(0, (snap.progress?.seconds ?? 0) - SKIP_SECONDS));
        return;
      }
      if (snap.seek === "item") host.seekTo((snap.progress?.index ?? 0) - 1);
    });
    nextBtn.addEventListener("click", () => {
      if (snap.seek === "seconds") {
        host.seekTo((snap.progress?.seconds ?? 0) + SKIP_SECONDS);
        return;
      }
      if (snap.seek === "item") host.seekTo((snap.progress?.index ?? 0) + 1);
    });
    const sectionRow = (group, clickable) => {
      const name = group.section?.text ?? "Introduction";
      const count = `${group.count} sentence${group.count === 1 ? "" : "s"}`;
      if (!clickable) {
        const row2 = el(doc, "div", CLASS_SECTION_ROW, "display:flex;justify-content:space-between;gap:.6em");
        const label2 = doc.createElement("span");
        label2.textContent = name;
        const n2 = doc.createElement("span");
        n2.style.cssText = "opacity:.6;white-space:nowrap";
        n2.textContent = count;
        row2.append(label2, n2);
        return row2;
      }
      const row = doc.createElement("button");
      row.type = "button";
      row.className = CLASS_SECTION_ROW;
      row.style.cssText = "display:flex;justify-content:space-between;gap:.6em;width:100%;font:inherit;text-align:left;padding:.15em 0;color:inherit;background:transparent;border:0;cursor:pointer";
      const label = doc.createElement("span");
      label.textContent = name;
      const n = doc.createElement("span");
      n.style.cssText = "opacity:.6;white-space:nowrap";
      n.textContent = count;
      row.append(label, n);
      row.title = `Jump to ${name}`;
      row.setAttribute("aria-label", `Jump to ${name}`);
      row.addEventListener("click", () => host.seekTo(group.from));
      return row;
    };
    const render = (next) => {
      phase(next.state);
      snap = next;
      const fraction = barFraction(next);
      fill.style.width = `${Math.round(fraction * 1e3) / 10}%`;
      const hasTimeline = next.seek === "seconds";
      bar.setAttribute("role", hasTimeline ? "slider" : "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
      bar.setAttribute("aria-label", hasTimeline ? "Seek" : "Reading progress");
      bar.style.cursor = hasTimeline ? "pointer" : "default";
      const line = positionLine(next, elapsedPlaying());
      position.textContent = hasTimeline ? line : `${Math.round(fraction * 100)}% \xB7 ${line}`;
      const canSeek = next.seek !== null;
      prevBtn.hidden = !canSeek;
      nextBtn.hidden = !canSeek;
      if (hasTimeline) {
        setLabel(prevBtn, `\u23EA ${SKIP_SECONDS} s`, `Skip back ${SKIP_SECONDS} seconds`);
        setLabel(nextBtn, `\u23E9 ${SKIP_SECONDS} s`, `Skip forward ${SKIP_SECONDS} seconds`);
      } else if (canSeek) {
        setLabel(prevBtn, "\u23EE Previous sentence", "Previous sentence");
        setLabel(nextBtn, "\u23ED Next sentence", "Next sentence");
      }
      const hasQueue = next.items.length > 0;
      nowWrap.hidden = !hasQueue;
      comingWrap.hidden = !hasQueue;
      readWrap.hidden = !hasQueue;
      if (!hasQueue) return;
      const index = Math.min(next.progress?.index ?? 0, next.items.length - 1);
      nowHead.textContent = next.state === "paused" ? "\u23F8 Paused at" : "Now";
      nowText.textContent = `\u201C${next.items[index].text}\u201D`;
      const groups = groupSections(next.items);
      const g = groupIndexOf(groups, index);
      comingList.replaceChildren();
      const upcoming = groups.slice(g + 1);
      if (upcoming.length === 0) {
        const done = el(doc, "div", "glassdocs-ra-coming-empty", "opacity:.6");
        done.textContent = "Nothing left after this section.";
        comingList.append(done);
      } else {
        for (const group of upcoming) comingList.append(sectionRow(group, canSeek));
      }
      readList.replaceChildren();
      const read = groups.slice(0, Math.max(0, g));
      readToggle.hidden = read.length === 0;
      readList.hidden = !readOpen || read.length === 0;
      if (read.length > 0) {
        for (const group of read) readList.append(sectionRow(group, canSeek));
      }
    };
    return { el: root, render };
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
    let section = null;
    for (const block of blocks) {
      if (block.kind === "code") continue;
      let text = (block.text ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (block.kind === "heading") {
        section = { text, level: block.level ?? 1 };
        if (block.id) section.id = block.id;
        if (!/[.!?]$/.test(text)) text += ".";
      }
      for (const piece of sentences(text)) out.push({ text: piece, section });
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
    let utteranceStart = 0;
    const endedFns = [];
    const errorFns = [];
    const yieldFns = [];
    const progressFns = [];
    const emitProgress = (charIndex) => {
      const p = {
        index,
        total: chunks.length,
        charIndex,
        // Speech has no timeline. The one number the engine offers -
        // SpeechSynthesisEvent.elapsedTime - is MILLISECONDS on Chromium and
        // SECONDS on WebKit for the same utterance (measured 5915.8 vs 6.18,
        // #214 §3.1), so it is never read here and never will be.
        seconds: null,
        duration: null
      };
      for (const fn of [...progressFns]) fn(p);
    };
    const speakChunk = (i) => {
      if (i >= chunks.length) {
        for (const fn of [...endedFns]) fn();
        return;
      }
      index = i;
      utteranceStart = 0;
      const mine = run;
      emitProgress(utteranceStart);
      const utterance = new Utterance(chunks[i].text);
      utterance.voice = voice;
      utterance.onend = () => {
        if (mine !== run || pauseRequested) return;
        speakChunk(i + 1);
      };
      utterance.onboundary = (event) => {
        if (mine !== run) return;
        emitProgress(utteranceStart + (event?.charIndex ?? 0));
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
          if (!pauseRequested || pausedByCancel || synth.paused) return;
          waited += PAUSE_POLL_MS;
          if (waited < PAUSE_CONFIRM_MS) {
            setTimeout(check, PAUSE_POLL_MS);
            return;
          }
          pausedByCancel = true;
          run++;
          synth.cancel();
          emitProgress(utteranceStart);
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
      },
      // ── position and seeking (#214) ──────────────────────────────────
      items: chunks,
      /**
       * Per ITEM, never per second, and the difference is the honesty rule.
       *
       * This engine cannot land anywhere except a chunk boundary. A "±10 s"
       * control mapped onto those boundaries would deliver anywhere from 0.5 s to
       * 12 s at the measured 18 characters/second, and a draggable thumb would
       * jump away from where the reader dropped it. The positions offered are
       * every position that can actually be reached, and each one is exact.
       */
      seek: "item",
      seekTo(i) {
        const target = Math.min(chunks.length - 1, Math.max(0, Math.trunc(i)));
        run++;
        synth.cancel();
        index = target;
        utteranceStart = 0;
        if (pauseRequested) {
          pausedByCancel = true;
          emitProgress(utteranceStart);
          return;
        }
        pausedByCancel = false;
        speakChunk(target);
      },
      onProgress(fn) {
        progressFns.push(fn);
      }
    };
  }

  // src/page/read-aloud-page.ts
  var PLAY = "\u25B6";
  var PAUSE = "\u23F8";
  var OPEN_PLAYER = "\u25BE";
  var OPEN_PLAYER_TITLE = "Open player";
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
    const el2 = doc.createElement("button");
    el2.type = "button";
    el2.title = title;
    el2.setAttribute("aria-label", title);
    el2.style.cssText = style;
    const g = doc.createElement("span");
    g.className = GLYPH_CLASS;
    g.textContent = glyph;
    el2.append(g);
    return el2;
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
  var PLAYER_CLASS = "glassdocs-ra-popover";
  var PLAYER_STYLE = [
    "position:absolute",
    "top:100%",
    "right:0",
    "z-index:5",
    "box-sizing:border-box",
    // The header's own foreground is white on the primary colour; the popover
    // sits over the article, so it takes the page's colours and not the header's.
    "background:var(--md-default-bg-color,#fff)",
    "color:var(--md-default-fg-color,#000)",
    "border:1px solid rgba(128,128,128,.35)",
    "border-radius:.4em",
    "box-shadow:0 2px 10px rgba(0,0,0,.25)",
    "padding:.7em .8em",
    "margin:.3em 0 0",
    "font:inherit",
    "font-size:.9rem",
    "line-height:1.35",
    "text-align:left",
    // So it stays on screen at 320 px even where the width rule above does not
    // apply (the article placement injects no stylesheet).
    "max-width:calc(100vw - 1rem)",
    "max-height:60vh",
    "overflow:auto"
  ].join(";");
  var HEADER_CSS = `#${READ_ALOUD_ID}[data-placement=header] .${LABEL_CLASS}{display:none}#${READ_ALOUD_ID}[data-placement=header] .${PLAYER_CLASS}{width:calc(100vw - 2rem)}@media screen and (min-width:60em){#${READ_ALOUD_ID}[data-placement=header] .${LABEL_CLASS}{display:inline}#${READ_ALOUD_ID}[data-placement=header] .${PLAYER_CLASS}{width:22rem}}`;
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
    bar.style.cssText = inHeader ? "display:flex;align-items:center;margin:0;position:relative" : "display:flex;gap:0.4em;align-items:center;margin:0 0 1.2em;position:relative";
    const title = voice ? READ_TITLE : reason ?? READ_TITLE;
    const playBtn = button(doc, PLAY, title, inHeader ? HEADER_PLAY_STYLE : BUTTON_STYLE);
    const aiBtn = clip ? button(doc, PLAY, AI_TITLE, inHeader ? HEADER_PLAY_STYLE : BUTTON_STYLE) : null;
    const playerBtn = button(doc, OPEN_PLAYER, OPEN_PLAYER_TITLE, inHeader ? HEADER_BUTTON_STYLE : BUTTON_STYLE);
    playerBtn.setAttribute("aria-expanded", "false");
    if (inHeader) {
      playBtn.className = "md-header__button";
      if (aiBtn) aiBtn.className = "md-header__button";
      playerBtn.className = "md-header__button";
      injectHeaderStyle(doc);
    }
    playBtn.append(labelSpan(doc, LISTEN, LABEL_CLASS, inHeader));
    if (aiBtn) aiBtn.append(labelSpan(doc, AI, AI_LABEL_CLASS, inHeader));
    playerBtn.hidden = true;
    if (aiBtn) bar.append(playBtn, aiBtn, playerBtn);
    else bar.append(playBtn, playerBtn);
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
    const player = createReadAloudPlayer(doc, {
      seekTo: (position) => transport.seekTo(position),
      stop: () => transport.stop()
    });
    const popover = doc.createElement("div");
    popover.className = PLAYER_CLASS;
    popover.style.cssText = PLAYER_STYLE;
    if (!inHeader) popover.style.width = "22rem";
    popover.hidden = true;
    popover.append(player.el);
    bar.append(popover);
    const snapshot = (progress) => {
      player.render({
        state: transport.state(),
        items: transport.items(),
        seek: transport.seekUnit(),
        progress
      });
    };
    const CLAMP_MARGIN = 8;
    const keepOnScreen = () => {
      popover.style.left = "auto";
      popover.style.right = "0";
      const rect = popover.getBoundingClientRect?.();
      if (!rect || !rect.width) return;
      const box = bar.closest?.("nav.md-header__inner")?.getBoundingClientRect?.();
      const left = box ? box.left : 0;
      const right = box ? box.right : doc.documentElement?.clientWidth ?? 0;
      if (!right) return;
      if (rect.left < left + CLAMP_MARGIN) {
        popover.style.right = `${Math.round(rect.left - left - CLAMP_MARGIN)}px`;
      } else if (rect.right > right - CLAMP_MARGIN) {
        popover.style.right = `${Math.round(rect.right - right + CLAMP_MARGIN)}px`;
      }
    };
    let latest = null;
    const setOpen = (open) => {
      popover.hidden = !open;
      playerBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (!open) return;
      snapshot(latest);
      keepOnScreen();
    };
    transport.onProgress((p) => {
      latest = p;
      if (!popover.hidden) snapshot(p);
    });
    playerBtn.addEventListener("click", () => setOpen(popover.hidden));
    doc.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || popover.hidden) return;
      setOpen(false);
    });
    doc.addEventListener("click", (event) => {
      if (popover.hidden) return;
      const target = event.target;
      if (target && bar.contains(target)) return;
      setOpen(false);
    });
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
      const live = state === "playing" || state === "paused";
      playerBtn.hidden = !live;
      if (!live) {
        latest = null;
        setOpen(false);
      } else if (!popover.hidden) {
        snapshot(latest);
      }
    });
    const startWith = (which) => {
      if (active && active !== which) transport.stop();
      pending = which;
      void transport.toggle();
    };
    if (voice) playBtn.addEventListener("click", () => startWith("tts"));
    if (aiBtn) aiBtn.addEventListener("click", () => startWith("clip"));
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
