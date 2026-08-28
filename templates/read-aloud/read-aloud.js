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
  var WS = /\s/;
  function collapse(pieces) {
    const chars = [];
    const runs = [];
    let cur = null;
    let pending = null;
    const emit = (ch, node, offset) => {
      const textStart = chars.length;
      chars.push(ch);
      if (!node) {
        cur = null;
        return;
      }
      if (cur && cur.node === node && cur.nodeStart + cur.length === offset) {
        cur.length++;
        return;
      }
      cur = { node, nodeStart: offset, textStart, length: 1 };
      runs.push(cur);
    };
    for (const piece of pieces) {
      for (let i = 0; i < piece.data.length; i++) {
        const ch = piece.data[i];
        if (WS.test(ch)) {
          if (chars.length > 0 && !pending) pending = { node: piece.node, offset: i };
          continue;
        }
        if (pending) {
          emit(" ", pending.node, pending.offset);
          pending = null;
        }
        emit(ch, piece.node, i);
      }
    }
    return { text: chars.join(""), runs };
  }
  function flush(ctx) {
    const { text, runs } = collapse(ctx.buf);
    ctx.buf.length = 0;
    if (!text) return;
    const block = { kind: ctx.kind, text };
    if (ctx.kind === "heading" && ctx.level) block.level = ctx.level;
    if (ctx.id) block.id = ctx.id;
    ctx.out.push(block);
    ctx.runs.push(runs);
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
        ctx.buf.push({ node: child, data: child.nodeValue ?? "" });
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
          ctx.runs.push([]);
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
  function readableBlocksWithRanges(root = document.body) {
    if (!root) return { blocks: [], ranges: [] };
    const ctx = {
      out: [],
      runs: [],
      buf: [],
      kind: "para",
      id: idOf(root),
      vis: typeof root.checkVisibility === "function" && root.checkVisibility()
    };
    walk(root, ctx);
    flush(ctx);
    return { blocks: ctx.out, ranges: ctx.runs };
  }
  function readableBlocks(root = document.body) {
    return readableBlocksWithRanges(root).blocks;
  }

  // src/page/word-highlight.ts
  var HIGHLIGHT_NAME = "glassdocs-read-aloud-word";
  var HIGHLIGHT_STYLE_ID = "glassdocs-read-aloud-highlight-style";
  var HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT_NAME}){background-color:rgba(255,213,79,.45);color:inherit}`;
  var WS2 = /\s/;
  function locate(runs, offset) {
    for (const run of runs) {
      if (offset >= run.textStart && offset < run.textStart + run.length) {
        return { node: run.node, offset: run.nodeStart + (offset - run.textStart) };
      }
    }
    return null;
  }
  function registryOf() {
    const g = globalThis;
    const registry = typeof g.CSS !== "undefined" ? g.CSS?.highlights : void 0;
    const Ctor = g.Highlight;
    if (!registry || typeof Ctor !== "function") return null;
    return { registry, Ctor };
  }
  function injectHighlightStyle(doc) {
    const host = doc.head ?? doc.documentElement;
    if (!host || host.querySelector(`#${HIGHLIGHT_STYLE_ID}`)) return;
    const style = doc.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = HIGHLIGHT_CSS;
    host.appendChild(style);
  }
  function createWordHighlight(doc) {
    let source = null;
    let painted = false;
    const paint = (range) => {
      const found = registryOf();
      if (!found) return;
      if (!range) {
        if (painted) found.registry.delete(HIGHLIGHT_NAME);
        painted = false;
        return;
      }
      found.registry.set(HIGHLIGHT_NAME, new found.Ctor(range));
      painted = true;
    };
    const resolve = (index, charIndex) => {
      if (!source || charIndex == null) return null;
      const item = source.items[index];
      if (!item?.origin) return null;
      const runs = source.ranges[item.origin.block];
      const block = source.blocks[item.origin.block];
      if (!runs || !runs.length || !block) return null;
      let from = Math.trunc(charIndex);
      if (!(from >= 0) || from >= item.text.length) return null;
      while (from < item.text.length && WS2.test(item.text[from])) from++;
      if (from >= item.text.length) return null;
      let to = from;
      while (to < item.text.length && !WS2.test(item.text[to])) to++;
      const start = item.origin.start + from;
      const end = Math.min(item.origin.start + to, block.text.length);
      if (start >= end || start >= block.text.length) return null;
      const head = locate(runs, start);
      const tail = locate(runs, end - 1);
      if (!head || !tail) return null;
      try {
        const range = doc.createRange();
        range.setStart(head.node, head.offset);
        range.setEnd(tail.node, tail.offset + 1);
        return range;
      } catch {
        return null;
      }
    };
    return {
      setSource(next) {
        source = next;
        if (!next) paint(null);
      },
      show(index, charIndex) {
        const range = resolve(index, charIndex);
        paint(range);
        return range;
      },
      clear() {
        paint(null);
      }
    };
  }
  var BAND_TOP = 0.25;
  var BAND_BOTTOM = 0.75;
  function createFollowScroller(doc) {
    let suspended = false;
    return {
      follow(range) {
        if (suspended || !range) return;
        if (doc.hidden) return;
        const win = doc.defaultView ?? globalThis.window;
        if (!win?.scrollBy) return;
        const rect = range.getBoundingClientRect?.();
        if (!rect || !rect.height && !rect.width) return;
        const view = doc.documentElement?.clientHeight || win.innerHeight || 0;
        if (!view) return;
        if (rect.top >= view * BAND_TOP && rect.bottom <= view * BAND_BOTTOM) return;
        const delta = rect.top + rect.height / 2 - view / 2;
        const reduced = globalThis.matchMedia?.(
          "(prefers-reduced-motion: reduce)"
        )?.matches === true;
        win.scrollBy({ top: delta, left: 0, behavior: reduced ? "auto" : "smooth" });
      },
      suspend() {
        suspended = true;
      },
      resume() {
        suspended = false;
      },
      isSuspended: () => suspended
    };
  }

  // src/lib/published-audio.ts
  var AUDIO_FILE_RE = /^\/audio\/gd-audio-[0-9a-f]{20}\.[A-Za-z0-9]+$/;
  var SHA_RE = /^[0-9a-f]{40}$/;
  var AUDIO_SECTIONS_RE = /^\d+:\d+(,\d+:\d+)*$/;
  var AUDIO_SECTIONS_MAX = 8192;
  function parseAudioSections(raw) {
    if (typeof raw !== "string" || raw.length > AUDIO_SECTIONS_MAX) return null;
    if (!AUDIO_SECTIONS_RE.test(raw)) return null;
    const out = [];
    let previous = -1;
    for (const pair of raw.split(",")) {
      const [t, c] = pair.split(":");
      const deciseconds = Number(t);
      const chars = Number(c);
      if (!Number.isSafeInteger(deciseconds) || !Number.isSafeInteger(chars)) return null;
      if (deciseconds < previous) return null;
      previous = deciseconds;
      out.push({ start: deciseconds / 10, chars });
    }
    return out;
  }
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

  // src/lib/playback-position.ts
  var POS_KEY = "glassdocs.readaloud.pos.v1";
  var CHAIN_RUN_KEY = "glassdocs.readaloud.run";
  var MAX_ENTRIES = 50;
  var MAX_AGE_MS = 90 * 24 * 60 * 60 * 1e3;
  var WRITE_THROTTLE_MS = 5e3;
  var END_SECONDS = 10;
  function fingerprintChunks(chunks) {
    let h = 2166136261;
    let chars = 0;
    for (const c of chunks) {
      chars += c.length;
      for (let i = 0; i < c.length; i++) {
        h ^= c.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      h ^= 10;
      h = Math.imul(h, 16777619);
    }
    return `${chunks.length}.${chars}.${(h >>> 0).toString(36)}`;
  }
  function store() {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }
  function sessionStore() {
    try {
      return globalThis.sessionStorage ?? null;
    } catch {
      return null;
    }
  }
  function readChainRun() {
    try {
      const v = sessionStore()?.getItem(CHAIN_RUN_KEY);
      return v === "tts" || v === "clip" ? v : null;
    } catch {
      return null;
    }
  }
  function setChainRun(kind) {
    const s = sessionStore();
    if (!s) return;
    try {
      if (kind === null) s.removeItem(CHAIN_RUN_KEY);
      else s.setItem(CHAIN_RUN_KEY, kind);
    } catch {
    }
  }
  var isFinite_ = (n) => typeof n === "number" && Number.isFinite(n);
  function valid(v) {
    if (!v || typeof v !== "object") return false;
    const p = v;
    if (!isFinite_(p.t)) return false;
    if (p.kind === "tts") {
      return isFinite_(p.chunk) && isFinite_(p.total) && isFinite_(p.char) && p.chunk >= 0 && p.total > 0 && p.char >= 0 && typeof p.fp === "string" && (p.sha === null || typeof p.sha === "string");
    }
    if (p.kind === "clip") {
      return isFinite_(p.seconds) && isFinite_(p.duration) && p.seconds >= 0 && p.duration >= 0 && typeof p.file === "string" && typeof p.audioSha === "string";
    }
    return false;
  }
  function readPositions(now = Date.now()) {
    let raw = null;
    try {
      raw = store()?.getItem(POS_KEY) ?? null;
    } catch {
      return {};
    }
    if (!raw) return {};
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [path, value] of Object.entries(parsed)) {
      if (!valid(value)) continue;
      if (now - value.t > MAX_AGE_MS) continue;
      out[path] = value;
    }
    return out;
  }
  function persist(map, path, pos) {
    const s = store();
    if (!s) return;
    try {
      s.setItem(POS_KEY, JSON.stringify(map));
    } catch {
      try {
        s.setItem(POS_KEY, JSON.stringify({ [path]: pos }));
      } catch {
      }
    }
  }
  function writePosition(path, pos, now = Date.now()) {
    const map = readPositions(now);
    map[path] = { ...pos, t: now };
    const paths = Object.keys(map);
    if (paths.length > MAX_ENTRIES) {
      paths.sort((a, b) => map[a].t - map[b].t).slice(0, paths.length - MAX_ENTRIES).forEach((p) => delete map[p]);
    }
    persist(map, path, map[path]);
  }
  function clearPosition(path, now = Date.now()) {
    const map = readPositions(now);
    if (!(path in map)) return;
    delete map[path];
    const s = store();
    if (!s) return;
    try {
      s.setItem(POS_KEY, JSON.stringify(map));
    } catch {
    }
  }
  function isResumable(pos, page, now = Date.now()) {
    if (!pos) return false;
    if (!valid(pos)) return false;
    if (now - pos.t > MAX_AGE_MS) return false;
    if (pos.kind !== page.kind) return false;
    if (pos.kind === "tts" && page.kind === "tts") {
      if (pos.fp !== page.fp) return false;
      if (pos.sha && page.sha && pos.sha !== page.sha) return false;
      if (pos.chunk >= pos.total - 1) return false;
      return true;
    }
    if (pos.kind === "clip" && page.kind === "clip") {
      if (pos.file !== page.file || pos.audioSha !== page.audioSha) return false;
      if (pos.duration > 0 && pos.seconds >= pos.duration - END_SECONDS) return false;
      return true;
    }
    return false;
  }
  function fractionOf(pos) {
    if (pos.kind === "tts") {
      if (!(pos.total > 0)) return 0;
      return Math.min(1, Math.max(0, pos.chunk / pos.total));
    }
    if (!(pos.duration > 0)) return 0;
    return Math.min(1, Math.max(0, pos.seconds / pos.duration));
  }
  function createPositionWriter(write, env = {}) {
    const now = env.now ?? (() => Date.now());
    const setTimer = env.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = env.clearTimer ?? ((h) => clearTimeout(h));
    let lastWrite = -Infinity;
    let pending = null;
    let timer = null;
    const emit = (pos) => {
      lastWrite = now();
      pending = null;
      write(pos);
    };
    const fire = () => {
      timer = null;
      if (pending) emit(pending);
    };
    return {
      schedule(pos) {
        const elapsed = now() - lastWrite;
        if (elapsed >= WRITE_THROTTLE_MS && timer === null) {
          emit(pos);
          return;
        }
        pending = pos;
        if (timer === null) timer = setTimer(fire, Math.max(0, WRITE_THROTTLE_MS - elapsed));
      },
      flush() {
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        if (pending) emit(pending);
      },
      cancel() {
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        pending = null;
      }
    };
  }

  // src/lib/speech-prefs.ts
  var RATE_MIN = 0.5;
  var RATE_MAX = 2;
  var RATE_STEP = 0.1;
  var RATE_DEFAULT = 1;
  var DEFAULT_PLAYBACK_PREFS = {
    rate: RATE_DEFAULT,
    voiceURI: null
  };
  var DEFAULT_SPEECH_PREFS = {
    ...DEFAULT_PLAYBACK_PREFS,
    continueToNextPage: false,
    preferredSource: "auto",
    autoScroll: false
  };
  var PAGE_PREFS_KEY = "glassdocs.readaloud.v1";
  function clampRate(raw) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return RATE_DEFAULT;
    return Math.min(RATE_MAX, Math.max(RATE_MIN, raw));
  }
  function clampVoiceURI(raw) {
    return typeof raw === "string" && raw !== "" ? raw : null;
  }
  function clampPlaybackPrefs(raw) {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_PLAYBACK_PREFS };
    const o = raw;
    return { rate: clampRate(o.rate), voiceURI: clampVoiceURI(o.voiceURI) };
  }
  function clampPrefs(raw) {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_SPEECH_PREFS };
    const o = raw;
    return {
      ...clampPlaybackPrefs(o),
      continueToNextPage: o.continueToNextPage === true,
      // The SAFE direction here is "auto", not "tts": "auto" is what the reader
      // gets having chosen nothing, so an unreadable value returns them to the
      // default rather than to a choice they never made. Only the exact string
      // "tts" is a choice; `1`, `"TTS"`, null and a missing key are not.
      preferredSource: o.preferredSource === "tts" ? "tts" : "auto",
      // Anything non-boolean becomes `false` — the safe direction, because the
      // unsafe direction is a page that moves itself.
      autoScroll: o.autoScroll === true
    };
  }
  function store2() {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }
  function readPagePrefs() {
    let raw = null;
    try {
      raw = store2()?.getItem(PAGE_PREFS_KEY) ?? null;
    } catch {
      return { ...DEFAULT_SPEECH_PREFS };
    }
    if (!raw) return { ...DEFAULT_SPEECH_PREFS };
    try {
      return clampPrefs(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_SPEECH_PREFS };
    }
  }
  function writePagePrefs(prefs) {
    const s = store2();
    if (!s) return;
    try {
      s.setItem(PAGE_PREFS_KEY, JSON.stringify(clampPrefs(prefs)));
    } catch {
    }
  }

  // src/sidepanel/read-aloud-player.ts
  var SKIP_SECONDS = 10;
  var KEY_NUDGE_SECONDS = 1;
  var KEY_STEP_SECONDS = 5;
  var CLASS_ROOT = "glassdocs-ra-player";
  var CLASS_BAR = "glassdocs-ra-bar";
  var CLASS_FILL = "glassdocs-ra-fill";
  var CLASS_THUMB = "glassdocs-ra-thumb";
  var CLASS_POSITION = "glassdocs-ra-position";
  var CLASS_TRANSPORT = "glassdocs-ra-transport";
  var CLASS_STOP = "glassdocs-ra-stop";
  var CLASS_PREV = "glassdocs-ra-prev";
  var CLASS_NEXT = "glassdocs-ra-next";
  var CLASS_NOW = "glassdocs-ra-now";
  var CLASS_COMING = "glassdocs-ra-coming";
  var CLASS_READ = "glassdocs-ra-read";
  var CLASS_SECTION_ROW = "glassdocs-ra-section";
  var CLASS_RATE = "glassdocs-ra-rate";
  var CLASS_VOICE = "glassdocs-ra-voice";
  var CLASS_CONTINUE = "glassdocs-ra-continue";
  var CLASS_AUTOSCROLL = "glassdocs-ra-autoscroll";
  var CLASS_NOTICE = "glassdocs-ra-notice";
  var CLASS_SOURCE = "glassdocs-ra-source";
  var CLASS_SWITCH = "glassdocs-ra-switch";
  var CONTINUE_LABEL = "Keep playing the next page";
  var AUTO_SCROLL_LABEL = "Follow along as it reads";
  var RATE_LABEL = "Speed";
  var VOICE_LABEL = "Voice";
  var VOICE_AUTO_LABEL = "Automatic";
  var CLIP_VOICE_REASON = "The AI voice is a recording \u2014 its voice cannot be changed";
  var VOICE_NEXT_PLAY_HINT = "Takes effect the next time you press play";
  var COMING_HEAD = "Coming up";
  var SECTIONS_HEAD = "Sections";
  var END_OF_KB = "End of this knowledge base";
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
    if (snap.seek === "seconds") {
      const parts = [`${formatClock(p?.seconds ?? null)} / ${formatClock(p?.duration ?? null)}`];
      if (named) parts.push(`Section ${g + 1} of ${groups.length}`);
      if (snap.itemPrecise ? snap.itemPrecise(index) : true) {
        const group = groups[g];
        const of = named && group ? group.count : snap.items.length;
        const within = named && group ? index - group.from + 1 : index + 1;
        parts.push(`Sentence ${Math.min(Math.max(1, within), of)} of ${of}`);
      }
      return parts.join(" \xB7 ");
    }
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
    const thumb = el(
      doc,
      "div",
      CLASS_THUMB,
      "position:absolute;top:50%;left:0%;width:.8em;height:.8em;border-radius:50%;background:currentColor;transform:translate(-50%,-50%);pointer-events:none"
    );
    const barWrap = el(doc, "div", "glassdocs-ra-bar-wrap", "position:relative;padding:.2em 0");
    barWrap.append(bar, thumb);
    const position = el(doc, "div", CLASS_POSITION, "font-size:.75em;opacity:.85");
    const transport = el(doc, "div", CLASS_TRANSPORT, "display:flex;gap:.4em;align-items:center;flex-wrap:wrap");
    const stopBtn = controlButton(doc, CLASS_STOP);
    setLabel(stopBtn, "\u23F9", "Stop reading");
    const prevBtn = controlButton(doc, CLASS_PREV);
    const nextBtn = controlButton(doc, CLASS_NEXT);
    const sourceEl = el(doc, "span", CLASS_SOURCE, "font-size:.8em;opacity:.75");
    const switchBtn = controlButton(doc, CLASS_SWITCH);
    transport.append(stopBtn, prevBtn, nextBtn, sourceEl, switchBtn);
    const nowWrap = el(doc, "div", CLASS_NOW, "font-size:.78em");
    const nowHead = el(doc, "div", "glassdocs-ra-head", "opacity:.6;text-transform:uppercase;letter-spacing:.05em;font-size:.9em");
    const nowText = el(doc, "div", "glassdocs-ra-now-text", "margin-top:.15em");
    nowWrap.append(nowHead, nowText);
    const comingWrap = el(doc, "div", CLASS_COMING, "font-size:.78em");
    const comingHead = el(doc, "div", "glassdocs-ra-head", "opacity:.6;text-transform:uppercase;letter-spacing:.05em;font-size:.9em");
    comingHead.textContent = COMING_HEAD;
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
    const rateWrap = el(doc, "label", CLASS_RATE, "display:flex;gap:.4em;align-items:center;font-size:.78em");
    const rateText = doc.createElement("span");
    rateText.textContent = RATE_LABEL;
    const rateInput = doc.createElement("input");
    rateInput.type = "range";
    rateInput.min = String(RATE_MIN);
    rateInput.max = String(RATE_MAX);
    rateInput.step = String(RATE_STEP);
    rateInput.style.cssText = "flex:1;min-width:5em;margin:0;cursor:pointer";
    const rateValue = doc.createElement("span");
    rateValue.style.cssText = "min-width:2.4em;text-align:right;font-variant-numeric:tabular-nums;opacity:.85";
    rateWrap.append(rateText, rateInput, rateValue);
    const rateReadout = (r) => `${r.toFixed(1)}\xD7`;
    const canRate = !!host.rate;
    if (canRate) {
      rateInput.addEventListener("input", () => {
        const next = clampRate(Number(rateInput.value));
        rateValue.textContent = rateReadout(next);
        host.rate.set(next);
      });
    }
    const voiceWrap = el(doc, "label", CLASS_VOICE, "display:flex;gap:.4em;align-items:center;font-size:.78em");
    const voiceText = doc.createElement("span");
    voiceText.textContent = VOICE_LABEL;
    const voiceSelect = doc.createElement("select");
    voiceSelect.style.cssText = "flex:1;min-width:0;font:inherit;font-size:1em;color:inherit;background:transparent;cursor:pointer";
    voiceWrap.append(voiceText, voiceSelect);
    const canVoice = !!host.voice;
    let voiceKeys = [];
    if (canVoice) {
      voiceSelect.addEventListener("change", () => {
        host.voice.set(voiceSelect.value === "" ? null : voiceSelect.value);
      });
    }
    const continueWrap = el(doc, "label", CLASS_CONTINUE, "display:flex;gap:.4em;align-items:center;font-size:.78em;cursor:pointer");
    const continueBox = doc.createElement("input");
    continueBox.type = "checkbox";
    continueBox.style.cssText = "margin:0;cursor:pointer";
    const continueText = doc.createElement("span");
    continueText.textContent = CONTINUE_LABEL;
    continueWrap.append(continueBox, continueText);
    const canContinue = !!host.continueToNextPage;
    if (canContinue) {
      continueBox.checked = host.continueToNextPage.get();
      continueBox.addEventListener("change", () => {
        host.continueToNextPage.set(continueBox.checked === true);
      });
    }
    const scrollWrap = el(doc, "label", CLASS_AUTOSCROLL, "display:flex;gap:.4em;align-items:center;font-size:.78em;cursor:pointer");
    const scrollBox = doc.createElement("input");
    scrollBox.type = "checkbox";
    scrollBox.style.cssText = "margin:0;cursor:pointer";
    const scrollText = doc.createElement("span");
    scrollText.textContent = AUTO_SCROLL_LABEL;
    scrollWrap.append(scrollBox, scrollText);
    const canAutoScroll = !!host.autoScroll;
    if (canAutoScroll) {
      scrollBox.checked = host.autoScroll.get();
      scrollBox.addEventListener("change", () => {
        host.autoScroll.set(scrollBox.checked === true);
      });
    }
    const notice = el(doc, "div", CLASS_NOTICE, "font-size:.78em;opacity:.75");
    notice.hidden = true;
    root.append(barWrap, position, transport, notice, nowWrap, comingWrap, readWrap);
    if (canRate) root.append(rateWrap);
    if (canVoice) root.append(voiceWrap);
    if (canContinue) root.append(continueWrap);
    if (canAutoScroll) root.append(scrollWrap);
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
    let dragging = false;
    let dragFraction = 0;
    let dragPointerId = null;
    let pointerCommitted = false;
    const seekableSeconds = () => {
      if (snap.seek !== "seconds") return null;
      const duration = snap.progress?.duration ?? null;
      return duration != null && duration > 0 ? duration : null;
    };
    const previewAt = (clientX) => {
      dragFraction = fractionAt(clientX, bar.getBoundingClientRect());
    };
    const commitDrag = () => {
      if (!dragging) return;
      dragging = false;
      const id = dragPointerId;
      dragPointerId = null;
      if (id != null) {
        try {
          bar.releasePointerCapture(id);
        } catch {
        }
      }
      pointerCommitted = true;
      const duration = seekableSeconds();
      if (duration != null) host.seekTo(dragFraction * duration);
      render(snap);
    };
    bar.addEventListener("pointerdown", (event) => {
      if (seekableSeconds() == null) return;
      const pe = event;
      if (typeof pe.clientX !== "number") return;
      pointerCommitted = false;
      dragging = true;
      dragPointerId = null;
      if (typeof pe.pointerId === "number") {
        try {
          bar.setPointerCapture(pe.pointerId);
          dragPointerId = pe.pointerId;
        } catch {
        }
      }
      previewAt(pe.clientX);
      render(snap);
    });
    bar.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const pe = event;
      if (typeof pe.clientX !== "number") return;
      previewAt(pe.clientX);
      render(snap);
    });
    bar.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      const pe = event;
      if (typeof pe.clientX === "number") previewAt(pe.clientX);
      commitDrag();
    });
    bar.addEventListener("pointercancel", () => commitDrag());
    bar.addEventListener("lostpointercapture", () => commitDrag());
    bar.addEventListener("keydown", (event) => {
      const duration = seekableSeconds();
      if (duration == null) return;
      const ke = event;
      const at = snap.progress?.seconds ?? 0;
      let target;
      switch (ke.key) {
        case "ArrowLeft":
          target = at - KEY_NUDGE_SECONDS;
          break;
        case "ArrowRight":
          target = at + KEY_NUDGE_SECONDS;
          break;
        case "ArrowDown":
          target = at - KEY_STEP_SECONDS;
          break;
        case "ArrowUp":
          target = at + KEY_STEP_SECONDS;
          break;
        case "PageUp":
          target = at - SKIP_SECONDS;
          break;
        case "PageDown":
          target = at + SKIP_SECONDS;
          break;
        case "Home":
          target = 0;
          break;
        case "End":
          target = duration;
          break;
        default:
          return;
      }
      ke.preventDefault();
      host.seekTo(Math.min(duration, Math.max(0, target)));
    });
    bar.addEventListener("click", (event) => {
      if (dragging) return;
      if (pointerCommitted) {
        pointerCommitted = false;
        return;
      }
      if (snap.seek !== "seconds") return;
      const duration = snap.progress?.duration ?? null;
      if (duration == null || duration <= 0) return;
      const rect = bar.getBoundingClientRect();
      const x = event.clientX;
      if (typeof x !== "number") return;
      host.seekTo(fractionAt(x, rect) * duration);
    });
    stopBtn.addEventListener("click", () => host.stop());
    if (host.switchSource) switchBtn.addEventListener("click", () => host.switchSource());
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
    const sectionRow = (group, clickable, verb = "Jump to") => {
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
      row.title = `${verb} ${name}`;
      row.setAttribute("aria-label", `${verb} ${name}`);
      row.addEventListener("click", () => {
        if (host.seekToItem) host.seekToItem(group.from);
        else host.seekTo(group.from);
      });
      return row;
    };
    const render = (next) => {
      phase(next.state);
      snap = next;
      const atRest = (next.state === "idle" || next.state === "ended") && next.progress == null;
      if (canContinue) continueBox.checked = host.continueToNextPage.get();
      if (canAutoScroll) scrollBox.checked = host.autoScroll.get();
      const voiceLive = next.ttsRunning !== false;
      if (canRate) {
        const r = clampRate(host.rate.get());
        if (rateInput.value !== String(r)) rateInput.value = String(r);
        rateValue.textContent = rateReadout(r);
        rateWrap.title = "";
      }
      if (canVoice) {
        const list = host.voice.list();
        const chosen = host.voice.get();
        const keys = ["", ...list.map((v) => v.voiceURI)];
        if (keys.length !== voiceKeys.length || keys.some((k, i) => k !== voiceKeys[i])) {
          voiceKeys = keys;
          voiceSelect.replaceChildren();
          const auto = doc.createElement("option");
          auto.value = "";
          auto.textContent = VOICE_AUTO_LABEL;
          voiceSelect.append(auto);
          for (const v of list) {
            const opt = doc.createElement("option");
            opt.value = v.voiceURI;
            opt.textContent = v.lang ? `${v.name} (${v.lang})` : v.name;
            voiceSelect.append(opt);
          }
        }
        const installed = chosen != null && list.some((v) => v.voiceURI === chosen);
        const want = installed ? chosen : "";
        if (voiceSelect.value !== want) voiceSelect.value = want;
        voiceSelect.disabled = !voiceLive;
        voiceWrap.title = voiceLive ? next.state === "playing" || next.state === "paused" ? VOICE_NEXT_PLAY_HINT : "" : CLIP_VOICE_REASON;
        voiceWrap.style.opacity = voiceLive ? "" : ".55";
        voiceWrap.style.cursor = voiceLive ? "pointer" : "not-allowed";
      }
      notice.textContent = next.notice ?? "";
      notice.hidden = !next.notice;
      const hasTimeline = next.seek === "seconds";
      const duration = next.progress?.duration ?? null;
      const previewing = dragging && hasTimeline && duration != null && duration > 0;
      const fraction = previewing ? dragFraction : barFraction(next);
      fill.style.width = `${Math.round(fraction * 1e3) / 10}%`;
      bar.setAttribute("role", hasTimeline ? "slider" : "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
      bar.setAttribute("aria-label", hasTimeline ? "Seek" : "Reading progress");
      bar.tabIndex = hasTimeline ? 0 : -1;
      bar.style.touchAction = hasTimeline ? "none" : "";
      bar.style.userSelect = hasTimeline ? "none" : "";
      bar.style.cursor = hasTimeline ? dragging ? "grabbing" : "grab" : "default";
      thumb.hidden = !hasTimeline;
      thumb.style.left = `${Math.round(fraction * 1e3) / 10}%`;
      const previewSeconds = previewing ? dragFraction * duration : 0;
      const previewIndex = previewing && next.itemAt ? next.itemAt(previewSeconds) : null;
      const line = positionLine(
        previewing ? {
          ...next,
          progress: {
            ...next.progress,
            seconds: previewSeconds,
            ...previewIndex != null ? { index: previewIndex } : {}
          }
        } : next,
        elapsedPlaying()
      );
      position.textContent = hasTimeline ? line : `${Math.round(fraction * 100)}% \xB7 ${line}`;
      if (hasTimeline) bar.setAttribute("aria-valuetext", line);
      else bar.removeAttribute("aria-valuetext");
      barWrap.hidden = atRest;
      position.hidden = atRest;
      transport.hidden = atRest;
      transport.style.display = atRest ? "none" : "flex";
      const live = next.state === "playing" || next.state === "paused";
      const sourceName = next.sourceLabel ?? "";
      sourceEl.textContent = sourceName;
      sourceEl.hidden = !live || !sourceName;
      const switchWords = next.switchLabel ?? "";
      const canSwitch = !!host.switchSource && !!switchWords && live;
      switchBtn.hidden = !canSwitch;
      if (canSwitch) setLabel(switchBtn, switchWords, switchWords);
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
      if (atRest) {
        nowWrap.hidden = true;
        readWrap.hidden = true;
        comingWrap.hidden = !hasQueue;
        comingHead.textContent = SECTIONS_HEAD;
        comingList.replaceChildren();
        if (!hasQueue) return;
        for (const group of groupSections(next.items)) {
          comingList.append(sectionRow(group, next.idleSeekable === true, "Play from"));
        }
        return;
      }
      comingHead.textContent = COMING_HEAD;
      nowWrap.hidden = !hasQueue;
      comingWrap.hidden = !hasQueue;
      readWrap.hidden = !hasQueue;
      if (!hasQueue) return;
      const index = Math.min(next.progress?.index ?? 0, next.items.length - 1);
      const precise = next.itemPrecise ? next.itemPrecise(index) : true;
      nowHead.textContent = next.state === "paused" ? precise ? "\u23F8 Paused at" : "\u23F8 Paused \xB7 in this section" : precise ? "Now" : "Now \xB7 in this section";
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

  // src/sidepanel/clip-source.ts
  var NO_ITEMS = Object.freeze([]);
  var CLIP_LABEL = "AI voice";
  var TRUST_FLOOR = 20;
  var TRUST_BAND = 0.05;
  function alignGroups(items, sections) {
    if (items.length === 0 || sections.length === 0) return null;
    const groups = groupSections(items);
    if (groups[0].section !== null) groups.unshift({ section: null, from: 0, count: 0 });
    if (groups.length !== sections.length) return null;
    return groups;
  }
  function createClipSource(doc, url, timeline, startAt = 0, getRate = () => RATE_DEFAULT) {
    const el2 = doc.createElement("audio");
    el2.preload = "none";
    el2.src = url;
    let resumeFrom = Number.isFinite(startAt) ? Math.max(0, startAt) : 0;
    const sections = timeline?.sections ?? null;
    const groups = timeline && sections ? alignGroups(timeline.items, sections) : null;
    const items = groups ? timeline.items : NO_ITEMS;
    const trusted = (groups ?? []).map((group, g) => {
      let pageChars = 0;
      for (let i = group.from; i < group.from + group.count; i++) pageChars += items[i].text.length;
      const generatorChars = sections[g].chars;
      return Math.abs(pageChars - generatorChars) <= Math.max(TRUST_FLOOR, TRUST_BAND * generatorChars);
    });
    const sectionAt = (t) => {
      let s = 0;
      for (let k = 0; k < sections.length; k++) {
        if (sections[k].start <= t) s = k;
        else break;
      }
      return s;
    };
    const itemAt = (t) => {
      if (!groups || !sections) return 0;
      const at = Number.isFinite(t) ? Math.max(0, t) : 0;
      const s = sectionAt(at);
      const group = groups[s];
      if (group.count === 0) return group.from;
      const start = sections[s].start;
      const upper = s + 1 < sections.length ? sections[s + 1].start : Number.isFinite(el2.duration) ? el2.duration : start;
      const span = upper - start;
      const frac = span > 0 ? Math.min(1, Math.max(0, (at - start) / span)) : 0;
      let total = 0;
      for (let i = group.from; i < group.from + group.count; i++) total += items[i].text.length;
      if (total <= 0) return group.from;
      let acc = 0;
      for (let i = group.from; i < group.from + group.count; i++) {
        acc += items[i].text.length;
        if (acc / total > frac) return i;
      }
      return group.from + group.count - 1;
    };
    const secondsForItem = (index) => {
      if (!groups || !sections) return null;
      const g = groupIndexOf(groups, index);
      if (g < 0) return null;
      return sections[g].start;
    };
    const seekSeconds = (seconds) => {
      const want = Math.max(0, seconds);
      el2.currentTime = Number.isFinite(el2.duration) ? Math.min(el2.duration, want) : want;
      emitProgress();
    };
    const endedFns = [];
    const errorFns = [];
    const progressFns = [];
    const emitProgress = () => {
      const p = {
        index: itemAt(el2.currentTime),
        total: items.length > 0 ? items.length : 1,
        // STAYS NULL, with a timeline or without one. The map is per SECTION; there
        // is no character-level fact here, and manufacturing one would be exactly
        // the defect the trust check above exists to prevent.
        charIndex: null,
        seconds: Number.isFinite(el2.currentTime) ? el2.currentTime : 0,
        duration: Number.isFinite(el2.duration) ? el2.duration : null
      };
      for (const fn of [...progressFns]) fn(p);
    };
    const applyRate = () => {
      const r = clampRate(getRate());
      if (el2.defaultPlaybackRate !== r) el2.defaultPlaybackRate = r;
      if (el2.playbackRate !== r) el2.playbackRate = r;
    };
    el2.addEventListener("timeupdate", emitProgress);
    el2.addEventListener("loadedmetadata", emitProgress);
    el2.addEventListener("timeupdate", applyRate);
    el2.addEventListener("loadedmetadata", applyRate);
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
        el2.currentTime = resumeFrom;
        resumeFrom = 0;
        applyRate();
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
        applyRate();
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
      items,
      /** Native, exact and continuous. The player's bar is draggable for this
       *  source and this source only, because this is the only one that can land
       *  where the reader put the thumb. */
      seek: "seconds",
      /**
       * A section row was clicked, and it carries an ITEM index — which is not a
       * position this source can be given. Translate to the item's SECTION START,
       * which is the one instant in the clip the map vouches for exactly.
       *
       * Deliberately not the item's own estimated offset: that would be a
       * character-weighted guess dressed up as a seek target, and the reader would
       * land somewhere the row did not promise. The row says "jump to this
       * section" and that is what happens.
       */
      seekToItem(index) {
        const seconds = secondsForItem(index);
        if (seconds == null) return;
        seekSeconds(seconds);
      },
      /** False for a section whose page text and the generator's disagree. */
      itemPrecise(index) {
        if (!groups) return false;
        const g = groupIndexOf(groups, index);
        return g < 0 ? false : trusted[g] === true;
      },
      // The SAME function that produces the index this source reports while
      // playing (see emitProgress above), now answerable over a hypothetical time
      // — which is all a drag preview needs (#308). Deliberately not a second
      // implementation in the player: a re-derived character weighting could
      // disagree with emitProgress about where the playhead is, and the player and
      // the source disagreeing about position is the drift read-aloud-player.ts's
      // header exists to prevent.
      //
      // With no map it returns 0, which is the pre-#300 clip. That is not a
      // fabricated position reaching a reader: such a clip has `items: NO_ITEMS`,
      // and positionLine returns on the empty-queue branch before it reads any
      // index at all.
      itemAt,
      seekTo(seconds) {
        seekSeconds(seconds);
      },
      onProgress(fn) {
        progressFns.push(fn);
      }
    };
  }

  // src/lib/kb-nav.ts
  var ACTIVE = "md-nav__link--active";
  function readPrimaryNav(doc, base) {
    const root = doc.querySelector("nav.md-nav--primary");
    if (!root) return [];
    let origin;
    try {
      origin = new URL(base).origin;
    } catch {
      return [];
    }
    const out = [];
    for (const a of Array.from(root.querySelectorAll("a.md-nav__link"))) {
      if (a.closest("nav.md-nav--secondary")) continue;
      const raw = a.getAttribute("href");
      if (!raw || raw.startsWith("#")) continue;
      let url;
      try {
        url = new URL(raw, base);
      } catch {
        continue;
      }
      if (url.origin !== origin) continue;
      out.push({
        href: url.href,
        label: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
        // Trap 2's other half: this element HAS an href, because it came out of an
        // `a[href]` walk. The <label> twin never reaches here.
        active: a.classList.contains(ACTIVE)
      });
    }
    return out;
  }
  function nextPageHref(doc, base) {
    const pages = readPrimaryNav(doc, base);
    if (pages.length === 0) return null;
    const marked = pages.filter((p) => p.active);
    if (marked.length !== 1) return null;
    const at = pages.indexOf(marked[0]);
    const next = pages[at + 1];
    if (!next) return null;
    if (next.href === pages[at].href) return null;
    return next.href;
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
      seekToItem(index) {
        const s = source;
        if (!s) return;
        if (typeof s.seekToItem === "function") s.seekToItem(index);
        else s.seekTo(index);
      },
      label: () => source?.label ?? "",
      items: () => source?.items ?? [],
      // Absent means yes: a source that says nothing about precision is exact,
      // which is true of the speech engine and of an idle transport with nothing
      // to be imprecise about.
      itemPrecise: (index) => source?.itemPrecise?.(index) ?? true,
      // Absent means NO ANSWER — see the interface. Still engine-blind: the
      // seconds go through uninterpreted and the source's own number comes back.
      itemAt: (seconds) => source?.itemAt?.(seconds) ?? null
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
  function trimAt(s, at) {
    return { text: s.trim(), start: at + (s.length - s.trimStart().length) };
  }
  function sentences(text) {
    const out = [];
    for (const part of splitSentences(text)) {
      let cur = trimAt(part.text, part.start);
      if (!cur.text) continue;
      while (cur.text.length > MAX_CHUNK) {
        let cut = cur.text.lastIndexOf(" ", MAX_CHUNK);
        if (cut <= 0) cut = MAX_CHUNK;
        out.push(trimAt(cur.text.slice(0, cut), cur.start));
        cur = trimAt(cur.text.slice(cut), cur.start + cut);
      }
      if (cur.text) out.push(cur);
    }
    return out;
  }
  function splitSentences(text) {
    const out = [];
    let pos = 0;
    for (const m of text.matchAll(new RegExp("(?<=[.!?])\\s+", "g"))) {
      out.push({ text: text.slice(pos, m.index), start: pos });
      pos = (m.index ?? 0) + m[0].length;
    }
    out.push({ text: text.slice(pos), start: pos });
    return out;
  }
  function toChunks(blocks) {
    const out = [];
    let section = null;
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      if (block.kind === "code") continue;
      const raw = block.text ?? "";
      let text = raw.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const mapped = text === raw;
      if (block.kind === "heading") {
        section = { text, level: block.level ?? 1 };
        if (block.id) section.id = block.id;
        if (!/[.!?]$/.test(text)) text += ".";
      }
      for (const piece of sentences(text)) {
        const item = { text: piece.text, section };
        if (mapped && piece.start < raw.length) item.origin = { block: index, start: piece.start };
        out.push(item);
      }
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
  function pickLocal(voices, preferredURI = null) {
    const local = voices.filter((v) => v.localService === true);
    if (local.length === 0) return null;
    if (preferredURI) {
      const chosen = local.find((v) => v.voiceURI === preferredURI);
      if (chosen) return chosen;
    }
    const preferred = local.find((v) => v.default === true);
    if (preferred) return preferred;
    const want = baseTag(globalThis.navigator?.language ?? "");
    const matched = want ? local.find((v) => baseTag(v.lang) === want) : void 0;
    return matched ?? local[0];
  }
  var NO_VOICES = { list: [], choose: () => null };
  async function resolveVoiceChoices() {
    const synth = getSynth();
    if (!synth || !getUtteranceCtor()) return NO_VOICES;
    const voices = await allVoices(synth);
    const list = voices.filter((v) => v.localService === true).map((v) => ({ voiceURI: v.voiceURI, name: v.name, lang: v.lang }));
    return { list, choose: (preferredURI) => pickLocal(voices, preferredURI) };
  }
  function createSpeechSourceWith(blocks, voice, startAt, getRate = () => DEFAULT_PLAYBACK_PREFS.rate) {
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
    const pendingStart = (() => {
      if (!startAt) return null;
      const int = (n) => Number.isFinite(n) ? Math.trunc(n) : 0;
      const c = Math.min(chunks.length - 1, Math.max(0, int(startAt.chunk)));
      const room = Math.max(0, chunks[c].text.length - 1);
      return { chunk: c, char: Math.min(room, Math.max(0, int(startAt.char))) };
    })();
    let resumeFrom = pendingStart;
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
    const speakChunk = (i, offset = 0) => {
      if (i >= chunks.length) {
        for (const fn of [...endedFns]) fn();
        return;
      }
      index = i;
      utteranceStart = offset;
      const mine = run;
      emitProgress(utteranceStart);
      const utterance = new Utterance(offset > 0 ? chunks[i].text.slice(offset) : chunks[i].text);
      utterance.voice = voice;
      utterance.rate = clampRate(getRate());
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
        const at = resumeFrom;
        resumeFrom = null;
        speakChunk(at ? at.chunk : 0, at ? at.char : 0);
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
        utteranceStart = 0;
        resumeFrom = null;
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
  var CHAIN_BLOCKED = "Your browser would not start audio on a page it opened by itself \u2014 press to keep listening";
  var OPEN_PLAYER = "\u25BE";
  var OPEN_PLAYER_TITLE = "Open player";
  var READ_TITLE = "Read this page aloud with a speech voice installed on your device";
  var LISTEN = "Listen";
  var RESUME = "Resume";
  var AI_TITLE = "Play the AI-generated narration of this page";
  var LABEL_CLASS = "glassdocs-ra-label";
  var AI_DOT_CLASS = "glassdocs-ra-ai-dot";
  var AI_DOT_STYLE = [
    "display:inline-block",
    "width:.36em",
    "height:.36em",
    "border-radius:50%",
    "background:currentColor",
    "margin-left:-.1em",
    "align-self:flex-start",
    "flex:none"
  ].join(";");
  var SWITCH_TO_TTS = "Use your browser's voice";
  var SWITCH_TO_AI = "Use the AI voice";
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
  function mount(doc, root, initialVoice, reason, clip, voices) {
    let voice = initialVoice;
    const slot = resolveSlot(doc, root);
    const inHeader = slot.placement === "header";
    const bar = doc.createElement("div");
    bar.id = READ_ALOUD_ID;
    bar.dataset.placement = slot.placement;
    bar.style.cssText = inHeader ? "display:flex;align-items:center;margin:0;position:relative" : "display:flex;gap:0.4em;align-items:center;margin:0 0 1.2em;position:relative";
    let pending = !clip ? "tts" : !voice ? "clip" : readPagePrefs().preferredSource === "tts" ? "tts" : "clip";
    const restingTitle = () => pending === "clip" ? AI_TITLE : voice ? READ_TITLE : reason ?? READ_TITLE;
    let title = restingTitle();
    const playBtn = button(doc, PLAY, title, inHeader ? HEADER_PLAY_STYLE : BUTTON_STYLE);
    const playerBtn = button(doc, OPEN_PLAYER, OPEN_PLAYER_TITLE, inHeader ? HEADER_BUTTON_STYLE : BUTTON_STYLE);
    playerBtn.setAttribute("aria-expanded", "false");
    if (inHeader) {
      playBtn.className = "md-header__button";
      playerBtn.className = "md-header__button";
      injectHeaderStyle(doc);
    }
    injectHighlightStyle(doc);
    const wordHighlight = createWordHighlight(doc);
    const follow = createFollowScroller(doc);
    let autoScroll = readPagePrefs().autoScroll;
    if (clip) {
      const dot = doc.createElement("span");
      dot.className = AI_DOT_CLASS;
      dot.style.cssText = AI_DOT_STYLE;
      dot.setAttribute("aria-hidden", "true");
      playBtn.append(dot);
    }
    const playLabel = labelSpan(doc, LISTEN, LABEL_CLASS, inHeader);
    playBtn.append(playLabel);
    playerBtn.hidden = true;
    bar.append(playBtn, playerBtn);
    if (!voice && !clip) {
      playBtn.disabled = true;
      playBtn.style.cssText = inHeader ? HEADER_DISABLED_STYLE : DISABLED_STYLE;
      slot.parent.insertBefore(bar, slot.before);
      return;
    }
    playerBtn.hidden = false;
    let active = null;
    const path = globalThis.location?.pathname ?? "/";
    const arrivedByChain = readChainRun();
    setChainRun(null);
    const sourceSha = readAudioMetaFromDom(doc).pageSha;
    const identityFor = (which, fp) => {
      if (which === "tts") return { kind: "tts", fp, sha: sourceSha };
      if (!clip) return null;
      return { kind: "clip", file: clip.file, audioSha: clip.audioSha };
    };
    const resumeFor = (which, fp) => {
      if (arrivedByChain) return null;
      const id = identityFor(which, fp);
      if (!id) return null;
      const pos = readPositions()[path];
      return isResumable(pos, id) ? pos : null;
    };
    let spokenFp = "";
    const writer = createPositionWriter((pos) => writePosition(path, pos));
    let notice = null;
    const forget = () => {
      writer.cancel();
      clearPosition(path);
    };
    const showResume = (pos) => {
      const where = pos ? `from where you left off (about ${Math.round(fractionOf(pos) * 100)}% in)` : "";
      playLabel.textContent = pos ? RESUME : LISTEN;
      title = !pos ? restingTitle() : pos.kind === "clip" ? `Resume the AI narration ${where}` : `Resume reading ${where}`;
      playBtn.title = title;
      playBtn.setAttribute("aria-label", title);
    };
    const resolve = () => {
      const { blocks, ranges } = readableBlocksWithRanges(mainContentRoot(doc));
      const items = toChunks(blocks);
      spokenFp = fingerprintChunks(items.map((c) => c.text));
      wordHighlight.setSource({ blocks, ranges, items });
      if (pending === "clip") {
        if (!clip) return null;
        const at2 = resumeFor("clip", spokenFp);
        const source2 = createClipSource(
          doc,
          clip.file,
          clip.sections ? { sections: clip.sections, items } : void 0,
          at2 && at2.kind === "clip" ? at2.seconds : 0,
          // The SAME getter over the SAME stored preference the speech source
          // gets below (#376) — one `Speed` row, one `SpeechPrefs.rate`. Speed is
          // the reader's listening pace, not a property of whichever engine
          // happens to be running, so a second field for the clip would make one
          // control mean two things.
          () => readPagePrefs().rate
        );
        active = "clip";
        wordHighlight.clear();
        postReadAloudSignal(READ_ALOUD_STARTED);
        return source2;
      }
      if (!voice) return null;
      const at = resumeFor("tts", spokenFp);
      const source = createSpeechSourceWith(
        blocks,
        voice,
        at && at.kind === "tts" ? { chunk: at.chunk, char: at.char } : void 0,
        // A GETTER over localStorage, re-read per chunk (#212). This one argument
        // is the whole wiring between the player's speed row and the running
        // narration: the row writes the preference, the next utterance reads it,
        // and nothing has to be told that anything changed.
        () => readPagePrefs().rate
      );
      if (source) {
        active = "tts";
        postReadAloudSignal(READ_ALOUD_STARTED);
      }
      return source;
    };
    let triedClipFallback = false;
    const transport = createTransport(resolve, (_label, payload) => {
      const message = String(payload?.message ?? "");
      if (!/not-?allowed/i.test(message)) return;
      if (!arrivedByChain) return;
      if (arrivedByChain === "clip" && voice && !triedClipFallback) {
        triedClipFallback = true;
        startWith("tts");
        return;
      }
      title = CHAIN_BLOCKED;
      playBtn.title = title;
      playBtn.setAttribute("aria-label", title);
    });
    const player = createReadAloudPlayer(doc, {
      seekTo: (position) => transport.seekTo(position),
      // A section row's number is an ITEM index; only the source knows what that
      // means in its own unit (#301).
      seekToItem: (index) => {
        const state = transport.state();
        if (state === "idle" || state === "ended") startWith(pending);
        transport.seekToItem(index);
        follow.resume();
      },
      // ── speed and voice (#212) ──
      //
      // Supplied by the PAGE and by nothing else. The side panel leaves both unset
      // and renders neither row: its settings surface is the "Read aloud" fieldset
      // on the options page, backed by the extension's own settings store, and the
      // two stores never meet. That is the founder's 2026-08-14 answer expressed structurally —
      // there is no code path here by which one surface's choice reaches the other.
      rate: {
        get: () => readPagePrefs().rate,
        // No re-render, no restart, nothing told to the running source. It re-reads
        // this on the next chunk (MAX_CHUNK is 200 characters), so a drag is
        // audible within about a sentence.
        set: (rate) => {
          writePagePrefs({ ...readPagePrefs(), rate });
        }
      },
      voice: {
        get: () => readPagePrefs().voiceURI,
        set: (voiceURI) => {
          writePagePrefs({ ...readPagePrefs(), voiceURI });
          if (voices) voice = voices.choose(voiceURI) ?? voice;
        },
        // ON-DEVICE VOICES ONLY, and that is guaranteed one layer down rather than
        // here: resolveVoiceChoices() filters on localService before it builds the
        // list, so a remote voice cannot be offered however this is called.
        list: () => voices?.list ?? []
      },
      // Auto-advance is a PAGE behaviour and this is the page. The panel leaves
      // this unset and renders no row — see PlayerHost in read-aloud-player.ts.
      continueToNextPage: {
        get: () => readPagePrefs().continueToNextPage,
        set: (on) => {
          writePagePrefs({ ...readPagePrefs(), continueToNextPage: on });
          if (!on) setChainRun(null);
        }
      },
      // Follow the voice with the viewport (#343). A PAGE behaviour: the panel has
      // no page to scroll — the article is in another document — so it leaves this
      // unset and renders no row.
      autoScroll: {
        get: () => readPagePrefs().autoScroll,
        set: (on) => {
          writePagePrefs({ ...readPagePrefs(), autoScroll: on });
          autoScroll = on;
        }
      },
      // Two engines, one press to change which is reading (#344 §5.4). The panel
      // leaves this unset and gets no control at all — it has one engine.
      switchSource: () => {
        const other = active === "clip" ? "tts" : "clip";
        writePagePrefs({ ...readPagePrefs(), preferredSource: other === "tts" ? "tts" : "auto" });
        startWith(other);
      },
      stop: () => {
        forget();
        showResume(null);
        follow.resume();
        setChainRun(null);
        notice = null;
        transport.stop();
      }
    });
    const popover = doc.createElement("div");
    popover.className = PLAYER_CLASS;
    popover.style.cssText = PLAYER_STYLE;
    if (!inHeader) popover.style.width = "22rem";
    popover.hidden = true;
    popover.append(player.el);
    bar.append(popover);
    const pageSections = () => toChunks(readableBlocks(mainContentRoot(doc)));
    const idleSeekable = () => pending === "tts" ? voice != null : clip?.sections != null;
    const switchWords = () => {
      if (!clip || !voice) return null;
      return active === "clip" ? SWITCH_TO_TTS : SWITCH_TO_AI;
    };
    const snapshot = (progress) => {
      const state = transport.state();
      const atRest = state === "idle" || state === "ended";
      player.render({
        state,
        items: atRest ? pageSections() : transport.items(),
        seek: transport.seekUnit(),
        progress,
        itemPrecise: (index) => transport.itemPrecise(index),
        // What the drag preview asks while the thumb is down (#308). Forwarded,
        // never interpreted: this file knows no more about the clip's section map
        // than it does about its precision, and null means the current source has
        // no answer rather than "item 0".
        itemAt: (seconds) => transport.itemAt(seconds),
        idleSeekable: idleSeekable(),
        notice,
        // The engine that is actually speaking, in the SOURCE's own words (#344
        // §5.3). Forwarded from the transport, not composed here — the strings are
        // clip-source's CLIP_LABEL and speech-source's "Read aloud", the same two
        // the side panel has shown beside its transport since #186.
        //
        // This is the mitigation the merge rests on. With AI preferred by default
        // and #304 open, a reader on a page with a table gets less narration than
        // the browser voice would read them; the readout is what makes that
        // discoverable rather than invisible, and the switch beside it is the one
        // press that fixes it. Removing either reopens #344.
        sourceLabel: transport.label(),
        switchLabel: switchWords(),
        // Does the VOICE row govern what is playing? (#212, narrowed by #376.)
        //
        // The clip is a recorded file and its voice was baked into the samples at
        // generation time — no runtime control can change it, so that row stays
        // disabled with a reason while it plays. SPEED is no longer in that set:
        // clip-source now takes the same rate getter the speech source does, so
        // the slider governs both engines and is live throughout.
        ttsRunning: active !== "clip"
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
    const positionFrom = (p) => {
      if (active === "clip") {
        if (!clip) return null;
        return {
          kind: "clip",
          seconds: p.seconds ?? 0,
          duration: p.duration ?? 0,
          file: clip.file,
          audioSha: clip.audioSha,
          t: 0
        };
      }
      if (active !== "tts" || !spokenFp) return null;
      return {
        kind: "tts",
        chunk: p.index,
        total: p.total,
        char: p.charIndex ?? 0,
        fp: spokenFp,
        sha: sourceSha,
        t: 0
      };
    };
    transport.onProgress((p) => {
      latest = p;
      if (active === "tts") {
        const range = wordHighlight.show(p.index, p.charIndex);
        if (autoScroll) follow.follow(range);
      } else wordHighlight.clear();
      const pos = positionFrom(p);
      if (pos) writer.schedule(pos);
      if (!popover.hidden) snapshot(p);
    });
    playerBtn.addEventListener("click", () => setOpen(popover.hidden));
    doc.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || popover.hidden) return;
      setOpen(false);
    });
    doc.addEventListener("click", (event) => {
      if (popover.hidden) return;
      const path2 = event.composedPath?.();
      if (path2) {
        if (path2.includes(bar)) return;
      } else {
        const target = event.target;
        if (target && bar.contains(target)) return;
      }
      setOpen(false);
    });
    globalThis.window?.addEventListener("message", (event) => {
      if (!isReadAloudSignal(event, READ_ALOUD_STOP)) return;
      transport.stop();
    });
    const playGlyph = playBtn.querySelector(`.${GLYPH_CLASS}`);
    const paint = (state) => {
      const live = active !== null;
      const playing = live && state === "playing";
      if (playGlyph) playGlyph.textContent = playing ? PAUSE : PLAY;
      const next = playing ? "Pause reading" : live && state === "paused" ? "Resume reading" : title;
      playBtn.title = next;
      playBtn.setAttribute("aria-label", next);
    };
    const continueToNext = (kind) => {
      if (!readPagePrefs().continueToNextPage) return;
      if (doc.hidden) {
        setChainRun(null);
        return;
      }
      const here = globalThis.location?.href ?? "";
      const next = nextPageHref(doc, here);
      if (!next) {
        setChainRun(null);
        notice = END_OF_KB;
        snapshot(latest);
        return;
      }
      setChainRun(kind);
      globalThis.location?.assign?.(next);
    };
    transport.onStateChange((state) => {
      const wasActive = active;
      if (state === "idle" || state === "ended") active = null;
      if (state === "ended") {
        forget();
        showResume(null);
      }
      if (state === "paused") {
        writer.flush();
        setChainRun(null);
      }
      if (state === "playing") notice = null;
      if (state === "idle" || state === "ended") wordHighlight.setSource(null);
      paint(state);
      const live = state === "playing" || state === "paused";
      if (!live) latest = null;
      if (!popover.hidden) snapshot(latest);
      if (state === "ended") continueToNext(wasActive ?? "tts");
    });
    const startWith = (which) => {
      if (active && active !== which) transport.stop();
      pending = which;
      follow.resume();
      void transport.toggle();
    };
    playBtn.addEventListener("click", () => startWith(pending));
    const SCROLL_KEYS = /* @__PURE__ */ new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
    const ownsTheKey = (target) => {
      const el2 = target;
      if (!el2?.tagName) return false;
      if (el2.isContentEditable === true) return true;
      return ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "OPTION"].includes(el2.tagName);
    };
    const readerMoved = () => follow.suspend();
    doc.addEventListener("wheel", readerMoved, { passive: true });
    doc.addEventListener("touchmove", readerMoved, { passive: true });
    doc.addEventListener("keydown", (event) => {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (ownsTheKey(event.target)) return;
      readerMoved();
    });
    globalThis.window?.addEventListener("pagehide", () => writer.flush());
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "hidden") writer.flush();
    });
    globalThis.window?.addEventListener("pagehide", () => {
      transport.stop();
      wordHighlight.setSource(null);
    });
    {
      const loadFp = fingerprintChunks(toChunks(readableBlocks(root)).map((c) => c.text));
      showResume(resumeFor(pending, loadFp));
    }
    if (arrivedByChain) startWith(arrivedByChain === "clip" && clip ? "clip" : "tts");
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
    const raw = doc.querySelector('meta[name="audio-sections"]')?.getAttribute("content");
    return { file: verdict.file, audioSha: meta.audioSha ?? "", sections: parseAudioSections(raw) };
  }
  async function initReadAloudPage(doc = document) {
    const root = mainContentRoot(doc);
    if (!root) return false;
    const clip = resolveClip(doc);
    if (toChunks(readableBlocks(root)).length === 0) {
      mount(doc, root, null, NOTHING_TO_READ, clip, null);
      return true;
    }
    const voices = await resolveVoiceChoices();
    const voice = voices.choose(readPagePrefs().voiceURI);
    if (!voice) {
      mount(doc, root, null, NO_LOCAL_VOICE, clip, voices);
      return true;
    }
    mount(doc, root, voice, null, clip, voices);
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
