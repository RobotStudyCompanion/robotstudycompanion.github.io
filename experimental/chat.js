// ---- Chat panel (prototype) ----
//
// A study-companion chat for the console, built on deep-chat
// (https://github.com/OvidijusParsiunas/deep-chat, MIT). The backend is faked:
// every reply comes from sendToRobot() below, which is the only function that
// has to change when the robot can answer for real. Everything else here is
// layout and styling.
//
// Loaded by console.html as a deferred classic script, after the deep-chat
// module. Wrapped in an IIFE so nothing here collides with the console's own
// globals ($, log, send, ws).

(() => {
"use strict";

// ---- Tunables ----

// A small model on a Pi 4 (llama3.2:1b / qwen3:0.6b, see provision-pi.sh)
// manages roughly 3-4 tokens/s, which is 2-3 words/s. The mock paces itself
// to that so the demo feels like the real thing rather than a canned reveal.
const MOCK_THINK_MS = [1000, 2000];      // prompt processing before the first word
const MOCK_WORD_MS = [330, 500];         // per word, i.e. 2-3 words per second

const LAYOUT_KEY = "rsc.chat.layout";    // same prefix as the console's own keys
const LAYOUTS = ["side", "centre"];
const DEFAULT_LAYOUT = "centre";

// ---- The robot ----
//
// sendToRobot(text, { files, history, signal }) -> async iterable of strings
//
// Yields the reply in chunks as they are generated. The handler below does not
// care where the chunks come from, so swapping the mock for the real thing
// touches nothing else in this file.
//
//   text     what the user typed (may be empty when only files were sent)
//   files    File objects the user attached
//   history  earlier turns, [{ role: "user" | "ai", text }], oldest first
//   signal   AbortSignal, fired when the user presses stop
//
// REAL INTEGRATION (rsc-host) ------------------------------------------------
//
// rsc-host has no chat verb yet, and the control channel ("/") is the wrong
// place for one: a cmd gets exactly one ack, and events go to every connected
// client and into the 256-entry history ring. A streamed reply wants its own
// per-connection socket, the same shape as /audio/in:
//
//   Host side, sketch:
//     server.add_path_handler("/chat", handle_chat)
//     handle_chat reads {"text", "history"}, POSTs to Ollama's /api/chat on
//     127.0.0.1:11434 with stream: true and think: false (qwen3 otherwise
//     emits <think> blocks), and forwards each piece as {"delta": "..."}
//     then {"done": true}. The socket closing means stop: cancel the Ollama
//     request so the Pi stops generating.
//
//   Client side, replacing the mock body below:
//     const host = document.getElementById("host").value.trim();
//     const port = document.getElementById("port").value.trim() || "8765";
//     const token = document.getElementById("token").value;
//     const sock = new WebSocket(`ws://${host}:${port}/chat`, ["bearer", token]);
//     signal.addEventListener("abort", () => sock.close());
//     sock.onopen = () => sock.send(JSON.stringify({ text, history }));
//     ...then yield msg.delta for each message until msg.done or close.
//
// Attachments: the models on the robot are text-only, so files would need
// text extraction on the host before they are any use to the model.
// ----------------------------------------------------------------------------

async function* sendToRobot(text, { files = [], history = [], signal } = {}) {
    // MOCK: replace this body with the rsc-host call sketched above.
    const answer = pickMockAnswer(text, files);
    await sleep(randomBetween(...MOCK_THINK_MS), signal);
    // Split on whitespace but keep it, so newlines survive and the markdown
    // (lists, bold, code) renders as it streams in.
    for (const word of answer.match(/\S+\s*/g) || []) {
        yield word;
        await sleep(randomBetween(...MOCK_WORD_MS), signal);
    }
}

// ---- Mock content ----

const MOCK_ANSWERS = {
    explain:
`Sure. **Spaced repetition** means reviewing something just before you would forget it.

1. Learn it today.
2. Review tomorrow, then in 3 days, then in a week.
3. Each successful recall pushes the next review further out.

It works because remembering is what strengthens memory, so each review is short but does real work. Want me to quiz you on something using it?`,

    quiz:
`Quick check. **Which of these is a stable sort?**

- A) Quicksort
- B) Merge sort
- C) Heapsort

Reply with A, B or C. Take your time, I will wait.`,

    answerB:
`**B is right.** Merge sort keeps equal elements in their original order, because when two items tie it always takes the one from the left half first.

Quicksort and heapsort both move elements over long distances, so ties can swap places. Another question?`,

    answerWrong:
`Not quite, the answer is **B, merge sort**. When two items tie it always takes the one from the left half first, so equal elements keep their original order.

Quicksort and heapsort can swap ties. Want another one?`,

    plan:
`Here is a plan for a 90 minute session:

1. **10 min**: skim last lecture's notes and write 3 questions you cannot answer yet.
2. **25 min**: work through those questions. No phone.
3. **5 min**: break. Stand up, drink water.
4. **25 min**: practice problems on the same topic.
5. **15 min**: explain the topic out loud to me, as if I were a first year.
6. **10 min**: write down what is still unclear for next time.

Want me to remind you when each block ends?`,

    summary:
`Paste the text you want summarised, or attach it, and I will give you:

- a **three sentence** summary,
- the **key terms** with one line each,
- **two questions** to check you understood it.

Short inputs work best. I am a small model running on the robot, so long documents take a while.`,

    fallback:
`Good question. I am a small model running on the robot, so I work best with focused questions. I can:

- **explain** a concept step by step,
- **quiz** you on what you are studying,
- make a **study plan** for a session,
- **summarise** your notes.

What are you working on today?`,
};

let fallbackTurn = 0;
let quizOpen = false;   // a quiz question is waiting for A, B or C

function pickMockAnswer(text, files) {
    const t = (text || "").toLowerCase().trim();

    if (files.length) {
        const names = files.map(f => `*${f.name}*`).join(", ");
        return `I can see ${names} (${formatBytes(files.reduce((n, f) => n + f.size, 0))}). `
            + "In this prototype I cannot read files yet. On the real robot the text would be "
            + "extracted first, and then I could summarise it or quiz you on it. "
            + (t ? "In the meantime, here is my answer to your message:\n\n" + pickMockAnswer(text, [])
                 : "What would you like to do with it?");
    }
    // Answering the quiz. Tracked as state rather than read back from the
    // history, because a stopped reply may never have shown the question.
    if (quizOpen && /^\(?[abc]\)?[.!]?$/.test(t)) {
        quizOpen = false;
        return t.replace(/\W/g, "").startsWith("b") ? MOCK_ANSWERS.answerB : MOCK_ANSWERS.answerWrong;
    }
    quizOpen = false;
    if (/quiz|test me|question|ask me/.test(t)) {
        quizOpen = true;
        return MOCK_ANSWERS.quiz;
    }
    if (/explain|what is|what's|how does|why/.test(t)) return MOCK_ANSWERS.explain;
    if (/plan|schedule|study session|pomodoro/.test(t)) return MOCK_ANSWERS.plan;
    if (/summar/.test(t)) return MOCK_ANSWERS.summary;
    // Rotate so repeated free-form messages do not get the same answer.
    const rotation = [MOCK_ANSWERS.fallback, MOCK_ANSWERS.explain, MOCK_ANSWERS.plan];
    return rotation[fallbackTurn++ % rotation.length];
}

// ---- Helpers ----

function randomBetween(lo, hi) {
    return lo + Math.random() * (hi - lo);
}

// setTimeout that rejects as soon as the signal aborts, so stop takes effect
// mid-pause instead of after the next word.
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(signal.reason);
        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(signal.reason);
            }, { once: true });
        }
    });
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// deep-chat hands the handler JSON ({ messages: [...] }) for text, but
// FormData when files are attached: the files under "files", and each message
// as a JSON string under "message1", "message2", ...
function readRequest(body) {
    if (body instanceof FormData) {
        const texts = [];
        for (const [key, value] of body.entries()) {
            if (key.startsWith("message")) {
                try { texts.push(JSON.parse(value).text || ""); } catch {}
            }
        }
        return { text: texts.join("\n").trim(), files: body.getAll("files") };
    }
    const messages = (body && body.messages) || [];
    return { text: messages.map(m => m.text || "").join("\n").trim(), files: [] };
}

// Everything deep-chat has shown so far, minus the intro, as history for the
// model. The last entry is the message being answered, so drop it.
function historyFrom(chat) {
    const all = (chat.getMessages ? chat.getMessages() : [])
        .filter(m => m.role === "user" || m.role === "ai")
        .map(m => ({ role: m.role, text: m.text || "" }));
    return all.slice(0, -1);
}

// Mirror chat turns into the event log, which is where real rsc-host traffic
// will show up once sendToRobot talks to the robot.
function logInfo(text) {
    if (typeof window.log === "function") window.log("info", text);
}

// ---- deep-chat wiring ----

let inFlight = null;   // AbortController of the reply being generated, if any

function makeHandler(chat) {
    return async (body, signals) => {
        const { text, files } = readRequest(body);
        const history = historyFrom(chat);
        const controller = new AbortController();
        signals.stopClicked.listener = () => controller.abort();
        inFlight = controller;   // switching chats aborts it too

        logInfo(`chat: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`
            + (files.length ? ` + ${files.length} file(s)` : "")
            + " → mock reply (not sent to robot)");

        let opened = false;
        try {
            for await (const chunk of sendToRobot(text, { files, history, signal: controller.signal })) {
                // The loading bubble stays up until onOpen, which is exactly
                // the "thinking" phase before the first token.
                if (!opened) { signals.onOpen(); opened = true; }
                await signals.onResponse({ text: chunk });
            }
        } catch (exc) {
            if (!controller.signal.aborted) {
                await signals.onResponse({ error: `robot did not answer: ${exc && exc.message || exc}` });
            }
        } finally {
            signals.onClose();   // idempotent; deep-chat also closes on stop
        }
    };
}

const INTRO_HTML = `
<div class="rsc-intro">
  <b>Hi, I am your study companion.</b><br>
  I run on a small language model <b>locally on the robot</b> (a Raspberry Pi 4),
  so nothing you type leaves the device. That also means I think slowly,
  a few words a second. Try one of these:
  <div class="rsc-suggestions">
    <button class="deep-chat-button deep-chat-suggestion-button">Explain spaced repetition</button>
    <button class="deep-chat-button deep-chat-suggestion-button">Quiz me</button>
    <button class="deep-chat-button deep-chat-suggestion-button">Make a study plan for 90 minutes</button>
  </div>
</div>`;

// Console tokens (:root in console.html). Custom properties inherit into
// deep-chat's shadow DOM, so var(--...) works in its inline styles and the
// chat follows the console if the palette ever changes. The loading-dot colour
// is the one exception: deep-chat converts it to hex itself, so it takes a
// literal (the value of --fg-dim).
const FONT = "system-ui, -apple-system, sans-serif";
const BUBBLE = {
    padding: "8px 12px",
    borderRadius: "6px",
    lineHeight: "1.45",
    fontSize: "14px",
    maxWidth: "85%",
    marginTop: "6px",
};
const AI_BUBBLE = {
    ...BUBBLE,
    backgroundColor: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--panel-hi)",
};
const USER_BUBBLE = {
    ...BUBBLE,
    backgroundColor: "rgba(106, 157, 255, 0.16)",
    color: "var(--fg)",
    border: "1px solid rgba(106, 157, 255, 0.45)",
};
// deep-chat draws its buttons as SVG icons tinted with CSS filters, so the
// console colours are given as filter chains rather than var(--...):
// grey near --fg-dim, near-white for hover, --accent blue and --err red.
const TINT = {
    dim: "brightness(0) invert(0.58)",
    bright: "brightness(0) invert(0.9)",
    faint: "brightness(0) invert(0.3)",
    accent: "brightness(0) saturate(100%) invert(58%) sepia(62%) saturate(2500%) hue-rotate(200deg) brightness(102%) contrast(101%)",
    err: "brightness(0) saturate(100%) invert(66%) sepia(45%) saturate(1400%) hue-rotate(313deg) brightness(103%) contrast(101%)",
};
const iconButton = (tint, hoverTint = TINT.bright) => ({
    container: {
        default: { borderRadius: "6px" },
        hover: { backgroundColor: "var(--panel-hi)" },
        click: { backgroundColor: "var(--panel-hi)" },
    },
    svg: { styles: { default: { filter: tint }, hover: { filter: hoverTint } } },
});
const ICON_BUTTON = iconButton(TINT.dim);

// Shadow-DOM rules the style properties cannot reach: scrollbars, markdown
// output, the intro and the file-attachment previews.
const AUX_STYLE = `
    ::-webkit-scrollbar { width: 9px; height: 9px; }
    ::-webkit-scrollbar-thumb { background-color: var(--panel-hi); border-radius: 5px; }
    ::-webkit-scrollbar-track { background-color: transparent; }
    * { scrollbar-color: var(--panel-hi) transparent; }
    a { color: var(--accent); }
    code, pre { font-family: var(--mono); font-size: 13px; }
    pre { background: var(--bg); border: 1px solid var(--panel-hi); border-radius: 6px; padding: 8px 10px; overflow-x: auto; }
    p { margin: 0 0 6px; }
    p:last-child { margin-bottom: 0; }
    ol, ul { margin: 4px 0 6px; padding-inline-start: 22px; }
    .rsc-intro { line-height: 1.5; }
    .rsc-suggestions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    #dropup-menu { background-color: var(--panel); color: var(--fg); border: 1px solid var(--panel-hi); }
    .dropup-menu-item:hover { background-color: var(--panel-hi); }
    [contenteditable]:empty:before { color: var(--fg-dim); }
    .file-attachment { background-color: var(--panel); border-color: var(--panel-hi); }
    .file-message-text, .file-attachment-text-container { color: var(--fg); }
`;

function configure(chat) {
    chat.connect = { stream: true, handler: makeHandler(chat) };
    chat.introMessage = { html: INTRO_HTML };
    chat.mixedFiles = {
        files: { maxNumberOfFiles: 4 },
        button: { styles: ICON_BUTTON, position: "inside-start", tooltip: true },
    };
    chat.dragAndDrop = {
        backgroundColor: "rgba(106, 157, 255, 0.12)",
        border: "2px dashed var(--accent)",
    };
    chat.names = {
        ai: { text: "RSC", style: { color: "var(--fg-dim)", fontSize: "12px", fontFamily: FONT } },
        user: { text: "you", style: { color: "var(--fg-dim)", fontSize: "12px", fontFamily: FONT } },
    };
    chat.textInput = {
        placeholder: { text: "Ask your study companion…", style: { color: "var(--fg-dim)" } },
        styles: {
            container: {
                backgroundColor: "var(--panel)",
                border: "1px solid var(--panel-hi)",
                borderRadius: "6px",
                boxShadow: "none",
            },
            // Vertical padding only: deep-chat pads the sides to make room
            // for the attach and send buttons inside the box.
            text: { color: "var(--fg)", fontFamily: FONT, fontSize: "14px", paddingTop: "9px", paddingBottom: "9px" },
            focus: { border: "1px solid var(--accent)" },
        },
    };
    chat.submitButtonStyles = {
        submit: iconButton(TINT.accent),
        loading: iconButton(TINT.dim, TINT.dim),
        stop: iconButton(TINT.err, TINT.err),
        disabled: iconButton(TINT.faint, TINT.faint),
        tooltip: true,
    };
    chat.chatStyle = {
        display: "block",
        width: "100%",
        height: "100%",
        border: "none",
        backgroundColor: "transparent",
        color: "var(--fg)",
        fontFamily: FONT,   // also stops deep-chat fetching Inter from Google
        fontSize: "14px",
    };
    chat.inputAreaStyle = {
        backgroundColor: "var(--bg)",
        borderTop: "1px solid var(--panel-hi)",
    };
    chat.attachmentContainerStyle = {
        backgroundColor: "var(--panel)",
        border: "1px solid var(--panel-hi)",
        borderRadius: "6px",
    };
    chat.messageStyles = {
        default: {
            shared: { outerContainer: { padding: "0 16px" } },
            ai: { bubble: AI_BUBBLE },
            user: { bubble: USER_BUBBLE },
        },
        file: { shared: { bubble: { ...USER_BUBBLE, padding: "6px 10px" } } },
        image: { shared: { bubble: { padding: "0", border: "1px solid var(--panel-hi)", borderRadius: "6px" } } },
        intro: { bubble: { ...AI_BUBBLE, maxWidth: "92%", marginTop: "14px" } },
        error: { bubble: { ...BUBBLE, backgroundColor: "rgba(255, 128, 128, 0.15)", color: "var(--err)", border: "1px solid rgba(255, 128, 128, 0.4)" } },
        loading: { message: { styles: { bubble: { ...AI_BUBBLE, color: "#8a8a99", padding: "12px 18px" } } } },
    };
    chat.htmlClassUtilities = {
        "deep-chat-button": {
            styles: {
                default: {
                    backgroundColor: "var(--bg)",
                    color: "var(--fg)",
                    border: "1px solid var(--panel-hi)",
                    borderRadius: "6px",
                    padding: "6px 10px",
                    fontFamily: FONT,
                    fontSize: "13px",
                },
                hover: { backgroundColor: "var(--panel-hi)", borderColor: "var(--accent)" },
                click: { transform: "translateY(1px)" },
            },
        },
    };
    chat.auxiliaryStyle = AUX_STYLE;
}

// ---- Conversations ----
//
// Chats are kept in this browser (localStorage) for the prototype, seeded
// with two examples so the switcher has something to show.
//
// REAL INTEGRATION: history belongs on the robot, next to the model, so any
// console that connects sees the same chats. rsc-host would keep them (for
// example chat.list / chat.get verbs) and sendToRobot would carry the
// conversation id instead of the whole history.

const CHATS_KEY = "rsc.chat.conversations";
const HOUR = 3600e3;
const DAY = 24 * HOUR;

let chats = [];          // [{ id, title, updated, messages }], most recent first
let activeId = null;
let activeChat = null;   // the mounted <deep-chat>
let chatBody = null;     // .chat-body, which holds it

function exampleChats() {
    const now = Date.now();
    return [
        { id: "example-quiz", title: "Sorting algorithms quiz", updated: now - DAY - 2 * HOUR, messages: [
            { role: "user", text: "Quiz me on sorting algorithms" },
            { role: "ai", text: MOCK_ANSWERS.quiz },
            { role: "user", text: "B" },
            { role: "ai", text: MOCK_ANSWERS.answerB },
        ] },
        { id: "example-plan", title: "Exam week plan", updated: now - 3 * DAY, messages: [
            { role: "user", text: "Make a study plan for 90 minutes" },
            { role: "ai", text: MOCK_ANSWERS.plan },
        ] },
    ];
}

function newChat() {
    return { id: "c" + Date.now().toString(36), title: "New chat", updated: Date.now(), messages: [] };
}

function loadChats() {
    try {
        const saved = JSON.parse(localStorage.getItem(CHATS_KEY) || "null");
        if (Array.isArray(saved) && saved.length) return saved;
    } catch {}
    return exampleChats();
}

// Attachments are stored by name only: one photo as a data: URL can use up
// the whole storage quota.
function saveChats() {
    const slim = chats.map(c => ({
        ...c,
        messages: c.messages.map(m => m.files
            ? { ...m, files: m.files.map(f => ({ name: f.name, type: f.type })) }
            : m),
    }));
    try { localStorage.setItem(CHATS_KEY, JSON.stringify(slim)); } catch {}
}

function activeConversation() {
    return chats.find(c => c.id === activeId);
}

function messagesOf(chat) {
    return (chat.getMessages ? chat.getMessages() : [])
        .filter(m => m.role === "user" || m.role === "ai")
        .map(({ role, text, html, files }) => ({ role, text, html, files }));
}

function titleFrom(messages) {
    const first = messages.find(m => m.role === "user");
    if (!first) return "New chat";
    const text = (first.text || "").trim() || (first.files && first.files[0] && first.files[0].name) || "New chat";
    return text.length > 40 ? text.slice(0, 39) + "…" : text;
}

function recordMessages(chat, conv) {
    conv.messages = messagesOf(chat);
    if (conv.title === "New chat") conv.title = titleFrom(conv.messages);
    conv.updated = Date.now();
    chats = [conv, ...chats.filter(c => c !== conv)];
    saveChats();
    renderSwitcher();
}

function openChat(id) {
    if (inFlight) inFlight.abort();
    const current = activeConversation();
    if (activeChat && current) current.messages = messagesOf(activeChat);

    activeId = id;
    quizOpen = false;
    const conv = activeConversation();
    const chat = document.createElement("deep-chat");
    configure(chat);
    if (conv.messages.length) chat.history = conv.messages;
    chat.onMessage = ({ isHistory }) => { if (!isHistory) recordMessages(chat, conv); };
    chatBody.replaceChildren(chat);
    activeChat = chat;
    renderSwitcher();
}

// Reuses an empty chat rather than stacking up "New chat" entries.
function startNewChat() {
    let conv = chats.find(c => !c.messages.length);
    if (!conv) {
        conv = newChat();
        chats.unshift(conv);
    }
    openChat(conv.id);
    closeChatList();
}

function when(ts) {
    const ago = Date.now() - ts;
    if (ago < 60e3) return "just now";
    if (ago < HOUR) return `${Math.round(ago / 60e3)} min ago`;
    const d = new Date(ts);
    if (d.toDateString() === new Date().toDateString()) {
        return "today " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (d.toDateString() === new Date(Date.now() - DAY).toDateString()) return "yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

// ---- Chat switcher (chat header) ----

let switchButton = null;
let chatList = null;

function renderSwitcher() {
    const conv = activeConversation();
    if (!switchButton || !conv) return;
    switchButton.querySelector(".chat-switch-title").textContent = conv.title;

    const rows = [
        el("button", { type: "button", class: "chat-list-item chat-list-new", "data-new-chat": "" }, [
            el("span", { class: "chat-list-title", text: "+ New chat" }),
        ]),
        ...chats.filter(c => c.messages.length || c.id === activeId).map(c => {
            const count = c.messages.length;
            return el("button", {
                type: "button",
                class: "chat-list-item",
                "data-chat-id": c.id,
                "aria-current": String(c.id === activeId),
            }, [
                el("span", { class: "chat-list-title", text: c.title }),
                el("span", { class: "chat-list-meta", text: count ? `${count} message${count === 1 ? "" : "s"} · ${when(c.updated)}` : "empty" }),
            ]);
        }),
    ];
    chatList.replaceChildren(...rows);
}

function openChatList() {
    renderSwitcher();   // refresh the "12 min ago" stamps
    chatList.hidden = false;
    switchButton.setAttribute("aria-expanded", "true");
}

function closeChatList() {
    if (!chatList) return;
    chatList.hidden = true;
    switchButton.setAttribute("aria-expanded", "false");
}

function buildSwitcher() {
    switchButton = el("button", {
        type: "button",
        class: "chat-switch",
        "aria-haspopup": "true",
        "aria-expanded": "false",
        title: "Switch chat",
    }, [
        el("span", { class: "chat-switch-title", text: "chat" }),
        el("span", { class: "chat-switch-caret", "aria-hidden": "true", text: "▾" }),
    ]);
    chatList = el("div", { class: "chat-list", role: "menu", "aria-label": "Chats" });
    chatList.hidden = true;

    switchButton.addEventListener("click", () => (chatList.hidden ? openChatList() : closeChatList()));
    chatList.addEventListener("click", (e) => {
        const item = e.target.closest(".chat-list-item");
        if (!item) return;
        if (item.hasAttribute("data-new-chat")) return startNewChat();
        if (item.dataset.chatId !== activeId) openChat(item.dataset.chatId);
        closeChatList();
    });
    document.addEventListener("click", (e) => {
        if (!chatList.hidden && !e.target.closest(".chat-list, .chat-switch")) closeChatList();
    });
    return [switchButton, chatList];
}

// ---- Layout ----
//
// Two layouts behind a header toggle:
//   side    controls | chat | log   (the console as it is, plus a chat column)
//   centre  chat | log              (chat is the main view; the controls open
//                                    as a drawer from the burger, top left)
// On a phone there is one bar, the chat's own: burger, chat switcher, new
// chat, log. The burger opens a side sheet holding the connection fields and,
// in centre, the controls, all scrolling together. In side the controls stay
// on the page with the chat docked beneath them. "log" swaps the chat area
// for the event log.
//
// On a phone the header and the controls are moved into the side sheet and
// moved back when the window widens. Moving keeps their ids and listeners, so
// the console's own code does not notice. chat.css does the rest off
// body[data-chat-layout] and the drawer classes (drawer-menu, drawer-log).
// ?layout=side or ?layout=centre picks one explicitly, for a direct link. The
// URL hash stays with the console, which uses it to prefill the hostname.

const DRAWERS = ["menu", "log"];
const phoneQuery = window.matchMedia("(max-width: 760px)");
const narrowQuery = window.matchMedia("(max-width: 1100px)");

let drawer = null;   // phone side sheet: { root, connection, controls }
const homes = new Map();   // moved element -> comment marking where it lives

function readLayout() {
    const fromUrl = new URLSearchParams(location.search).get("layout");
    if (LAYOUTS.includes(fromUrl)) return fromUrl;
    try {
        const saved = localStorage.getItem(LAYOUT_KEY);
        if (LAYOUTS.includes(saved)) return saved;
    } catch {}
    return DEFAULT_LAYOUT;
}

function setLayout(layout) {
    document.body.dataset.chatLayout = layout;
    closeDrawers();
    document.querySelectorAll(".chat-layout-toggle button").forEach(b => {
        b.setAttribute("aria-pressed", String(b.dataset.layout === layout));
    });
    try { localStorage.setItem(LAYOUT_KEY, layout); } catch {}
    placeElements();
}

function toggleDrawer(name) {
    const wasOpen = document.body.classList.contains(`drawer-${name}`);
    closeDrawers();
    if (!wasOpen) {
        document.body.classList.add(`drawer-${name}`);
        if (name === "log") markLogRead();
    }
    syncDrawerButtons();
}

function closeDrawers() {
    DRAWERS.forEach(n => document.body.classList.remove(`drawer-${n}`));
    syncDrawerButtons();
}

function syncDrawerButtons() {
    document.querySelectorAll("[data-drawer]").forEach(b => {
        b.setAttribute("aria-expanded",
            String(document.body.classList.contains(`drawer-${b.dataset.drawer}`)));
    });
}

function rememberHome(node) {
    const mark = document.createComment(` home of ${node.tagName.toLowerCase()}${node.className ? "." + node.className : ""} `);
    node.before(mark);
    homes.set(node, mark);
}

function sendHome(node) {
    const mark = homes.get(node);
    if (mark && mark.nextSibling !== node) mark.after(node);
}

function placeElements() {
    if (!drawer) return;
    const header = document.querySelector("header");
    const controls = document.querySelector(".controls");
    if (phoneQuery.matches) {
        drawer.connection.append(header);
        if (document.body.dataset.chatLayout === "centre") drawer.controls.append(controls);
        else sendHome(controls);
    } else {
        sendHome(header);
        sendHome(controls);
    }
    requestAnimationFrame(updateOffsets);
}

// Drawers are fixed-position, so they need to know where the header (desktop)
// or the chat bar (phone) ends in viewport terms. Measured rather than
// assumed: the page may sit below an app's own bar.
function updateOffsets() {
    const style = document.body.style;
    const header = document.querySelector("header");
    const bar = document.querySelector(".chat-head");
    if (header && !phoneQuery.matches) {
        style.setProperty("--chat-top", `${Math.round(header.getBoundingClientRect().bottom)}px`);
    }
    if (bar) style.setProperty("--chat-bar-bottom", `${Math.round(bar.getBoundingClientRect().bottom)}px`);
}

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "text") node.textContent = v;
        else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
}

function burger(attrs, extra = []) {
    return el("button", { type: "button", class: "chat-burger", "data-drawer": "menu", ...attrs },
        [el("span"), el("span"), el("span"), ...extra]);
}

function buildHeaderExtras() {
    const header = document.querySelector("header");
    const controls = document.querySelector(".controls");
    controls.id = controls.id || "controls";

    // Desktop centre layout: opens the controls drawer.
    header.prepend(burger({ "aria-controls": "controls", "aria-label": "Robot controls", title: "Robot controls" }));

    const toggle = el("span", { class: "chat-layout-toggle", role: "group", "aria-label": "Layout" }, [
        el("button", { type: "button", "data-layout": "side", title: "Chat as a panel next to the controls", text: "panel" }),
        el("button", { type: "button", "data-layout": "centre", title: "Chat as the main view, controls behind the menu", text: "centre" }),
    ]);
    toggle.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-layout]");
        if (btn) setLayout(btn.dataset.layout);
    });
    header.append(toggle);
}

function buildChatColumn() {
    const head = el("div", { class: "chat-head" }, [
        // Phone only: the one bar on screen, so it also carries the robot's
        // connection state as a dot.
        burger({ class: "chat-burger chat-head-burger", "aria-controls": "chat-drawer", "aria-label": "Menu: connection and robot controls" },
            [el("span", { class: "chat-status-dot", "aria-hidden": "true" })]),
        ...buildSwitcher(),
        el("button", { type: "button", class: "chat-head-btn chat-new", title: "New chat", "aria-label": "New chat", text: "+" }),
        el("span", { class: "chat-badge", title: "Replies come from a mock in chat.js, not the robot", text: "mock backend · local model" }),
        el("span", { class: "chat-head-actions" }, [
            el("button", { type: "button", class: "chat-head-btn chat-log-btn", "data-drawer": "log", "aria-controls": "log", text: "log" }),
        ]),
    ]);
    head.querySelector(".chat-new").addEventListener("click", startNewChat);

    chatBody = el("div", { class: "chat-body" }, [
        el("p", { class: "chat-pending", text: "loading chat component…" }),
    ]);
    const column = el("section", { class: "chat", id: "chat", "aria-label": "Chat with the robot" }, [head, chatBody]);
    document.body.insertBefore(column, document.querySelector(".controls"));
}

function buildDrawer() {
    const root = el("aside", { class: "chat-drawer", id: "chat-drawer", "aria-label": "Connection and robot controls" }, [
        el("div", { class: "chat-drawer-head" }, [
            el("span", { class: "chat-drawer-title", text: "rsc console" }),
            el("span", { class: "chat-badge", text: "mock chat backend" }),
            el("button", { type: "button", class: "chat-head-btn chat-drawer-close", "data-drawer": "menu", "aria-label": "Close menu", text: "✕" }),
        ]),
    ]);
    const connection = el("div", { class: "chat-drawer-connection" });
    const controls = el("div", { class: "chat-drawer-controls" });
    root.append(connection, controls);

    const scrim = el("div", { class: "chat-scrim", "aria-hidden": "true" });
    scrim.addEventListener("click", closeDrawers);
    document.body.append(scrim, root);

    rememberHome(document.querySelector("header"));
    rememberHome(document.querySelector(".controls"));
    drawer = { root, connection, controls };
}

function wireEvents() {
    document.body.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-drawer]");
        if (btn) toggleDrawer(btn.dataset.drawer);
    });
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        closeChatList();
        closeDrawers();
    });
    // A drawer left open across a breakpoint would leave the scrim over a
    // layout that no longer has that drawer.
    phoneQuery.addEventListener("change", () => { closeDrawers(); placeElements(); });
    narrowQuery.addEventListener("change", closeDrawers);

    window.addEventListener("resize", updateOffsets);
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(updateOffsets);
        ro.observe(document.body);
        ro.observe(document.querySelector("header"));
        ro.observe(document.querySelector(".chat-head"));
    }
}

// The phone bar shows the robot's connection state as a dot on the burger,
// taken from the console's own status pill.
function mirrorRobotStatus() {
    const pill = document.getElementById("status");
    const sync = () => {
        const state = ["connected", "connecting", "disconnected"].find(s => pill.classList.contains(s));
        document.body.dataset.robot = state || "disconnected";
    };
    sync();
    new MutationObserver(sync).observe(pill, { attributes: true, attributeFilter: ["class"] });
}

// When the log is tucked away, a dot on its button says something new
// arrived, so a command's result is never silently out of sight.
function watchLog() {
    const logEl = document.getElementById("log");
    new MutationObserver(() => {
        if (narrowQuery.matches && !document.body.classList.contains("drawer-log")) {
            document.querySelectorAll(".chat-log-btn").forEach(b => b.setAttribute("data-unread", ""));
        }
    }).observe(logEl, { childList: true });
}

function markLogRead() {
    document.querySelectorAll(".chat-log-btn").forEach(b => b.removeAttribute("data-unread"));
}

// deep-chat comes from a CDN. If that never arrives (offline robot LAN, CDN
// down) say so in the column instead of leaving it blank.
async function waitForDeepChat() {
    const defined = customElements.whenDefined("deep-chat");
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("deep-chat did not load from the CDN (offline?)")), 10000));
    try {
        await Promise.race([defined, timeout]);
    } catch (exc) {
        chatBody.querySelector(".chat-pending").textContent = exc.message;
        throw exc;
    }
}

async function init() {
    buildHeaderExtras();
    buildChatColumn();
    buildDrawer();
    wireEvents();
    mirrorRobotStatus();
    watchLog();
    setLayout(readLayout());

    // deep-chat's properties only take effect once the element is defined,
    // so mount it after the module has registered it.
    await waitForDeepChat();
    chats = loadChats();
    let fresh = chats.find(c => !c.messages.length);
    if (!fresh) fresh = newChat();
    chats = [fresh, ...chats.filter(c => c !== fresh)];
    openChat(fresh.id);
}

init().catch((exc) => {
    console.error("chat prototype failed to start", exc);
    logInfo(`chat prototype failed to start: ${exc.message}`);
});
})();
