// RSC Console: the redesigned web console for rsc-host.
//
// Talks to the robot over a WebSocket on ws://host:port/ with the token as a
// subprotocol, exactly like console.html. A second socket is kept free for
// stop commands, because rsc-host answers one command at a time per socket and
// a slow verb (audio.selftest takes several seconds) would otherwise hold up
// Stop all. Protocol and quirks: host.md §2–3.
//
// The chat has no backend on the robot yet. sendToRobot() and listenOnRobot()
// are the only two functions to replace when one exists (host.md §5.6).
(() => {
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    raw(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
    setRaw(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const minus = (n) => (n < 0 ? "−" + Math.abs(n) : String(n));
const clone = (o) => JSON.parse(JSON.stringify(o));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const phone = matchMedia("(max-width: 760px)");
const wide = matchMedia("(min-width: 1100px)");

// localStorage keys. The first two are shared with console.html, so robots
// and tokens saved there show up here too.
const K = {
    known: "rsc.known_robots",
    token: (host) => "rsc.token." + host,
    recent: "rsc.app.recent",
    ui: "rsc.app.ui",
    log: "rsc.app.log",
    presets: "rsc.app.presets",
    chats: "rsc.app.chats",
};

// Verbs at host 3337185 (host.md §2.4). Only a fallback for the custom command
// list: once connected, the robot's own `status.verbs` is used.
const VERBS = ["ping", "status", "events.history", "flipper.left", "flipper.right", "flipper.m3", "flipper.left.stop", "flipper.right.stop", "flipper.m3.stop", "flipper.stop_all",
    "servo.calibration", "servo.hold", "servo.hold.stop", "servo.calibration.store", "servo.calibration.reset", "servo.calibrate", "ring.mode", "ring.off", "ring.modes", "ring.status",
    "button_led", "cyd.mood", "cyd.theme", "cyd.bright", "cyd.eye_colour", "cyd.bg_colour", "cyd.led", "cyd.blink", "cyd.splash", "cyd.face", "cyd.look", "cyd.mood_cycle", "cyd.raw",
    "audio.play_url", "audio.stop_play", "audio.capture.stop", "audio.devices", "audio.selftest", "audio.capture.config", "audio.capture.tune", "audio.capture.stats", "audio.capture.stats.reset",
    "audio.mixer.get", "audio.mixer.set", "audio.mixer.preset", "audio.mixer.store", "audio.mixer.reset", "audio.volume", "audio.volume.get", "audio.mute", "audio.mic_mute",
    "system.power_status", "system.poweroff", "system.reboot", "peripherals.status"];

// Ring colours are fixed per pattern, as in console.html's presets
const RING = {
    off: { label: "Off" },
    solid: { label: "Solid blue", params: { r: 0, g: 80, b: 255 } },
    pulse: { label: "Pulse purple", params: { r: 80, g: 0, b: 80, period_ms: 1500 } },
    spin: { label: "Spin blue", params: { r: 0, g: 80, b: 255, period_ms: 1500 } },
};

// What Reset goes back to. The mixer's and the calibration's own resets restore what the robot shipped with.
const DEFAULTS = {
    ring: { mode: "off" },
    led: { mode: "off" },
    face: { mood: "HAPPY" },
    sound: { volume: 50, muted: false, playback: true, normalise: true },
    mic: { on: true, rate: 48000, channel: "left", hpfOn: true, boostL: 2, boostR: 2, capture: 28 },
};

const MIXER = { boostL: "Left Input Boost Mixer LINPUT1", boostR: "Right Input Boost Mixer RINPUT1", capture: "Capture" };

// Which verb each control needs, so controls the robot's daemon lacks are disabled instead of failing
const NEEDS_KEY = {
    "flip.left": "flipper.left", "flip.right": "flipper.right", "ring.mode": "ring.mode", "led.mode": "button_led",
    "sound.volume": "audio.volume", "sound.muted": "audio.mute", "sound.playback": "audio.selftest", "sound.normalise": "audio.selftest",
    "mic.on": "audio.mic_mute", "mic.rate": "audio.capture.tune", "mic.channel": "audio.capture.tune", "mic.hpfOn": "audio.capture.tune",
    "mic.boostL": "audio.mixer.set", "mic.boostR": "audio.mixer.set", "mic.capture": "audio.mixer.set", "cal.side": "servo.hold", "cal.us": "servo.hold",
};
const NEEDS_ACT = {
    mood: "cyd.mood", blink: "cyd.blink", moodCycle: "cyd.mood_cycle", runTest: "audio.selftest", stopPlay: "audio.stop_play",
    mixerReset: "audio.mixer.reset", calStart: "servo.hold", calSave: "servo.calibrate", calRelease: "servo.hold.stop", calReset: "servo.calibration.reset",
    quickMute: "audio.mute", quickMic: "audio.mic_mute", stopAll: "flipper.stop_all",
};

// ---- State ----
const S = {
    view: "connect",
    ui: Object.assign({ sel: "movement", theme: "auto", adv: {} }, store.get(K.ui, {})),
    dock: Object.assign({ state: "open", w: 380, h: 240, filter: "all" }, store.get(K.log, {})),
    robot: { host: "", port: 8765, version: "", backend: "", simulated: false, verbs: new Set(), missing: [], status: false, powerAllowed: false, powerReason: "", powerFix: "" },
    flip: { left: 0, right: 0 },
    ring: { mode: "off" },
    led: { mode: "off" },
    face: { mood: "HAPPY" },
    sound: { volume: 50, muted: false, playback: true, normalise: true, running: false, device: "", result: null, error: "" },
    mic: { on: true, rate: 48000, channel: "left", hpfOn: true, boostL: 2, boostR: 2, capture: 28, missing: new Set() },
    cal: { side: "left", holding: false, us: 1500, stored: { left: null, right: null } },
};
if (!S.ui.adv || typeof S.ui.adv !== "object") S.ui.adv = {};
if (S.dock.state !== "closed") S.dock.state = "open";
S.dock.w = clamp(Number(S.dock.w) || 380, 280, 640);
S.dock.h = clamp(Number(S.dock.h) || 240, 140, 600);
let logBodyOpen = false, logExpanded = false;
const get = (k) => k.split(".").reduce((o, p) => o[p], S);
const set = (k, v) => { const ps = k.split("."); const last = ps.pop(); ps.reduce((o, p) => o[p], S)[last] = v; };
const saveUI = () => store.set(K.ui, S.ui);

// Brief confirmation on the button that was pressed
function flash(el, text) {
    if (!el) return;
    if (el._flash) clearTimeout(el._flash.t);
    else el._flash = { html: el.innerHTML };
    el.innerHTML = `<svg class="ic"><use href="#i-check"/></svg>${esc(text)}`;
    el._flash.t = setTimeout(() => { el.innerHTML = el._flash.html; el._flash = null; }, 1800);
}

// ---- Log ----
const LOG = [];
const KIND = { sent: "sent", ack: "reply", err: "error", event: "event", info: "info" };
let unread = 0;
const fmtTime = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const matchesFilter = (kind) => S.dock.filter === "all" || S.dock.filter === kind;
const logVisible = () => S.dock.state === "open" && S.view !== "settings" && (!phone.matches || logBodyOpen || logExpanded);

function log(kind, text, data) {
    const e = { t: new Date(), kind, text, data };
    LOG.push(e);
    if (LOG.length > 1000) LOG.shift();
    const list = $("#logList");
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const li = document.createElement("li");
    li.className = "le " + kind;
    li.dataset.kind = kind;
    li.innerHTML = `<button type="button" class="le-btn" aria-expanded="false"><span class="ts">${fmtTime(e.t)}</span><span class="k">${KIND[kind]}</span><span class="txt">${esc(text)}</span></button>` +
        (data ? `<pre hidden>${esc(JSON.stringify(data, null, 2))}</pre>` : "");
    li.hidden = !matchesFilter(kind);
    list.appendChild(li);
    while (list.children.length > 1000) list.firstElementChild.remove();
    if (atBottom) list.scrollTop = list.scrollHeight;
    if (!logVisible()) unread++;
    renderLogHead();
}
function renderLogHead() {
    const last = LOG[LOG.length - 1];
    $("#logLast").textContent = last ? `${fmtTime(last.t)} ${last.text}` : "Nothing logged yet";
    ["#logBadge", "#tbLogBadge"].forEach((s) => {
        $(s).hidden = unread === 0;
        $(s).textContent = unread > 99 ? "99+" : String(unread);
    });
}
function applyFilter() {
    $$("#logList > li").forEach((li) => { li.hidden = !matchesFilter(li.dataset.kind); });
    $$(".log-filters button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.act === "filter:" + S.dock.filter)));
}
function applyDock() {
    const b = document.body, lg = $("#log");
    b.dataset.log = S.dock.state;
    b.style.setProperty("--log-w", S.dock.w + "px");
    b.style.setProperty("--log-h", S.dock.h + "px");
    lg.toggleAttribute("data-open", logBodyOpen);
    lg.toggleAttribute("data-expanded", logExpanded);
    $(".log-title").setAttribute("aria-expanded", String(logBodyOpen));
    const ex = $("#logExpand");
    ex.innerHTML = `<svg class="ic"><use href="#${logExpanded ? "i-shrink" : "i-expand"}"/></svg>`;
    ex.setAttribute("aria-label", logExpanded ? "Shrink log" : "Expand log");
    ex.title = logExpanded ? "Shrink" : "Expand";
    if (logVisible()) { unread = 0; const l = $("#logList"); l.scrollTop = l.scrollHeight; }
    renderLogHead();
    store.set(K.log, { state: S.dock.state, w: S.dock.w, h: S.dock.h, filter: S.dock.filter });
    $("#logToggle").setAttribute("aria-pressed", String(S.dock.state === "open"));
}
function setDock(state) { S.dock.state = state; if (state === "closed") logExpanded = false; applyDock(); }
function revealLog() {
    if (S.dock.state === "closed") S.dock.state = "open";
    if (phone.matches) logBodyOpen = true;
    applyDock();
}

// Drag the log's inner edge: width when it is a column, height when it sits below
const grip = $("#logGrip");
grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, sw = S.dock.w, sh = S.dock.h, byWidth = wide.matches;
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
        if (byWidth) S.dock.w = Math.round(clamp(sw + (sx - ev.clientX), 280, Math.max(280, innerWidth - 560)));
        else S.dock.h = Math.round(clamp(sh + (sy - ev.clientY), 140, Math.max(140, innerHeight - 220)));
        document.body.style.setProperty("--log-w", S.dock.w + "px");
        document.body.style.setProperty("--log-h", S.dock.h + "px");
    };
    const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        applyDock();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
});
grip.addEventListener("keydown", (e) => {
    const d = wide.matches ? { ArrowLeft: 24, ArrowRight: -24 }[e.key] : { ArrowUp: 24, ArrowDown: -24 }[e.key];
    if (!d) return;
    e.preventDefault();
    if (wide.matches) S.dock.w = clamp(S.dock.w + d, 280, Math.max(280, innerWidth - 560));
    else S.dock.h = clamp(S.dock.h + d, 140, Math.max(140, innerHeight - 220));
    applyDock();
});

// ---- Connection ----
const C = { ws: null, ctl: null, seq: 0, pending: new Map(), connected: false, expectClose: "" };
const supports = (verb) => !S.robot.verbs.size || S.robot.verbs.has(verb);

// Resolves with an open socket, or rejects. The browser can't tell a wrong
// token from an unreachable robot: both arrive as a plain close (host.md §2.1).
function openSocket(host, port, token, ms = 6000) {
    return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WebSocket(`ws://${host}:${port}/`, ["bearer", token]); }
        catch (exc) { reject(exc); return; }
        const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("timed out")); }, ms);
        ws.onerror = () => {};
        ws.onclose = () => { clearTimeout(t); reject(new Error("closed")); };
        ws.onopen = () => { clearTimeout(t); ws.onclose = null; resolve(ws); };
    });
}

// Sends a command and resolves with its ack, or with null if the connection is gone.
// `urgent` uses the stop socket when it is open.
function request(verb, args = {}, opts = {}) {
    const ws = opts.urgent && C.ctl && C.ctl.readyState === WebSocket.OPEN ? C.ctl : C.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) { log("err", `not connected (${verb})`); return Promise.resolve(null); }
    const id = "c" + (++C.seq);
    const msg = { type: "cmd", id, verb, args };
    log("sent", verb + (Object.keys(args).length ? " " + JSON.stringify(args) : ""), msg);
    ws.send(JSON.stringify(msg));
    return new Promise((resolve) => C.pending.set(id, { verb, resolve }));
}
const send = (verb, args = {}, opts) => request(verb, args, opts);

function onMessage(e, main) {
    let msg;
    try { msg = JSON.parse(e.data); }
    catch { log("err", `unreadable message from the robot: ${String(e.data).slice(0, 120)}`); return; }
    if (msg.type === "ack") {
        const p = C.pending.get(msg.id);
        C.pending.delete(msg.id);
        const verb = p ? p.verb : msg.id || "?";
        if (msg.ok) log("ack", `${verb} ok`, msg);
        else log("err", `${verb}: ${msg.code}${msg.message ? " · " + msg.message : ""}`, msg);
        if (p) p.resolve(msg);
    } else if (msg.type === "event") {
        // Every socket receives every event; handle them once, from the main socket
        if (!main) return;
        log("event", `${msg.topic} ${JSON.stringify(msg.data ?? {})}`, msg);
        applyEvent(msg.topic, msg.data || {});
    } else {
        log("info", `unknown message: ${String(e.data).slice(0, 200)}`);
    }
}

async function connectTo(host, port, token, button) {
    const label = button ? button.innerHTML : "";
    if (button) { button.disabled = true; button.textContent = "Connecting…"; }
    formError("");
    $("#connectNote").hidden = true;
    log("info", `opening ws://${host}:${port}/`);
    let ws;
    try { ws = await openSocket(host, port, token); }
    catch {
        log("err", `couldn't connect to ${host}:${port}`);
        formError(`Couldn't connect to ${host}:${port}. Check that the robot is on and on this network, and that the token is right.` +
            (location.protocol === "https:" ? " This page was opened over https, and some browsers block connections to the robot from https pages; open the file from your computer instead." : ""));
        $("#cfHost").value = host;
        $("#cfPort").value = String(port);
        if (button) { button.disabled = false; button.innerHTML = label; }
        return;
    }
    if (button) { button.disabled = false; button.innerHTML = label; }
    C.ws = ws;
    C.connected = true;
    C.expectClose = "";
    ws.onmessage = (e) => onMessage(e, true);
    ws.onclose = (e) => onMainClose(e);
    log("info", `connected (subprotocol: ${ws.protocol})`);
    rememberRobot(host, port, token);
    S.robot = { host, port, version: "", backend: "", simulated: false, verbs: new Set(), missing: [], status: false, powerAllowed: false, powerReason: "", powerFix: "" };
    S.cal.holding = false;
    S.sound.result = null;
    S.sound.error = "";
    renderRobotInfo();
    go("console");
    openStopSocket(host, port, token);
    await syncFromRobot();
}

// The second socket only ever carries stop commands, so they never wait behind a slow verb
async function openStopSocket(host, port, token) {
    try {
        const ctl = await openSocket(host, port, token);
        if (!C.connected) { ctl.close(); return; }
        C.ctl = ctl;
        ctl.onmessage = (e) => onMessage(e, false);
        ctl.onclose = () => { if (C.ctl === ctl) C.ctl = null; };
    } catch {
        log("info", "stop channel unavailable; stop commands share the main connection");
    }
}

function teardown() {
    C.connected = false;
    for (const p of C.pending.values()) p.resolve(null);
    C.pending.clear();
    for (const k of ["ctl", "ws"]) {
        const w = C[k];
        C[k] = null;
        if (w) { w.onclose = null; w.onmessage = null; try { w.close(); } catch {} }
    }
    clearTimeout(saveT);
    S.sound.running = false;
    S.cal.holding = false;
    endVoice(true);
}
function onMainClose(e) {
    const note = C.expectClose || `Lost the connection to ${S.robot.host}${e.code ? ` (code ${e.code})` : ""}.`;
    log("info", `connection closed (code ${e.code}${e.reason ? ", " + e.reason : ""})`);
    teardown();
    leave(note);
}
function leave(note) {
    go("connect");
    renderRecent();
    $("#connectNote").textContent = note;
    $("#connectNote").hidden = !note;
}
function disconnect() {
    const host = S.robot.host;
    // Nothing on the robot stops the motors when a client leaves (host.md §3), so stop them first
    stopRobotQuietly();
    C.expectClose = `Disconnected from ${host}.`;
    log("info", "disconnected");
    const ws = C.ws;
    setTimeout(() => { try { ws && ws.close(); } catch {} }, 150);
}
// Best effort: flippers stopped and calibration holds released, sent without waiting for replies
function stopRobotQuietly() {
    const ws = C.ctl && C.ctl.readyState === WebSocket.OPEN ? C.ctl : C.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(JSON.stringify({ type: "cmd", id: "leave-stop", verb: "flipper.stop_all", args: {} }));
        ws.send(JSON.stringify({ type: "cmd", id: "leave-release", verb: "servo.hold.stop", args: {} }));
    } catch {}
}
addEventListener("pagehide", () => { if (C.connected) stopRobotQuietly(); });

// ---- Reading the robot's state after connecting ----
async function syncFromRobot() {
    const st = await request("status");
    if (st?.ok) {
        S.robot.version = st.result?.version || "";
        S.robot.verbs = new Set(st.result?.verbs || []);
    }
    const ps = await request("peripherals.status");
    if (ps?.ok && ps.result) applyPeripherals(ps.result);
    S.robot.status = true;
    if (!S.robot.simulated && supports("system.power_status")) {
        const pw = await request("system.power_status");
        S.robot.powerAllowed = !!(pw?.ok && pw.result?.allowed);
        S.robot.powerReason = pw?.result?.reason || "";
        S.robot.powerFix = pw?.result?.fix || "";
    }
    if (supports("audio.volume.get")) {
        const v = await request("audio.volume.get");
        if (v?.ok && v.result) applyVolume(v.result);
    }
    if (supports("audio.mixer.get")) await readMixer();
    if (supports("audio.devices")) {
        const d = await request("audio.devices");
        if (d?.ok) S.sound.device = deviceName(d.result);
    }
    renderRobotInfo();
    refreshPanel();
    afterChange();
}
function applyPeripherals(p) {
    S.robot.backend = p.backend || "";
    S.robot.simulated = p.backend === "fake";
    for (const id of ["left", "right"]) {
        const f = p.flippers?.[id];
        if (f && typeof f.speed === "number") S.flip[id] = Math.round(f.speed * 100);
        const c = p.servo_calibration?.[id];
        if (c && typeof c.null_us === "number") S.cal.stored[id] = c.null_us;
    }
    S.ring.mode = p.ring?.current_mode || "off";
    S.led.mode = p.button_led?.mode || "off";
    if (p.audio?.capture && !p.audio.capture.error) applyCapture(p.audio.capture);
    const missing = [];
    if (!(p.ring && p.ring.available)) missing.push("light ring");
    if (!(p.cyd && p.cyd.available)) missing.push("screen");
    if (!(p.state && p.state.available)) missing.push("saved settings");
    S.robot.missing = missing;
}
function applyCapture(c) {
    if (typeof c.stream_rate === "number") S.mic.rate = c.stream_rate;
    if (c.channel_mode) S.mic.channel = c.channel_mode;
    if ("hpf_mode" in c) S.mic.hpfOn = c.hpf_mode !== "off" && !!c.hpf_hz;
}
function applyVolume(r) {
    if (typeof r.volume === "number") S.sound.volume = r.volume;
    if (typeof r.muted === "boolean") S.sound.muted = r.muted;
}
async function readMixer() {
    const r = await request("audio.mixer.get");
    if (!r?.ok || !r.result) return;
    const c = r.result.controls || r.result;
    S.mic.missing = new Set();
    for (const [key, name] of Object.entries(MIXER)) {
        const n = parseInt(c[name], 10);
        if (Number.isFinite(n)) S.mic[key] = n;
        else S.mic.missing.add(key);
    }
}
function deviceName(r) {
    if (!r) return "";
    const first = (v) => Array.isArray(v) ? v[0] : v;
    const d = first(r.playback) || first(r.output) || first(r.devices);
    if (!d) return "";
    return typeof d === "string" ? d : d.name || d.description || JSON.stringify(d);
}
function renderRobotInfo() {
    const r = S.robot;
    $("#tbName").textContent = r.host ? `${r.host}:${r.port}` : "";
    $("#setHost").textContent = r.host || "—";
    $("#setPort").textContent = String(r.port || "—");
    $("#setVersion").textContent = r.version ? `rsc-host ${r.version}` : "unknown";
    $("#setBackend").textContent = !r.backend ? "unknown" : r.simulated ? "Simulated (rsc-host's fake backend)" : "Real robot";
    const chip = $("#tbReady");
    if (!r.status) { chip.className = "chip"; chip.textContent = "connecting"; chip.title = ""; }
    else if (r.simulated) { chip.className = "chip sim"; chip.textContent = "simulated"; chip.title = "rsc-host's fake backend: every command is answered, but no hardware moves"; }
    else if (r.missing.length) { chip.className = "chip warn"; chip.textContent = `no ${r.missing.join(", ")}`; chip.title = `Not available on this robot: ${r.missing.join(", ")}`; }
    else { chip.className = "chip ok"; chip.textContent = "ready"; chip.title = "Light ring, screen and saved settings all available"; }
}

// ---- Events from the robot ----
// Controls follow the robot, but not while you are dragging them yourself
const touched = {};
const fresh = (k) => performance.now() - (touched[k] || 0) < 700;
function applyEvent(topic, d) {
    const m = topic.match(/^flipper\.(left|right)\.state$/);
    if (m) {
        const k = "flip." + m[1];
        if (!fresh(k) && typeof d.speed === "number") { S.flip[m[1]] = Math.round(d.speed * 100); syncControls(k, null); }
    } else if (topic === "ring.mode") {
        S.ring.mode = d.mode || "off";
        syncControls("ring.mode", null);
    } else if (topic === "button_led.state") {
        S.led.mode = d.mode || "off";
        syncControls("led.mode", null);
    } else if (topic === "audio.volume" || topic === "audio.mute") {
        if (!fresh("sound.volume") && typeof d.volume === "number") { S.sound.volume = d.volume; syncControls("sound.volume", null); }
        if (typeof d.muted === "boolean") { S.sound.muted = d.muted; syncControls("sound.muted", null); }
    } else if (topic === "audio.mic_mute") {
        if (typeof d.mic_muted === "boolean") { S.mic.on = !d.mic_muted; syncControls("mic.on", null); }
    } else if (topic === "system.reboot" || topic === "system.poweroff") {
        if (d.pending) C.expectClose = topic === "system.reboot" ? `${S.robot.host} is restarting. It should be back in about a minute.` : `${S.robot.host} is shutting down. Someone has to reach its power supply to start it again.`;
        else if (d.scheduled === false) C.expectClose = "";
        return;
    } else return;
    afterChange();
}

// ---- Control builders ----
const idOf = (k) => "c-" + k.replace(/\./g, "-");
function slider(k, label, o) {
    const id = idOf(k), v = get(k), u = o.unit ? " " + o.unit : "";
    const lab = o.labels || [minus(o.min) + u, minus(o.max) + u];
    return `<div class="field" data-field="${k}">
<div class="field-head"><label for="${id}">${label}</label><span class="num"><input type="number" id="${id}-n" data-k="${k}" min="${o.min}" max="${o.max}" step="${o.step}" value="${v}" aria-label="${label}, exact value">${o.unit ? `<span class="unit">${o.unit}</span>` : ""}</span></div>
<input type="range" id="${id}" class="range${o.bipolar ? " bipolar" : ""}" data-k="${k}" min="${o.min}" max="${o.max}" step="${o.step}" value="${v}">
<div class="ticks">${lab.map((t) => `<span>${t}</span>`).join("")}</div></div>`;
}
function seg(k, label, opts) {
    const id = idOf(k), v = String(get(k));
    return `<div class="field" data-field="${k}"><span class="field-label" id="${id}-l">${label}</span><div class="seg" role="radiogroup" aria-labelledby="${id}-l">${opts.map(([val, t]) =>
        `<label class="seg-opt"><input type="radio" name="${id}" id="${id}-${val}" data-k="${k}" value="${val}"${String(val) === v ? " checked" : ""}><span>${t}</span></label>`).join("")}</div></div>`;
}
function toggle(k, label) {
    const id = idOf(k);
    return `<label class="switch-row" data-field="${k}" for="${id}"><span>${label}</span><input type="checkbox" role="switch" id="${id}" data-k="${k}"${get(k) ? " checked" : ""}><span class="switch" aria-hidden="true"></span></label>`;
}
const btn = (act, label, cls = "") => `<button type="button" class="btn ${cls}" data-act="${act}">${label}</button>`;
const hint = (t) => `<p class="hint">${t}</p>`;
const box = (...parts) => `<div class="box">${parts.join("")}</div>`;
const check = (act, name, desc, label = "Run") => `<div class="check"><div><strong>${name}</strong><span>${desc}</span></div>${btn(act, label, "sm")}</div>`;
const checks = (...rows) => `<div class="checks">${rows.join("")}</div>`;
const adv = (id, body) => `<details class="adv" data-adv="${id}"${S.ui.adv[id] ? " open" : ""}><summary><svg class="ic"><use href="#i-chev"/></svg>Advanced</summary><div class="adv-body">${body}</div></details>`;

const GLYPH = {
    happy: '<svg class="glyph" viewBox="0 0 30 30" aria-hidden="true"><rect x="3" y="5" width="24" height="20" rx="4"/><circle class="f" cx="11" cy="13" r="1.8"/><circle class="f" cx="19" cy="13" r="1.8"/><path d="M10 18q5 4 10 0"/></svg>',
    sad: '<svg class="glyph" viewBox="0 0 30 30" aria-hidden="true"><rect x="3" y="5" width="24" height="20" rx="4"/><circle class="f" cx="11" cy="13" r="1.8"/><circle class="f" cx="19" cy="13" r="1.8"/><path d="M10 20.5q5 -4 10 0"/></svg>',
    blink: '<svg class="glyph" viewBox="0 0 30 30" aria-hidden="true"><rect x="3" y="5" width="24" height="20" rx="4"/><path d="M9 13h4M17 13h4M11 19h8"/></svg>',
    cycle: '<svg class="glyph" viewBox="0 0 30 30" aria-hidden="true"><path d="M22 11a8 8 0 0 0-14-1M8 19a8 8 0 0 0 14 1"/><path d="M8 6v4h4M22 24v-4h-4"/></svg>',
};

// ---- Sections: everyday controls first, Advanced folded at the bottom ----
const verbOptions = () => (S.robot.verbs.size ? [...S.robot.verbs].sort() : VERBS).map((v) => `<option${v === "servo.calibrate" ? " selected" : ""}>${esc(v)}</option>`).join("");
const SECTIONS = [
    { id: "movement", name: "Movement", render: () => `<div class="stack">
        ${box(slider("flip.left", "Left flipper", { min: -100, max: 100, step: 1, bipolar: true, labels: ["Reverse", "Stop", "Forward"] }),
            slider("flip.right", "Right flipper", { min: -100, max: 100, step: 1, bipolar: true, labels: ["Reverse", "Stop", "Forward"] }))}
        ${hint("Reset stops both flippers.")}
        ${adv("movement", `<p class="sub">Flipper calibration</p>
            ${hint("Use this when a flipper creeps while it should stand still. Pick a side and start holding, drag until that flipper stops moving, then save.")}
            ${box(seg("cal.side", "Flipper", [["left", "Left"], ["right", "Right"]]),
                `<div class="readout" data-slot="calStored">${calStored()}</div>`,
                slider("cal.us", "Pulse width", { min: 1400, max: 1600, step: 1, unit: "µs" }))}
            <div class="row">${btn("calStart", "Start holding")}${btn("calSave", "Save as still point", "primary")}${btn("calRelease", "Release")}</div>
            <div class="row">${btn("diag:servo.calibration", "Read stored values", "sm")}${btn("calReset", "Reset to shipped values", "sm ghost")}</div>`)}</div>` },
    { id: "light", name: "Light ring", render: () => `<div class="stack">
        ${seg("ring.mode", "Pattern", Object.entries(RING).map(([v, r]) => [v, r.label]))}
        ${adv("light", checks(
            check("diag:ring.status", "Ring status", "Whether the light ring is connected and working"),
            check("diag:ring.modes", "Patterns", "The light patterns this robot knows")))}</div>` },
    { id: "face", name: "Face", render: () => `<div class="stack">
        <div class="field"><span class="field-label">Expression</span><div class="expr">
            <button type="button" data-act="mood:HAPPY" data-mood="HAPPY" aria-pressed="${S.face.mood === "HAPPY"}">${GLYPH.happy}Happy</button>
            <button type="button" data-act="mood:SAD" data-mood="SAD" aria-pressed="${S.face.mood === "SAD"}">${GLYPH.sad}Sad</button>
            <button type="button" data-act="blink">${GLYPH.blink}Blink</button>
            <button type="button" data-act="moodCycle">${GLYPH.cycle}Cycle moods</button>
        </div></div></div>` },
    { id: "led", name: "Button light", render: () => `<div class="stack">
        ${seg("led.mode", "Mode", [["off", "Off"], ["on", "On"], ["pulse", "Pulse"], ["breathe", "Breathe"]])}</div>` },
    { id: "sound", name: "Sound", render: () => `<div class="stack">
        ${box(slider("sound.volume", "Volume", { min: 0, max: 100, step: 1, unit: "%" }), toggle("sound.muted", "Mute speaker"))}
        <p class="sub">Speaker and microphone test</p>
        ${hint("Records 3 seconds, then plays the recording back. Speak while it records.")}
        <div class="row">${btn("runTest", "Run test", "primary")}</div>
        <div data-slot="testResult">${testResult()}</div>
        ${adv("sound", `${box(toggle("sound.playback", "Play the recording back"),
                toggle("sound.normalise", "Play it back at a comfortable level"),
                hint("Turn this off to hear the raw recording, which is usually very quiet."))}
            <div class="row">${btn("stopPlay", "Stop playback")}</div>
            ${S.sound.device ? `<div class="device"><svg class="ic"><use href="#i-speaker"/></svg><code>${esc(S.sound.device)}</code></div>` : ""}
            ${checks(
                check("diag:audio.volume.get", "Volume", "The volume and mute state the robot reports"),
                check("diag:audio.devices", "Audio devices", "The sound cards the robot can see"))}`)}</div>` },
    { id: "mic", name: "Microphone", render: () => `<div class="stack">
        ${box(toggle("mic.on", "Microphone on"), hint("Off disconnects the microphone in hardware."))}
        ${adv("mic", `${seg("mic.rate", "Stream rate", [[16000, "16 kHz"], [48000, "48 kHz"]])}
            ${hint("48 kHz is the default. 16 kHz can sound garbled on current robots.")}
            ${seg("mic.channel", "Channel", [["left", "Left"], ["right", "Right"]])}
            ${box(toggle("mic.hpfOn", "High-pass filter at 80 Hz"), hint("Cuts low rumble, like desk knocks and fan noise."))}
            <p class="sub">Mixer</p>
            ${box(slider("mic.boostL", "Input boost, left", { min: 0, max: 3, step: 1 }),
                slider("mic.boostR", "Input boost, right", { min: 0, max: 3, step: 1 }),
                hint("Input boost makes the microphone more sensitive before the sound is digitised. Raise it first if the robot can't hear you."),
                slider("mic.capture", "Capture gain", { min: 0, max: 63, step: 1 }),
                hint("Capture gain is a digital volume applied afterwards. It makes your voice and the background noise louder alike."))}
            <div class="row">${btn("mixerReset", "Reset to shipped default", "ghost")}</div>
            ${checks(
                check("diag:audio.capture.config", "Recording settings", "How the robot is recording right now"),
                check("diag:audio.capture.stats", "Recording levels", "Input and output levels since the last reset"),
                check("diag:audio.capture.stats.reset", "Reset levels", "Start measuring the levels again", "Reset"),
                check("diag:audio.mixer.get", "Mixer values", "Every mixer setting and its value"))}`)}</div>` },
    { id: "advanced", name: "Advanced", render: () => `<div class="stack">
        <p class="sub">Checks</p>
        ${hint("Each check asks the robot a question. The answer appears in the log.")}
        ${checks(
            check("diag:ping", "Ping", "Is the robot answering?"),
            check("diag:status", "Robot info", "Software version and the commands this robot understands"),
            check("diag:peripherals.status", "Hardware check", "Which parts are working: flippers, light ring, screen, audio"),
            check("diag:events.history", "Recent events", "The last 20 things the robot reported, like a button press or a flipper stopping"))}
        <p class="sub">Custom command</p>
        ${hint("Sends any command the robot understands, with your own values.")}
        ${box(`<div class="field"><label for="c-custom-verb">Command</label><select id="c-custom-verb">${verbOptions()}</select></div>`,
            `<div class="field"><label for="c-custom-args">Arguments (JSON)</label><textarea id="c-custom-args" rows="3" spellcheck="false" placeholder='{"id": "right", "null_us": 1510}'></textarea></div>`,
            `<p class="form-err" data-slot="customErr" hidden></p>`)}
        <div class="row">${btn("customSend", "Send", "primary")}</div></div>` },
];
const secById = (id) => SECTIONS.find((s) => s.id === id) || SECTIONS[0];

const dbfs = (v) => minus(+v.toFixed(1)) + " dBFS";
const barPct = (db) => clamp((db + 60) / 60 * 100, 0, 100).toFixed(1);
function testResult() {
    if (S.sound.running) return `<p class="working">Recording for 3 s. Speak now.</p>`;
    if (S.sound.error) return `<p class="form-err">${esc(S.sound.error)}</p>`;
    const r = S.sound.result;
    if (!r) return "";
    const verdict = r.rms < -60 ? "Silent: the microphone isn't hearing you" : r.rms < -45 ? "Quiet: speak closer, or raise the input boost" : r.rms > -12 ? "Very loud: lower the capture gain" : "Healthy";
    return `<div class="meters"><span class="cap">Last test: ${verdict}${r.clipped ? `. ${r.clipped} samples clipped: lower the capture gain` : ""}</span>
        <div class="meter"><span>Peak</span><div class="bar"><i style="width:${barPct(r.peak)}%"></i></div><code>${dbfs(r.peak)}</code></div>
        <div class="meter"><span>RMS</span><div class="bar"><i style="width:${barPct(r.rms)}%"></i></div><code>${dbfs(r.rms)}</code></div>
        <div class="meter scale"><span></span><span><span>${minus(-60)}</span><span>${minus(-30)}</span><span>0 dBFS</span></span><span></span></div></div>`;
}
function calStored() {
    const us = (v) => (v == null ? "?" : v);
    return (S.cal.holding ? `<span class="hold">Holding the ${S.cal.side} flipper. Release when you're done.</span>` : "") +
        `Stored still point <code>L ${us(S.cal.stored.left)} µs</code><code>R ${us(S.cal.stored.right)} µs</code>`;
}
function updateSlots() {
    $$('[data-slot="testResult"]').forEach((x) => { x.innerHTML = testResult(); });
    $$('[data-slot="calStored"]').forEach((x) => { x.innerHTML = calStored(); });
}

// ---- Commands each control sends (same commands and values as console.html) ----
function sendRing() {
    const r = RING[S.ring.mode];
    return send("ring.mode", r && r.params ? { mode: S.ring.mode, params: r.params } : { mode: "off" });
}
const sendLed = () => send("button_led", { mode: S.led.mode });
const sendTune = () => send("audio.capture.tune", Object.assign({ stream_rate: S.mic.rate, channel_mode: S.mic.channel }, S.mic.hpfOn ? { hpf_hz: 80 } : { hpf_mode: "off" }));
const setMixer = (key) => (S.mic.missing.has(key) ? null : send("audio.mixer.set", { name: MIXER[key], value: String(S.mic[key]) }));
const SEND = {
    "flip.left": () => send("flipper.left", { speed: S.flip.left / 100 }),
    "flip.right": () => send("flipper.right", { speed: S.flip.right / 100 }),
    "ring.mode": sendRing,
    "led.mode": sendLed,
    "sound.volume": () => send("audio.volume", { percent: S.sound.volume }),
    "sound.muted": () => send("audio.mute", { muted: S.sound.muted }),
    "mic.on": () => send("audio.mic_mute", { muted: !S.mic.on }),
    "mic.rate": () => send("audio.capture.tune", { stream_rate: S.mic.rate }),
    "mic.channel": () => send("audio.capture.tune", { channel_mode: S.mic.channel }),
    "mic.hpfOn": () => send("audio.capture.tune", S.mic.hpfOn ? { hpf_hz: 80 } : { hpf_mode: "off" }),
    "mic.boostL": () => setMixer("boostL"),
    "mic.boostR": () => setMixer("boostR"),
    "mic.capture": () => setMixer("capture"),
    "cal.us": () => { if (S.cal.holding) send("servo.hold", { id: S.cal.side, us: S.cal.us }); },
};

// ---- Saving, resets, presets ----
// What the robot can keep through a restart is saved automatically, a moment after the last change
const AUTOSAVE = new Set(["sound.volume", "mic.boostL", "mic.boostR", "mic.capture"]);
let saveT = null;
function autosave() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
        if (!C.connected) return;
        if (supports("audio.volume")) send("audio.volume", { percent: S.sound.volume, persist: true });
        if (supports("audio.mixer.store")) send("audio.mixer.store");
    }, 1500);
}
const RESET = {
    movement: () => {
        if (S.cal.holding) { S.cal.holding = false; send("servo.hold.stop", {}, { urgent: true }); }
        S.flip.left = 0; S.flip.right = 0;
        send("flipper.stop_all", {}, { urgent: true });
    },
    light: () => { S.ring.mode = DEFAULTS.ring.mode; sendRing(); },
    face: () => { S.face.mood = DEFAULTS.face.mood; send("cyd.mood", { value: S.face.mood }); },
    led: () => { S.led.mode = DEFAULTS.led.mode; sendLed(); },
    sound: () => {
        Object.assign(S.sound, clone(DEFAULTS.sound));
        send("audio.volume", { percent: S.sound.volume });
        send("audio.mute", { muted: false });
        autosave();
    },
    mic: () => {
        const { on, rate, channel, hpfOn } = DEFAULTS.mic;
        Object.assign(S.mic, { on, rate, channel, hpfOn });
        send("audio.mic_mute", { muted: false });
        sendTune();
        // The robot knows its shipped mixer values; read them back rather than guess
        send("audio.mixer.reset").then(() => readMixer()).then(() => { refreshPanel(); afterChange(); autosave(); });
    },
};
const snapshot = () => ({
    ring: { mode: S.ring.mode }, led: { mode: S.led.mode }, face: { mood: S.face.mood },
    sound: { volume: S.sound.volume, muted: S.sound.muted, playback: S.sound.playback, normalise: S.sound.normalise },
    mic: { on: S.mic.on, rate: S.mic.rate, channel: S.mic.channel, hpfOn: S.mic.hpfOn, boostL: S.mic.boostL, boostR: S.mic.boostR, capture: S.mic.capture },
});
function applySnap(s) {
    S.ring.mode = s.ring.mode; S.led.mode = s.led.mode; S.face.mood = s.face.mood;
    Object.assign(S.sound, s.sound);
    Object.assign(S.mic, s.mic);
    sendRing();
    sendLed();
    send("cyd.mood", { value: S.face.mood });
    send("audio.volume", { percent: S.sound.volume });
    send("audio.mute", { muted: S.sound.muted });
    send("audio.mic_mute", { muted: !S.mic.on });
    sendTune();
    ["boostL", "boostR", "capture"].forEach(setMixer);
    autosave();
}
let PRESETS = store.get(K.presets, []);
if (!Array.isArray(PRESETS)) PRESETS = [];
const presetMenuHTML = () => `<button type="button" class="pop-item" role="menuitem" data-act="applyPreset:default">Default</button>
    ${PRESETS.map((p, i) => `<button type="button" class="pop-item" role="menuitem" data-act="applyPreset:${i}">${esc(p.name)}</button>`).join("")}
    <div class="menu-sep"></div>
    <button type="button" class="pop-item" role="menuitem" data-act="savePreset"><svg class="ic"><use href="#i-plus"/></svg>Save current settings as a preset…</button>`;
function setPresetMenu(open) {
    const pop = $("#presetPop"), b = $("#presetBtn");
    if (!pop) return;
    if (open) pop.innerHTML = presetMenuHTML();
    pop.hidden = !open;
    b.setAttribute("aria-expanded", String(open));
}

// ---- The robot (front view) ----
const ang = { l: 0, r: 0 };
let blinkUntil = 0;
function robotSVG() {
    let grille = "";
    [[252, 3], [261, 5], [270, 7]].forEach(([y, n]) => {
        for (let k = 0; k < n; k++) {
            const cx = 180 + (k - (n - 1) / 2) * 8;
            grille += `<circle class="rb-grille" cx="${cx}" cy="${y}" r="2"/><circle class="rb-grille-lit" data-p="${((cx - 156) / 48).toFixed(3)}" cx="${cx}" cy="${y}" r="2" opacity="0"/>`;
        }
    });
    const flipper = (id, x) => `<g id="${id}" transform="translate(${x} 150)"><rect class="rb-shell" x="-11" y="-36" width="22" height="104" rx="11"/><circle class="rb-pivot" r="3.5"/></g>`;
    return `<svg class="robot" viewBox="28 36 304 272" role="group" aria-label="The robot from the front. Select a part to control it.">
    <defs><filter id="rbBlur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter></defs>
    <rect id="rbGlow" x="74" y="74" width="212" height="158" rx="28" filter="url(#rbBlur)" opacity="0"/>
    <g class="part" data-part="movement" tabindex="0" role="button" aria-label="Flippers"><title>Flippers</title>
        <rect class="hl" x="38" y="98" width="44" height="136" rx="14"/><rect class="hl" x="278" y="98" width="44" height="136" rx="14"/>
        <rect class="rb-axle" x="62" y="146" width="18" height="8" rx="2"/><rect class="rb-axle" x="280" y="146" width="18" height="8" rx="2"/>
        ${flipper("rbFlipL", 62)}${flipper("rbFlipR", 298)}
    </g>
    <rect class="rb-shell" x="92" y="284" width="176" height="16" rx="8"/>
    <path class="rb-body" d="M150 226 C150 252 124 266 108 286 L252 286 C236 266 210 252 210 226 Z"/>
    <g class="part" data-part="sound" tabindex="0" role="button" aria-label="Speaker, in the base"><title>Speaker (in the base)</title>
        <rect class="hl" x="140" y="244" width="80" height="34" rx="10"/>${grille}
    </g>
    <g class="part" data-part="mic" tabindex="0" role="button" aria-label="Microphone, in the base"><title>Microphone (in the base)</title>
        <circle class="hl" cx="236" cy="292" r="10"/><circle class="rb-mic" cx="236" cy="292" r="2.6"/>
        <line class="rb-mic-off" id="rbMicOff" x1="230" y1="298" x2="242" y2="286"/>
    </g>
    <g class="part" data-part="light" tabindex="0" role="button" aria-label="Light ring, shining through the shell"><title>Light ring (shines through the shell)</title>
        <rect class="hl" x="72" y="72" width="216" height="162" rx="31"/>
        <rect class="rb-body" x="78" y="78" width="204" height="150" rx="26"/>
        <rect class="rb-edge" id="rbEdge" x="79.5" y="79.5" width="201" height="147" rx="24.5" pathLength="100" opacity="0"/>
    </g>
    <g class="part" data-part="face" tabindex="0" role="button" aria-label="Screen"><title>Screen</title>
        <rect class="hl" x="88" y="88" width="184" height="132" rx="18"/>
        <rect class="rb-shell" x="94" y="92" width="172" height="122" rx="16"/>
        <rect class="rb-screen" x="102" y="100" width="156" height="106" rx="9"/>
        <ellipse class="rb-face" id="rbEyeL" cx="154" cy="142" rx="9" ry="10"/><ellipse class="rb-face" id="rbEyeR" cx="206" cy="142" rx="9" ry="10"/>
        <path class="rb-mouth" id="rbMouth"/>
    </g>
    <g class="part" data-part="led" tabindex="0" role="button" aria-label="Button on top"><title>Button (on top)</title>
        <rect class="hl" x="157" y="44" width="46" height="40" rx="10"/>
        <circle class="rb-led" id="rbBtnGlow" cx="180" cy="60" r="17" filter="url(#rbBlur)" opacity="0"/>
        <path class="rb-shell" d="M165 58 L165 78 A15 4.5 0 0 0 195 78 L195 58 Z"/>
        <ellipse class="rb-shell" cx="180" cy="58" rx="15" ry="4.5"/>
        <ellipse class="rb-led" id="rbBtnLit" cx="180" cy="58" rx="15" ry="4.5" opacity="0"/>
    </g>
</svg>`;
}
// The flippers turn on an axle that comes out of the side, so from the front they only grow and shrink in height
function drawFlipper(g, deg) {
    const c = Math.cos(deg * Math.PI / 180);
    let top = Math.min(-36 * c, 68 * c), bot = Math.max(-36 * c, 68 * c);
    if (bot - top < 22) { const m = (top + bot) / 2; top = m - 11; bot = m + 11; }
    const r = g.querySelector("rect");
    r.setAttribute("y", top.toFixed(1));
    r.setAttribute("height", (bot - top).toFixed(1));
}
function drawRobot(t = performance.now()) {
    const svg = $("#consoleRoot svg.robot");
    if (!svg) return;
    // The drawing shows every pattern in one colour; the panel names the real colour
    const mode = S.ring.mode, on = mode !== "off", col = on ? "var(--ring-blue)" : "";
    let level = on ? 1 : 0;
    if (on && !reduced && mode === "pulse") level = 0.2 + 0.8 * (0.5 + 0.5 * Math.sin(t / 1500 * 2 * Math.PI));
    const glow = svg.querySelector("#rbGlow");
    glow.style.fill = col;
    glow.setAttribute("opacity", on ? (0.55 * (mode === "spin" ? 0.7 : level)).toFixed(2) : "0");
    // Only spin draws on the shell itself: a light running round its edge
    const edge = svg.querySelector("#rbEdge");
    edge.style.stroke = col;
    edge.setAttribute("opacity", on && mode === "spin" ? "1" : "0");
    if (on && mode === "spin" && !reduced) {
        edge.setAttribute("stroke-dasharray", "22 78");
        edge.setAttribute("stroke-dashoffset", (-(t / 1500 * 100) % 100).toFixed(1));
    } else {
        edge.removeAttribute("stroke-dasharray");
        edge.removeAttribute("stroke-dashoffset");
    }
    drawFlipper(svg.querySelector("#rbFlipL"), reduced ? S.flip.left * 0.8 : ang.l);
    drawFlipper(svg.querySelector("#rbFlipR"), reduced ? S.flip.right * 0.8 : ang.r);
    const blinking = t < blinkUntil;
    ["#rbEyeL", "#rbEyeR"].forEach((s) => svg.querySelector(s).setAttribute("ry", blinking ? "1.5" : "10"));
    svg.querySelector("#rbMouth").setAttribute("d", S.face.mood === "SAD" ? "M162 184 Q180 170 198 184" : "M162 174 Q180 188 198 174");
    const m = S.led.mode;
    let lit = m === "off" ? 0 : 1;
    if (!reduced && m === "pulse") lit = (t % 1000) < 500 ? 1 : 0.15;
    if (!reduced && m === "breathe") lit = 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(t / 2000 * 2 * Math.PI));
    svg.querySelector("#rbBtnLit").setAttribute("opacity", lit.toFixed(2));
    svg.querySelector("#rbBtnGlow").setAttribute("opacity", (lit * 0.7).toFixed(2));
    // The speaker grille fills from left to right like a slider, with a soft edge
    const vol = S.sound.muted ? 0 : S.sound.volume / 100, soft = 0.3;
    svg.querySelectorAll(".rb-grille-lit").forEach((g) => {
        const v = vol <= 0 ? 0 : clamp((vol * (1 + soft) - Number(g.dataset.p)) / soft, 0, 1);
        g.setAttribute("opacity", v.toFixed(2));
    });
    svg.querySelector("#rbMicOff").style.display = S.mic.on ? "none" : "";
    svg.querySelectorAll(".part").forEach((g) => g.classList.toggle("is-sel", g.dataset.part === S.ui.sel));
}
let lastT = performance.now();
function loop(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;
    if (S.view === "console") {
        if (!reduced) { ang.l += S.flip.left / 100 * 240 * dt; ang.r += S.flip.right / 100 * 240 * dt; }
        drawRobot(t);
    }
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
document.addEventListener("keydown", (e) => {
    const part = e.target.closest?.(".part");
    if (part && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(part.dataset.part); }
});

// ---- Under the robot: quick toggles, presets, reset ----
function quickHTML() {
    const muted = S.sound.muted, micOn = S.mic.on;
    return `<button type="button" class="qa" data-act="quickMute" aria-pressed="${muted}"><svg class="ic"><use href="#${muted ? "i-speaker-off" : "i-speaker"}"/></svg>${muted ? "Unmute speaker" : "Mute speaker"}</button>` +
        `<button type="button" class="qa" data-act="quickMic" aria-pressed="${!micOn}"><svg class="ic"><use href="#${micOn ? "i-mic" : "i-mic-off"}"/></svg>${micOn ? "Turn mic off" : "Turn mic on"}</button>`;
}
function updateQuick() {
    const key = `${S.sound.muted}|${S.mic.on}`;
    $$('[data-slot="quick"]').forEach((x) => { if (x.dataset.key !== key) { x.dataset.key = key; x.innerHTML = quickHTML(); } });
}
const toolsHTML = () => `<div class="stage-tools">
    <div class="tools-row">
        <span class="tools-quick" data-slot="quick" data-key="${S.sound.muted}|${S.mic.on}">${quickHTML()}</span>
        <div class="pop-wrap">
            <button type="button" class="btn sm" id="presetBtn" data-act="presets" aria-haspopup="menu" aria-expanded="false" aria-controls="presetPop">Presets<svg class="ic chev"><use href="#i-chev"/></svg></button>
            <div class="pop" id="presetPop" role="menu" aria-label="Presets" hidden></div>
        </div>
        ${btn("resetAll", '<svg class="ic"><use href="#i-reset"/></svg>Reset everything', "ghost sm danger-t push")}
    </div>
</div>`;

// ---- Rendering the console ----
const panel = () => {
    const s = secById(S.ui.sel);
    const reset = RESET[s.id] ? `<button type="button" class="btn ghost sm" data-act="reset:${s.id}" title="Reset ${s.name.toLowerCase()} to defaults"><svg class="ic"><use href="#i-reset"/></svg>Reset</button>` : "";
    return `<section class="card" aria-labelledby="ph-${s.id}"><header class="card-head"><h2 id="ph-${s.id}">${s.name}</h2>${reset}</header>${s.render()}</section>`;
};
const cur = (id) => (id === S.ui.sel ? ' aria-current="true"' : "");
function renderConsole() {
    const root = $("#consoleRoot");
    root.innerHTML = `<div class="robotwrap"><div class="robot-stage">${robotSVG()}
        <div class="part-chips" role="group" aria-label="Parts">${SECTIONS.map((s) => `<button type="button" data-act="sel:${s.id}"${cur(s.id)}>${s.name}</button>`).join("")}</div>
        ${toolsHTML()}</div>
        <div id="selPanel">${panel()}</div></div>`;
    hydrate(root);
}
function hydrate(root) {
    root.querySelectorAll("input[type=range]").forEach(paint);
    afterChange();
}
function refreshPanel() {
    const p = $("#selPanel");
    if (p) { p.innerHTML = panel(); hydrate(p); }
}
function select(id) {
    S.ui.sel = secById(id).id;
    saveUI();
    refreshPanel();
    $$('#consoleRoot [data-act^="sel:"]').forEach((b) => (b.dataset.act === "sel:" + S.ui.sel ? b.setAttribute("aria-current", "true") : b.removeAttribute("aria-current")));
    drawRobot();
}

function paint(el) {
    const min = +el.min, max = +el.max, p = (+el.value - min) / (max - min) * 100;
    if (el.classList.contains("bipolar")) {
        el.style.setProperty("--a", Math.min(p, 50) + "%");
        el.style.setProperty("--b", Math.max(p, 50) + "%");
    } else {
        el.style.setProperty("--a", "0%");
        el.style.setProperty("--b", p + "%");
    }
}
function syncControls(k, src) {
    const v = get(k);
    $$(`[data-k="${k}"]`).forEach((el) => {
        if (el !== src) {
            if (el.type === "checkbox") el.checked = !!v;
            else if (el.type === "radio") el.checked = String(el.value) === String(v);
            else el.value = v;
        }
        if (el.type === "range") paint(el);
    });
}
function dis(k, off) {
    $$(`[data-k="${k}"]`).forEach((el) => { el.disabled = off; });
    $$(`[data-field="${k}"]`).forEach((f) => f.classList.toggle("is-off", off));
}
const btnDis = (act, off) => $$(`[data-act="${act}"]`).forEach((b) => { b.disabled = off; });
function syncDisabled() {
    dis("sound.normalise", !S.sound.playback);
    dis("cal.us", !S.cal.holding);
    dis("cal.side", S.cal.holding);
    btnDis("calStart", S.cal.holding);
    btnDis("calSave", !S.cal.holding);
    btnDis("calRelease", !S.cal.holding);
    btnDis("runTest", S.sound.running);
}
// Controls whose command this robot's daemon doesn't have are disabled, not left to fail
function syncSupport() {
    const why = (verb) => `This robot's rsc-host doesn't have ${verb}`;
    for (const [k, verb] of Object.entries(NEEDS_KEY)) {
        const mixerGone = k.startsWith("mic.") && S.mic.missing.has(k.slice(4));
        if (supports(verb) && !mixerGone) continue;
        dis(k, true);
        $$(`[data-field="${k}"]`).forEach((f) => { f.title = mixerGone ? "This robot's sound card has no such mixer control" : why(verb); });
    }
    $$("[data-act]").forEach((b) => {
        const a = b.dataset.act, i = a.indexOf(":"), cmd = i < 0 ? a : a.slice(0, i);
        const verb = cmd === "diag" ? a.slice(i + 1) : NEEDS_ACT[cmd];
        if (verb && !supports(verb)) { b.disabled = true; b.title = why(verb); }
    });
}
function afterChange() {
    syncDisabled();
    syncSupport();
    $$("[data-mood]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mood === S.face.mood)));
    updateQuick();
    drawRobot();
}

// Sends at most 10 times a second while dragging, and always sends the value you let go on
const thr = {};
function throttled(key, fn) {
    const t = thr[key] || (thr[key] = { last: 0, timer: null });
    clearTimeout(t.timer);
    const wait = 100 - (performance.now() - t.last);
    if (wait <= 0) { t.last = performance.now(); fn(); }
    else t.timer = setTimeout(() => { t.last = performance.now(); fn(); }, wait);
}

document.addEventListener("input", (e) => {
    const el = e.target;
    if (el.name === "theme") { S.ui.theme = el.value; saveUI(); applyTheme(); return; }
    const k = el.dataset?.k;
    if (!k || el.type === "number") return;
    let v;
    if (el.type === "checkbox") v = el.checked;
    else if (el.type === "radio") { if (!el.checked) return; v = typeof get(k) === "number" ? Number(el.value) : el.value; }
    else if (el.type === "range") {
        v = Number(el.value);
        if ((k === "flip.left" || k === "flip.right") && Math.abs(v) <= 4) { v = 0; el.value = "0"; }
    } else return;
    touched[k] = performance.now();
    set(k, v);
    syncControls(k, el);
    if (k === "cal.side") updateSlots();
    afterChange();
    const fn = SEND[k];
    if (!fn) return;
    if (el.type === "range") throttled(k, fn);
    else fn();
    if (AUTOSAVE.has(k)) autosave();
});
document.addEventListener("change", (e) => {
    const el = e.target, k = el.dataset?.k;
    if (!k || el.type !== "number") return;
    const min = +el.min, max = +el.max, step = +el.step || 1;
    let v = Number(el.value);
    if (el.value.trim() === "" || !Number.isFinite(v)) v = get(k);
    v = +clamp(Math.round(v / step) * step, min, max).toFixed(2);
    touched[k] = performance.now();
    set(k, v);
    syncControls(k, null);
    afterChange();
    SEND[k]?.();
    if (AUTOSAVE.has(k)) autosave();
});
document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.matches?.("details[data-adv]")) { S.ui.adv[d.dataset.adv] = d.open; saveUI(); }
}, true);

// ---- Chat ----
// sendToRobot() is the swap point for the real chat. It must be an async
// generator that yields pieces of the answer as text. The proposed backend
// (host.md §5.6, not agreed yet): open ws://host:port/chat with
// ["bearer", token], send {text, history}, yield each {"delta"} until
// {"done"}, and close the socket when `signal` aborts.
const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
});
async function* sendToRobot(text, { files = [], history = [], signal } = {}) {
    const answer = cannedAnswer(text, files, history);
    await sleep(750, signal);
    const parts = answer.split(/(\s+)/);
    for (let i = 0; i < parts.length; i += 2) {
        await sleep(110 + Math.random() * 90, signal);
        yield parts.slice(i, i + 2).join("");
    }
}
// listenOnRobot() is the swap point for voice: the robot listens with its own
// microphone and returns the words it heard. Needs speech-to-text on rsc-host.
const VOICE_LINES = ["Can you quiz me on what I studied today?", "Explain spaced repetition again, but shorter", "Make a study plan for 90 minutes"];
let voiceN = 0;
function listenOnRobot({ signal, onFinish }) {
    return new Promise((resolve, reject) => {
        const done = () => { clearTimeout(t); resolve(VOICE_LINES[voiceN++ % VOICE_LINES.length]); };
        const t = setTimeout(done, 2600);
        onFinish(done);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    });
}

const ANS = {
    plan: "Here is a plan for a 90 minute session:\n1. **10 min**: skim last lecture's notes and write 3 questions you cannot answer yet.\n2. **25 min**: work through those questions. No phone.\n3. **5 min**: break. Stand up, drink water.\n4. **25 min**: practice problems on the same topic.\n5. **15 min**: explain the topic out loud to me, as if I were a first year.\n6. **10 min**: write down what is still unclear for next time.\nWant me to remind you when each block ends?",
    spaced: "**Spaced repetition** means reviewing material at growing intervals instead of all at once.\n- Review a new topic after **1 day**, then **3 days**, then **a week**.\n- Each review is a quick self-test, not a reread.\n- If you forget something, that interval starts again.\nWant me to quiz you on something you studied this week?",
    quiz: "Quick question. Which of these helps you remember most?\n- **A**: rereading your notes three times\n- **B**: testing yourself without looking\n- **C**: highlighting the key sentences\nReply with A, B or C.",
    right: "**Correct.** Testing yourself makes your brain retrieve the answer, and that retrieval is what strengthens memory. Want another one?",
    wrong: "Not quite. The answer is **B**: testing yourself without looking. Rereading and highlighting feel productive but build much weaker memories. Want another one?",
    fallback: "I am a small model running on the robot, so I work best with focused questions. I can:\n- **explain** a concept step by step,\n- **quiz** you on what you are studying,\n- make a **study plan** for a session,\n- **summarise** your notes.\nWhat are you working on?",
    file: (names) => `I got **${names.join("**, **")}**. I can:\n- **summarise** it,\n- **quiz** you on it,\n- **explain** a part you're stuck on.\nWhich would help?`,
};
function cannedAnswer(text, files, history) {
    if (files.length && !/quiz|plan|explain|summar/i.test(text)) return ANS.file(files.map((f) => f.name));
    const lastAi = [...history].reverse().find((m) => m.role === "ai");
    if (lastAi && lastAi.text === ANS.quiz && /^\s*[abc]\s*\.?\s*$/i.test(text)) return /b/i.test(text) ? ANS.right : ANS.wrong;
    if (/plan/i.test(text)) return ANS.plan;
    if (/quiz|another/i.test(text)) return ANS.quiz;
    if (/spaced|repetition|explain/i.test(text)) return ANS.spaced;
    return ANS.fallback;
}

// Conversations live in this browser. Attachments are kept by name and size only.
let CHATS = store.get(K.chats, []);
if (!Array.isArray(CHATS)) CHATS = [];
const newChatObj = () => ({ id: "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: "New chat", at: Date.now(), msgs: [{ role: "intro" }] });
if (!CHATS.length) CHATS.push(newChatObj());
let chatId = CHATS[0].id, stream = null, voice = null, pending = [];
const curChat = () => CHATS.find((c) => c.id === chatId) || CHATS[0];
const saveChats = () => store.set(K.chats, CHATS.slice(0, 50));
const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const fileChip = (f, i) => `<span class="file-chip"><svg class="ic"><use href="#i-file"/></svg><span class="fn">${esc(f.name)}</span><small>${fmtSize(f.size)}</small>${i == null ? "" : `<button type="button" class="icon-btn sm" data-act="unattach:${i}" aria-label="Remove ${esc(f.name)}"><svg class="ic"><use href="#i-x"/></svg></button>`}</span>`;
const via = (icon, text) => `<span class="via"><svg class="ic"><use href="#${icon}"/></svg>${text}</span>`;

function md(t) {
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    let html = "", list = null;
    for (const ln of esc(t).split("\n")) {
        let m;
        if ((m = ln.match(/^\d+\. (.*)/))) { if (list !== "ol") { html += (list ? `</${list}>` : "") + "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; }
        else if ((m = ln.match(/^- (.*)/))) { if (list !== "ul") { html += (list ? `</${list}>` : "") + "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; }
        else { if (list) { html += `</${list}>`; list = null; } if (ln.trim()) html += `<p>${inline(ln)}</p>`; }
    }
    return html + (list ? `</${list}>` : "");
}
function msgHTML(m) {
    if (m.role === "intro") {
        const s = ["Explain spaced repetition", "Quiz me", "Make a study plan for 90 minutes"];
        return `<div class="msg ai"><p><strong>Hi, I am your study companion.</strong> I run on a small language model on the robot, so I think slowly, a few words a second. Try one of these:</p><div class="sugg">${s.map((x) => `<button type="button" data-act="sugg:${x}">${x}</button>`).join("")}</div></div>`;
    }
    if (m.role === "user") {
        return `<div class="msg user">${m.voice ? via("i-mic", "Spoken") : ""}${m.files?.length ? `<div class="att">${m.files.map((f) => fileChip(f)).join("")}</div>` : ""}${m.text ? `<p>${esc(m.text).replace(/\n/g, "<br>")}</p>` : ""}</div>`;
    }
    return `<div class="msg ai">${m.spoken ? via("i-speaker", "Read aloud by the robot") : ""}${md(m.text)}</div>`;
}
function chatGroup(at) {
    const day = (d) => new Date(d).setHours(0, 0, 0, 0);
    const days = Math.round((day(Date.now()) - day(at)) / 86400000);
    return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "Previous 7 days" : "Older";
}
function chatListHTML() {
    const sorted = [...CHATS].sort((a, b) => b.at - a.at);
    return ["Today", "Yesterday", "Previous 7 days", "Older"].map((g) => {
        const cs = sorted.filter((c) => chatGroup(c.at) === g);
        return cs.length ? `<p class="side-label">${g}</p>` + cs.map((c) => `<button type="button" class="chat-item" data-act="openChat:${c.id}"${c.id === chatId ? ' aria-current="page"' : ""} title="${esc(c.title)}">${esc(c.title)}</button>`).join("") : "";
    }).join("");
}
function renderChatLists() {
    const html = chatListHTML();
    $("#chatSideList").innerHTML = html;
    $("#menuChatList").innerHTML = html;
}
function renderChat() {
    const c = curChat();
    chatId = c.id;
    $("#chatTitle").textContent = c.title;
    $("#chatMsgs").innerHTML = c.msgs.filter((m) => m.role !== "ai" || m.text).map(msgHTML).join("");
    renderChatLists();
    renderFiles();
    scrollChat();
    syncComposer();
}
const scrollChat = () => { const s = $("#chatScroll"); s.scrollTop = s.scrollHeight; };
function renderFiles() {
    const fbox = $("#fileChips");
    fbox.hidden = pending.length === 0;
    fbox.innerHTML = pending.map((f, i) => fileChip(f, i)).join("");
}
function syncComposer() {
    const b = $("#chatSend"), listening = !!voice;
    b.innerHTML = stream ? '<svg class="ic"><use href="#i-stop"/></svg><span>Stop</span>' : '<svg class="ic"><use href="#i-send"/></svg><span>Send</span>';
    b.classList.toggle("primary", !stream);
    b.disabled = listening;
    $("#chatInput").hidden = listening;
    $("#listening").hidden = !listening;
    const mic = $("#micBtn");
    mic.classList.toggle("rec", listening);
    mic.disabled = !!stream;
    mic.setAttribute("aria-pressed", String(listening));
    const label = listening ? "Stop listening and send" : "Talk to the robot";
    mic.setAttribute("aria-label", label);
    mic.title = label;
    $('[data-act="attach"]').disabled = listening;
}
async function sendChat(raw, opts = {}) {
    const text = raw.trim(), files = pending;
    if ((!text && !files.length) || stream) return;
    pending = [];
    const c = curChat();
    const history = c.msgs.filter((m) => m.role === "user" || m.role === "ai").map((m) => ({ role: m.role, text: m.text }));
    c.msgs.push({ role: "user", text, files, voice: !!opts.voice });
    c.at = Date.now();
    if (c.title === "New chat") { const t = text || files[0].name; c.title = t.length > 42 ? t.slice(0, 40) + "…" : t; }
    log("info", `chat: "${text}"${files.length ? ` with ${files.length} file${files.length > 1 ? "s" : ""}` : ""} (canned reply: rsc-host has no chat endpoint yet)`);
    const m = { role: "ai", text: "", spoken: !!opts.voice };
    c.msgs.push(m);
    renderChat();
    const el = document.createElement("div");
    el.className = "msg ai";
    el.innerHTML = '<span class="dots" aria-label="Thinking"><i></i><i></i><i></i></span>';
    $("#chatMsgs").appendChild(el);
    scrollChat();
    const ctrl = new AbortController();
    stream = ctrl;
    syncComposer();
    try {
        for await (const piece of sendToRobot(text, { files, history, signal: ctrl.signal })) {
            m.text += piece;
            if (chatId === c.id) {
                el.innerHTML = (m.spoken ? via("i-speaker", "Read aloud by the robot") : "") + md(m.text) + '<span class="cursor"></span>';
                scrollChat();
            }
        }
    } catch (exc) {
        if (exc.name !== "AbortError") log("err", `chat: ${exc.message}`);
    } finally {
        if (stream === ctrl) stream = null;
        if (!m.text) c.msgs.pop();
        saveChats();
        if (S.view === "chat") renderChat();
    }
}
function stopStream() { if (stream) stream.abort(); }
async function startVoice() {
    if (stream || voice) return;
    const ctrl = new AbortController();
    voice = { ctrl, finish: null };
    syncComposer();
    log("info", "chat: listening (stand-in: rsc-host has no speech-to-text yet)");
    try {
        const heard = await listenOnRobot({ signal: ctrl.signal, onFinish: (f) => { if (voice) voice.finish = f; } });
        voice = null;
        syncComposer();
        if (heard) sendChat(heard, { voice: true });
    } catch {
        voice = null;
        syncComposer();
    }
}
function endVoice(cancel) {
    if (!voice) return;
    if (cancel) voice.ctrl.abort();
    else voice.finish?.();
}
$("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (stream) { stopStream(); return; }
    const ta = $("#chatInput");
    sendChat(ta.value);
    ta.value = "";
    ta.style.height = "auto";
});
$("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); }
});
$("#chatInput").addEventListener("input", (e) => { const t = e.target; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; });
$("#fileInput").addEventListener("change", (e) => {
    for (const f of e.target.files) pending.push({ name: f.name, size: f.size });
    e.target.value = "";
    renderFiles();
    $("#chatInput").focus();
});

// ---- Connect page ----
// Recent robots: this page's own list, plus hosts console.html remembered
function recentRobots() {
    let list = store.get(K.recent, []);
    if (!Array.isArray(list)) list = [];
    const known = store.get(K.known, []);
    if (Array.isArray(known)) for (const h of known) if (typeof h === "string" && !list.some((r) => r.host === h)) list.push({ host: h, port: 8765, at: 0 });
    return list.filter((r) => r && r.host).sort((a, b) => (b.at || 0) - (a.at || 0));
}
function rememberRobot(host, port, token) {
    const list = recentRobots().filter((r) => r.host !== host);
    list.unshift({ host, port, at: Date.now() });
    store.set(K.recent, list.slice(0, 20));
    const known = new Set(store.get(K.known, []));
    known.add(host);
    store.set(K.known, [...known].sort());
    if (token) store.setRaw(K.token(host), token);
}
function forgetRobot(host) {
    store.set(K.recent, recentRobots().filter((r) => r.host !== host));
    store.set(K.known, (store.get(K.known, []) || []).filter((h) => h !== host));
    store.del(K.token(host));
}
function ago(at) {
    if (!at) return "";
    const s = (Date.now() - at) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    const d = Math.round(s / 86400);
    return d === 1 ? "yesterday" : `${d} days ago`;
}
function renderRecent() {
    const list = recentRobots();
    $("#recentList").innerHTML = list.map((r) => {
        const meta = [`port ${r.port}`, store.raw(K.token(r.host)) ? "token saved" : "no token saved", ago(r.at)].filter(Boolean).join(" · ");
        return `<li class="robot-row">
        <span class="rr-ic" aria-hidden="true"><svg class="ic" viewBox="0 0 32 32"><use href="#i-bot"/></svg></span>
        <div class="rr-main"><span class="rr-name">${esc(r.host)}</span><span class="rr-meta">${esc(meta)}</span></div>
        <button type="button" class="btn primary sm" data-act="connect:${esc(r.host)}">Connect</button>
        <button type="button" class="icon-btn sm" data-act="forget:${esc(r.host)}" aria-label="Forget ${esc(r.host)}" title="Forget this robot and its token"><svg class="ic"><use href="#i-x"/></svg></button></li>`;
    }).join("");
    $("#recentWrap").hidden = list.length === 0;
}
function formError(msg) {
    $("#cfErr").textContent = msg;
    $("#cfErr").hidden = !msg;
}
$("#connectForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const host = $("#cfHost").value.trim(), portRaw = $("#cfPort").value.trim(), token = $("#cfToken").value;
    const port = portRaw === "" ? 8765 : Number(portRaw);
    let msg = "";
    if (!host) msg = "Enter the robot's address, for example rsc-shiny.local.";
    else if (!Number.isInteger(port) || port < 1 || port > 65535) msg = "The port must be a whole number from 1 to 65535.";
    else if (!token) msg = "Enter the robot's token.";
    formError(msg);
    if (msg) return;
    connectTo(host, port, token, $("#cfSubmit"));
});
// A known robot's saved token fills in as you type its address, as in console.html
$("#cfHost").addEventListener("input", () => {
    const saved = store.raw(K.token($("#cfHost").value.trim()));
    if (saved && !$("#cfToken").value) $("#cfToken").value = saved;
});

// Scan: browsers can't search the network, so this tries likely names. A
// browser can't tell "no such name" from "robot said no" either, so every hit
// is only "possible" (host.md §4.2).
const SCAN_CANDIDATES = ["rsc-shiny", "rsc-pinky", "rsc-minion", "rsc-01", "rsc-02", "rsc-03", "shiny", "pinky", "minion"];
function probe(host, port, ms = 1500) {
    return new Promise((resolve) => {
        let done = false, sock;
        const finish = (found) => { if (done) return; done = true; try { sock.close(); } catch {} resolve(found); };
        try { sock = new WebSocket(`ws://${host}:${port}/`, ["bearer", "probe"]); }
        catch { resolve(false); return; }
        sock.onopen = () => finish(true);
        sock.onerror = () => {};
        sock.onclose = () => finish(true);
        setTimeout(() => finish(false), ms);
    });
}
async function scan(el) {
    const port = Number($("#cfPort").value.trim()) || 8765;
    const names = new Set([...recentRobots().map((r) => r.host.replace(/\.local$/, "")), ...SCAN_CANDIDATES]);
    el.disabled = true;
    el.textContent = "Scanning…";
    $("#scanList").hidden = true;
    log("info", `scanning ${names.size} likely names on port ${port}`);
    const hits = [];
    await Promise.all([...names].map(async (n) => { const h = n.includes(".") ? n : `${n}.local`; if (await probe(h, port)) hits.push(h); }));
    el.disabled = false;
    el.textContent = "Scan network";
    hits.sort();
    $("#scanList").innerHTML = hits.length
        ? hits.map((h) => `<li><span class="rr-name">${esc(h)}</span><span class="chip">possible</span><button type="button" class="btn sm" data-act="useScan:${esc(h)}">Use</button></li>`).join("")
        : `<li><span class="rr-name">Nothing answered. Type the robot's address instead.</span></li>`;
    $("#scanList").hidden = false;
}

// ---- Routing ----
const TITLES = { console: "Console", chat: "Chat", settings: "Settings" };
function go(view) {
    if (!["connect", "console", "chat", "settings"].includes(view)) view = "connect";
    if (view !== "connect" && !C.connected) view = "connect";
    if (view !== "chat") endVoice(true);
    S.view = view;
    document.body.dataset.view = view;
    $("#viewConnect").hidden = view !== "connect";
    $("#shell").hidden = view === "connect";
    $("#pageConsole").hidden = view !== "console";
    $("#pageChat").hidden = view !== "chat";
    $("#pageSettings").hidden = view !== "settings";
    $("#tbTitle").textContent = TITLES[view] || "Console";
    $("#stopAll").hidden = view !== "console";
    $("#logToggle").hidden = view === "settings";
    $$("[data-nav]").forEach((b) => (b.dataset.nav === view ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    closeMenu();
    if (view === "console") renderConsole();
    if (view === "chat") renderChat();
    applyDock();
}

// ---- Menu (side sheet below the top bar) ----
function placeMenu() { document.body.style.setProperty("--menu-top", Math.round($(".topbar").getBoundingClientRect().bottom) + "px"); }
function openMenu() {
    placeMenu();
    renderChatLists();
    $("#menu").hidden = false;
    $("#menuBackdrop").hidden = false;
    const b = $("#burger");
    b.setAttribute("aria-expanded", "true");
    b.setAttribute("aria-label", "Close menu");
    b.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
}
function closeMenu() {
    if ($("#menu").hidden) return;
    $("#menu").hidden = true;
    $("#menuBackdrop").hidden = true;
    const b = $("#burger");
    b.setAttribute("aria-expanded", "false");
    b.setAttribute("aria-label", "Open menu");
    b.innerHTML = '<svg class="ic"><use href="#i-menu"/></svg>';
}
addEventListener("resize", () => { if (!$("#menu").hidden) placeMenu(); });

// ---- Theme (Settings page) ----
function applyTheme() {
    const r = document.documentElement;
    if (S.ui.theme === "auto") r.removeAttribute("data-theme");
    else r.setAttribute("data-theme", S.ui.theme);
    $$('input[name="theme"]').forEach((i) => { i.checked = i.value === S.ui.theme; });
}

async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch {}
        ta.remove();
        return ok;
    }
}
function openModal(id, focusSel) {
    closeMenu();
    setPresetMenu(false);
    $(id).hidden = false;
    $(focusSel)?.focus();
}
const logText = () => LOG.filter((e) => matchesFilter(e.kind)).map((e) => `${fmtTime(e.t)} ${KIND[e.kind]} ${e.text}`).join("\n");

// Stop all: spinner until the robot confirms the stop
function stopping(el) {
    const t0 = performance.now(), token = (el._stopToken || 0) + 1;
    el._stopToken = token;
    el.innerHTML = '<i class="spin" aria-hidden="true"></i><span>Stopping</span>';
    el.setAttribute("aria-busy", "true");
    send("flipper.stop_all", {}, { urgent: true }).then(() => setTimeout(() => {
        if (el._stopToken !== token) return;
        el.innerHTML = '<svg class="ic"><use href="#i-stop"/></svg><span>Stop all</span>';
        el.removeAttribute("aria-busy");
    }, Math.max(0, 600 - (performance.now() - t0))));
}

function openPower() {
    const r = S.robot, allowed = !r.simulated && r.powerAllowed;
    $("#powerBody").textContent = allowed
        ? `Restart or shut down ${r.host}? Restart brings it back by itself in about a minute. After a shutdown, someone has to reach the power supply. Either way the flippers stop and the light ring goes dark first.`
        : r.simulated
            ? "This robot is simulated by rsc-host's fake backend, so there is nothing to restart or shut down."
            : `This robot doesn't let the console restart or shut it down${r.powerReason ? `: ${r.powerReason}` : ""}.${r.powerFix ? ` To fix it: ${r.powerFix}.` : ""}`;
    $("#powerReboot").disabled = !allowed;
    $("#powerOff").disabled = !allowed;
    openModal("#powerBg", '[data-act="closePower"]');
}

// ---- Actions ----
function act(a, el) {
    const i = a.indexOf(":"), cmd = i < 0 ? a : a.slice(0, i), arg = i < 0 ? "" : a.slice(i + 1);
    switch (cmd) {
        case "connect": {
            const r = recentRobots().find((x) => x.host === arg);
            if (!r) break;
            const token = store.raw(K.token(r.host));
            if (token) { connectTo(r.host, r.port || 8765, token, el); break; }
            $("#cfHost").value = r.host;
            $("#cfPort").value = String(r.port || 8765);
            formError(`Enter the token for ${r.host}.`);
            $("#cfToken").focus();
            break;
        }
        case "forget": forgetRobot(arg); renderRecent(); break;
        case "scan": scan(el); break;
        case "useScan": $("#cfHost").value = arg; $("#cfHost").dispatchEvent(new Event("input")); $("#cfToken").focus(); break;
        case "menu": $("#menu").hidden ? openMenu() : closeMenu(); break;
        case "closeMenu": closeMenu(); break;
        case "nav": go(arg); break;
        case "toggleLog": setDock(S.dock.state === "closed" ? "open" : "closed"); break;
        case "logClose": setDock("closed"); break;
        case "logExpand": logExpanded = !logExpanded; applyDock(); break;
        case "logBody": if (phone.matches && !logExpanded) { logBodyOpen = !logBodyOpen; applyDock(); } break;
        case "filter": S.dock.filter = arg; applyDock(); applyFilter(); break;
        case "copyLog": copyText(logText()).then((ok) => { if (ok) flash(el, ""); }); break;
        case "saveLog": {
            const text = logText();
            if (!text) break;
            const link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
            link.download = `rsc-console-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.log`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            break;
        }
        case "clearLog": LOG.length = 0; $("#logList").innerHTML = ""; unread = 0; renderLogHead(); break;
        case "stopAll":
            S.flip.left = 0; S.flip.right = 0;
            ["flip.left", "flip.right"].forEach((k) => syncControls(k, null));
            if (S.cal.holding) { S.cal.holding = false; send("servo.hold.stop", {}, { urgent: true }); updateSlots(); }
            stopping(el);
            afterChange();
            break;
        case "mood": S.face.mood = arg; send("cyd.mood", { value: arg }); afterChange(); break;
        case "blink": send("cyd.blink"); blinkUntil = performance.now() + 220; drawRobot(); setTimeout(() => drawRobot(), 240); break;
        case "moodCycle": send("cyd.mood_cycle"); break;
        case "runTest":
            S.sound.running = true;
            S.sound.error = "";
            updateSlots();
            syncDisabled();
            send("audio.selftest", { seconds: 3, playback: S.sound.playback, normalise: S.sound.normalise }).then((ack) => {
                S.sound.running = false;
                if (ack?.ok && ack.result && typeof ack.result.rms_dbfs === "number") {
                    S.sound.result = { peak: ack.result.peak_dbfs, rms: ack.result.rms_dbfs, clipped: ack.result.clipped_samples || 0 };
                } else {
                    S.sound.error = ack ? `The test failed: ${ack.code || "no levels in the reply"}${ack.message ? `, ${ack.message}` : ""}` : "The test didn't finish: the connection closed.";
                }
                updateSlots();
                syncDisabled();
            });
            break;
        case "stopPlay": send("audio.stop_play"); break;
        case "mixerReset":
            send("audio.mixer.reset").then(() => readMixer()).then(() => { ["mic.boostL", "mic.boostR", "mic.capture"].forEach((k) => syncControls(k, null)); afterChange(); autosave(); });
            break;
        case "calStart":
            S.cal.holding = true;
            send("servo.hold", { id: S.cal.side }).then((ack) => {
                if (ack?.ok && typeof ack.result?.holding_us === "number") { S.cal.us = ack.result.holding_us; syncControls("cal.us", null); }
                else S.cal.holding = false;
                updateSlots();
                afterChange();
            });
            updateSlots();
            afterChange();
            break;
        case "calSave":
            send("servo.calibrate", { id: S.cal.side, null_us: S.cal.us, persist: true }).then((ack) => {
                const n = ack?.ok ? ack.result?.calibration?.null_us : null;
                if (typeof n === "number") { S.cal.stored[S.cal.side] = n; updateSlots(); flash(el, "Saved"); }
            });
            break;
        case "calRelease": S.cal.holding = false; send("servo.hold.stop", { id: S.cal.side }); updateSlots(); afterChange(); break;
        case "calReset":
            send("servo.calibration.reset").then(() => send("servo.calibration")).then((ack) => {
                const c = ack?.ok ? ack.result?.calibration : null;
                if (c) for (const id of ["left", "right"]) if (typeof c[id]?.null_us === "number") S.cal.stored[id] = c[id].null_us;
                updateSlots();
            });
            break;
        case "diag":
            send(arg, arg === "events.history" ? { limit: 20 } : {});
            revealLog();
            break;
        case "customSend": {
            const raw = $("#c-custom-args").value.trim(), err = $('[data-slot="customErr"]');
            let args = {};
            if (raw) {
                try { args = JSON.parse(raw); if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(); }
                catch { err.textContent = 'Arguments must be a JSON object, for example {"id": "right"}.'; err.hidden = false; return; }
            }
            err.hidden = true;
            send($("#c-custom-verb").value, args);
            revealLog();
            break;
        }
        case "reset": RESET[arg]?.(); refreshPanel(); afterChange(); break;
        case "resetAll": openModal("#resetBg", '[data-act="closeReset"]'); break;
        case "resetAllGo":
            Object.values(RESET).forEach((f) => f());
            $("#resetBg").hidden = true;
            refreshPanel();
            afterChange();
            break;
        case "closeReset": $("#resetBg").hidden = true; break;
        case "quickMute": S.sound.muted = !S.sound.muted; send("audio.mute", { muted: S.sound.muted }); syncControls("sound.muted", null); afterChange(); break;
        case "quickMic": S.mic.on = !S.mic.on; send("audio.mic_mute", { muted: !S.mic.on }); syncControls("mic.on", null); afterChange(); break;
        case "presets": setPresetMenu($("#presetPop").hidden); break;
        case "applyPreset": {
            const p = arg === "default" ? { name: "Default", snap: clone(DEFAULTS) } : PRESETS[Number(arg)];
            setPresetMenu(false);
            if (!p) break;
            applySnap(p.snap);
            refreshPanel();
            afterChange();
            flash($("#presetBtn"), p.name);
            break;
        }
        case "savePreset":
            $("#presetName").value = "";
            $("#presetErr").hidden = true;
            openModal("#presetBg", "#presetName");
            break;
        case "closePreset": $("#presetBg").hidden = true; break;
        case "power":
            if (!arg) { openPower(); break; }
            $("#powerBg").hidden = true;
            C.expectClose = arg === "reboot" ? `${S.robot.host} is restarting. It should be back in about a minute.` : `${S.robot.host} is shutting down. Someone has to reach its power supply to start it again.`;
            send("system." + arg, { confirm: true }).then((ack) => {
                if (!ack?.ok || ack.result?.scheduled === false) {
                    C.expectClose = "";
                    log("err", `the robot didn't ${arg === "reboot" ? "restart" : "shut down"}${ack?.result?.reason ? `: ${ack.result.reason}` : ""}`);
                    revealLog();
                }
            });
            break;
        case "closePower": $("#powerBg").hidden = true; break;
        case "disconnect": closeMenu(); disconnect(); break;
        case "sel": select(arg); break;
        case "openChat": stopStream(); endVoice(true); chatId = arg; closeMenu(); renderChat(); break;
        case "newChat": {
            stopStream();
            endVoice(true);
            // Reuse an empty chat instead of piling up blank ones
            const blank = CHATS.find((c) => c.msgs.every((m) => m.role === "intro"));
            const c = blank || newChatObj();
            if (!blank) CHATS.unshift(c);
            c.at = Date.now();
            chatId = c.id;
            saveChats();
            closeMenu();
            renderChat();
            $("#chatInput").focus();
            break;
        }
        case "sugg": sendChat(arg); break;
        case "attach": $("#fileInput").click(); break;
        case "unattach": pending.splice(Number(arg), 1); renderFiles(); break;
        case "voice": voice ? endVoice(false) : startVoice(); break;
    }
}

$("#presetForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#presetName").value.trim();
    if (!name) { $("#presetErr").textContent = "Give the preset a name."; $("#presetErr").hidden = false; $("#presetName").focus(); return; }
    const at = PRESETS.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    const p = { name, snap: snapshot() };
    if (at >= 0) PRESETS[at] = p; else PRESETS.push(p);
    store.set(K.presets, PRESETS);
    $("#presetBg").hidden = true;
    flash($("#presetBtn"), at >= 0 ? `Updated "${name}"` : `Saved "${name}"`);
});

document.addEventListener("click", (e) => {
    if (!e.target.closest(".pop-wrap")) setPresetMenu(false);
    const b = e.target.closest("[data-act]");
    if (b && !b.disabled) { act(b.dataset.act, b); return; }
    const part = e.target.closest(".part");
    if (part) { select(part.dataset.part); return; }
    const le = e.target.closest(".le-btn");
    if (le) {
        const pre = le.nextElementSibling;
        if (pre) { pre.hidden = !pre.hidden; le.setAttribute("aria-expanded", String(!pre.hidden)); }
        return;
    }
    if (e.target.classList.contains("modal-bg")) e.target.hidden = true;
});
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (voice) { endVoice(true); return; }
    if ($("#presetPop") && !$("#presetPop").hidden) { setPresetMenu(false); $("#presetBtn").focus(); return; }
    if (!$("#menu").hidden) { closeMenu(); $("#burger").focus(); return; }
    if (logExpanded) { logExpanded = false; applyDock(); return; }
    $$(".modal-bg").forEach((m) => { m.hidden = true; });
});
phone.addEventListener("change", applyDock);

// ---- Start ----
// rsc.ee/app.html#rsc-shiny or #rsc-shiny:8765 fills in the address, as console.html does.
// The token is never taken from the URL.
if (location.hash.length > 1) {
    const [h, p] = decodeURIComponent(location.hash.slice(1)).split(":");
    if (h) $("#cfHost").value = h.includes(".") || h === "localhost" ? h : `${h}.local`;
    if (p) $("#cfPort").value = p;
    $("#cfHost").dispatchEvent(new Event("input"));
}
applyTheme();
applyDock();
applyFilter();
renderRecent();
go("connect");
})();
