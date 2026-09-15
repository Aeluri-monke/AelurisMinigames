// AI Minigames — lets the connected API generate a small self-contained HTML/JS
// minigame on request, renders it sandboxed inside the chat, and feeds the
// result back into the roleplay so the AI narrates off of it.
//
// Only statically importing names confirmed safe against real ST source.
// Everything else (generateQuietPrompt, setExtensionPrompt, slash command
// registration) is accessed dynamically off getContext() / window at runtime,
// with feature checks — so a missing API degrades gracefully instead of
// throwing a SyntaxError that kills the whole file.
import { extension_settings, getContext } from "../../../extensions.js";
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from "../../../../script.js";

const MODULE = "ai_minigames";
const EXT_PROMPT_KEY = "ai_minigames_result";

const defaultSettings = {
    enabled: true,
    insertMode: "system", // "system" | "extension_prompt"
    lastGameDescription: "",
};

function getSettings() {
    if (extension_settings[MODULE] === undefined) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extension_settings[MODULE][key] === undefined) {
            extension_settings[MODULE][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE];
}

// ---------------------------------------------------------------------------
// THE CONTRACT — every generated minigame MUST follow this shape.
// This is what makes "the reading part" easy: we never parse arbitrary game
// state, we just wait for one call to window.onGameComplete(result).
// ---------------------------------------------------------------------------
const GAME_CONTRACT_PROMPT = (description) => `
SYSTEM OVERRIDE — this is a code-generation task, not a roleplay turn. Ignore
the ongoing scene, the character's voice, and any narrative continuation
entirely. Do not write ANY prose, narration, in-character text, info boards,
timestamp/weather headers, or scene-setting formatting before, during, or
after your answer — not even one line of it. Your entire response must be
nothing but the code block below. Starting with anything other than the code
fence is a failure.

You are generating a tiny, self-contained browser minigame to be embedded in a
roleplay chat as an <iframe>. Output ONLY one HTML code block, nothing else —
no commentary before or after, no story text, no character dialogue.

Requirements (all mandatory):
1. The document must be a single, complete, self-contained HTML file: all CSS
   in a <style> tag, all JS in a <script> tag. No external resources, no
   network requests, no imports.
2. The game must visually and mechanically reflect this request: "${description}"
3. When the game reaches ANY end state (win, lose, timeout, etc.), it MUST call:
     window.onGameComplete({
       outcome: "<short string like 'win' | 'lose' | 'partial' | a custom label>",
       summary: "<1-3 sentence plain-English recap of what happened, written so an
                 AI narrator could read it and continue a story from it>",
       details: { /* any extra structured data worth reflecting, optional */ }
     });
   This function is injected by the host page — do not define it yourself, just
   call it exactly once when the game ends.
4. Keep the game SHORT and token-efficient: minimal CSS, compact JS, no
   decorative flourishes. This has to fit in one response alongside your
   token budget — prioritize a working, finishable game over a polished one.
5. Clear on-screen instructions. Legible on a dark background — use light text.
6. Do not use localStorage, sessionStorage, or cookies.
7. Avoid JS template literals (backtick strings) anywhere in your script — use
   string concatenation or .join() instead. This is important: your output will
   be extracted from a fenced code block, and a stray backtick inside your own
   JS can break that extraction.

Begin your response immediately with \`\`\`html — no text before it.
`.trim();

function extractHtml(text) {
    if (!text) return null;

    const candidates = [];

    // Structural: greedy from <!DOCTYPE or <html to the LAST </html>.
    const docMatch = text.match(/<!DOCTYPE[\s\S]*<\/html>/i) || text.match(/<html[\s\S]*<\/html>/i);
    if (docMatch) candidates.push(docMatch[0].trim());

    // Fence-based: greedy to the LAST closing fence, in case the model
    // properly wrapped the whole thing in one ```html ... ``` block.
    const fenceMatch = text.match(/```html\s*([\s\S]*)```/i) || text.match(/```\s*([\s\S]*)```/);
    if (fenceMatch) candidates.push(fenceMatch[1].trim());

    // Neither extraction method is reliable alone — a model can dump real
    // page content AFTER a stray/decoy "</html>"-shaped string, which makes
    // even a greedy structural match latch onto the wrong (short) span. So
    // score candidates instead of trusting the first one: a real game always
    // has a <script> tag, and between valid candidates the longer one is more
    // likely to be the complete document rather than a truncated fragment.
    const withScript = candidates.filter((c) => /<script/i.test(c));
    const pool = withScript.length ? withScript : candidates;
    if (pool.length) {
        pool.sort((a, b) => b.length - a.length);
        const chosen = pool[0];
        if (chosen.length < text.length * 0.3) {
            console.warn(
                "[AI Minigames] extracted HTML is suspiciously short relative to the raw response " +
                `(${chosen.length}/${text.length} chars). Raw response follows for debugging:`,
                text,
            );
        }
        return chosen;
    }

    // Last resort: raw text that looks like markup with no fences/tags matched at all.
    if (text.includes("<html") || text.includes("<!DOCTYPE") || text.includes("<style") || text.includes("<script")) {
        return text.trim();
    }
    return null;
}

// Wrap the model's HTML so we can intercept onGameComplete via postMessage
// without trusting/parsing the game's internals at all.
function wrapGameHtml(rawHtml) {
    const bridge = `
<script>
  window.onGameComplete = function (result) {
    try {
      parent.postMessage({ __aiMinigame: true, result: result }, "*");
    } catch (e) {
      console.error("AI Minigame bridge failed:", e);
    }
  };
</script>
`;
    // Inject the bridge right after <head> if present, else at the very top.
    if (/<head[^>]*>/i.test(rawHtml)) {
        return rawHtml.replace(/<head[^>]*>/i, (m) => m + bridge);
    }
    return bridge + rawHtml;
}

let gameCounter = 0;
// Generated HTML is kept here, keyed by game id, and re-injected into its
// message's DOM every time #chat re-renders (which ST does often — on any
// new message, edit, or swipe, it rebuilds #chat from the message array).
// Anything appended as a loose sibling in #chat, not tied to a real message,
// gets wiped the instant that happens. Attaching to a real message + a
// MutationObserver survives that.
const gameStore = new Map(); // gameId -> { html, result }

function makeGameId() {
    gameCounter += 1;
    return `aimg_${Date.now()}_${gameCounter}`;
}

async function postMinigameMessage(html) {
    const context = getContext();
    const gameId = makeGameId();
    gameStore.set(gameId, { html, result: null });

    if (typeof context.addOneMessage !== "function") {
        toastr?.error?.("AI Minigames: context.addOneMessage unavailable — can't post the game as a message.");
        console.error("[AI Minigames] no addOneMessage on context. Available keys:", Object.keys(context));
        return;
    }

    const messageObj = {
        name: "System",
        is_system: true,
        is_user: false,
        mes: "🎮 Minigame ready — loading below…",
        send_date: Date.now(),
        extra: { aimg_game: gameId },
    };

    try {
        context.addOneMessage(messageObj);
        if (typeof context.saveChat === "function") context.saveChat();
        console.log("[AI Minigames] posted message for game", gameId, "— waiting for #chat to render it.");
        scanForGameMarkersWithRetry(gameId);
    } catch (e) {
        console.error("[AI Minigames] addOneMessage threw:", e);
        toastr?.error?.("AI Minigames: failed to post the minigame message. Check console.");
    }
}

function injectIframeIntoMessage(mesEl, gameId) {
    if (mesEl.querySelector(`[data-aimg-game="${gameId}"]`)) return; // already injected, don't duplicate
    const entry = gameStore.get(gameId);
    if (!entry || !entry.html) return;

    const host = mesEl.querySelector(".mes_text") || mesEl;

    const frameId = `aimg-frame-${gameId}`;
    const wrapper = document.createElement("div");
    wrapper.className = "aimg-wrapper";
    wrapper.dataset.aimgGame = gameId;
    wrapper.innerHTML = `
        <div class="aimg-header">
            <span class="aimg-tag">🎮 Minigame</span>
            <span class="aimg-status" data-role="status">${entry.result ? `finished — ${entry.result.outcome ?? "done"}` : "in progress…"}</span>
        </div>
        <iframe id="${frameId}" class="aimg-frame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    `;
    host.appendChild(wrapper);
    if (entry.result) wrapper.classList.add("aimg-finished");

    const iframe = wrapper.querySelector(`#${frameId}`);
    iframe.srcdoc = wrapGameHtml(entry.html);
    console.log("[AI Minigames] injected iframe for game", gameId);

    if (entry.result) return; // already finished (re-render case) — no need to re-listen

    const listener = (event) => {
        if (!event.data || event.data.__aiMinigame !== true) return;
        if (event.source !== iframe.contentWindow) return;

        window.removeEventListener("message", listener);
        const result = event.data.result || {};
        entry.result = result;

        const statusEl = wrapper.querySelector('[data-role="status"]');
        if (statusEl) statusEl.textContent = `finished — ${result.outcome ?? "done"}`;
        wrapper.classList.add("aimg-finished");

        handleGameResult(result, gameId);
    };
    window.addEventListener("message", listener);
}

function scanForGameMarkers() {
    const context = getContext();
    let found = 0;
    document.querySelectorAll("#chat .mes").forEach((mesEl) => {
        const mesId = mesEl.getAttribute("mesid");
        if (mesId === null) return;
        const chatEntry = context.chat?.[Number(mesId)];
        const gameId = chatEntry?.extra?.aimg_game;
        if (gameId) {
            found += 1;
            injectIframeIntoMessage(mesEl, gameId);
        }
    });
    return found;
}

// addOneMessage's DOM/array update can lag behind the call returning (seen
// as ST's own "Timeout waiting for chat to save" on large chats), so a
// single immediate scan can miss the message. Retry a few times on a short
// delay, and if it's STILL not found, dump diagnostics instead of failing
// silently — this is exactly the kind of thing that otherwise needs another
// screenshot round-trip to debug.
function scanForGameMarkersWithRetry(gameId, attemptsLeft = 6) {
    const found = scanForGameMarkers();
    const entry = gameStore.get(gameId);
    const alreadyInjected = document.querySelector(`[data-aimg-game="${gameId}"]`);
    if (found > 0 || alreadyInjected) return;
    if (attemptsLeft <= 0) {
        const context = getContext();
        console.warn(
            "[AI Minigames] gave up looking for game", gameId, "after retries. Diagnostics:",
            {
                mesElementCount: document.querySelectorAll("#chat .mes").length,
                lastChatEntries: Array.isArray(context.chat) ? context.chat.slice(-3) : context.chat,
                gameStoreHasEntry: !!entry,
            },
        );
        toastr?.warning?.("AI Minigames: posted the message but couldn't find it to attach the game. Check console diagnostics.");
        return;
    }
    setTimeout(() => scanForGameMarkersWithRetry(gameId, attemptsLeft - 1), 300);
}

// Watch for #chat re-renders (new messages, swipes, chat load) and re-inject
// any minigame iframes that got wiped out by them.
const chatObserverEl = document.getElementById("chat");
if (chatObserverEl) {
    const gameObserver = new MutationObserver(() => scanForGameMarkers());
    gameObserver.observe(chatObserverEl, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Feeding the result back into the roleplay.
// ---------------------------------------------------------------------------
async function handleGameResult(result, gameId) {
    const settings = getSettings();
    const context = getContext();

    const summaryLine = `[Minigame result — outcome: ${result.outcome ?? "unknown"}. ${result.summary ?? ""}]`.trim();
    console.log("[AI Minigames] game", gameId, "finished:", result);

    try {
        if (settings.insertMode === "extension_prompt" && typeof context.setExtensionPrompt === "function") {
            // Injects into the prompt for the *next* generation only-ish (depth 0 = just before response).
            // Position 1 = IN_CHAT per ST's extension prompt convention.
            context.setExtensionPrompt(EXT_PROMPT_KEY, summaryLine, 1, 0, false);
            toastr?.info?.("Minigame result queued — send a message to let the AI react.");
        } else if (typeof context.addOneMessage === "function") {
            context.addOneMessage({
                name: "System",
                is_system: true,
                is_user: false,
                mes: summaryLine,
                send_date: Date.now(),
            });
            if (typeof context.saveChat === "function") context.saveChat();
        } else {
            // Last-resort fallback: drop it in the input box so the user can send it themselves.
            const textarea = document.getElementById("send_textarea");
            if (textarea) {
                textarea.value = summaryLine;
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
            }
            toastr?.warning?.("AI Minigames: couldn't auto-inject the result — dropped it in the input box instead.");
        }
    } catch (e) {
        console.error("[AI Minigames] failed to feed result back:", e);
        toastr?.error?.("AI Minigames: failed to feed the result back into chat. Check console.");
    }
}

// ---------------------------------------------------------------------------
// Requesting a minigame from the connected API.
// ---------------------------------------------------------------------------
async function requestMinigame(description) {
    if (!description || !description.trim()) {
        toastr?.warning?.("Describe the minigame you want first, e.g. /minigame a lockpicking puzzle");
        return;
    }
    const context = getContext();
    const settings = getSettings();
    settings.lastGameDescription = description;
    saveSettingsDebounced();

    if (typeof context.generateQuietPrompt !== "function") {
        console.error("[AI Minigames] context.generateQuietPrompt is not a function. Available context keys:", Object.keys(context));
        toastr?.error?.("AI Minigames: this ST version doesn't expose generateQuietPrompt — can't request a game.");
        return;
    }

    console.log("[AI Minigames] requesting generation for:", description);
    toastr?.info?.("Asking the AI to build your minigame…");
    let raw;
    try {
        // Prefer the object-form call — ST logs a deprecation warning for the
        // old positional (prompt, quietToLoud, skipWIAN) signature and may drop
        // it entirely in a future version.
        raw = await context.generateQuietPrompt({
            quietPrompt: GAME_CONTRACT_PROMPT(description),
            quietToLoud: false,
            skipWIAN: true,
        });
    } catch (e) {
        console.error("[AI Minigames] generation call threw:", e);
        toastr?.error?.("AI Minigames: generation failed. Check console.");
        return;
    }

    // generateQuietPrompt's return shape isn't 100% consistent across ST versions —
    // coerce defensively instead of assuming it's always a plain string.
    if (raw && typeof raw === "object") {
        raw = raw.text ?? raw.message ?? raw.content ?? JSON.stringify(raw);
    }
    console.log("[AI Minigames] raw response length:", raw?.length ?? 0);

    const html = extractHtml(String(raw ?? ""));
    if (!html) {
        toastr?.error?.("AI Minigames: the model didn't return usable HTML. Try again or rephrase. See console for the raw response.");
        console.warn("[AI Minigames] extraction failed. Raw response was:", raw);
        return;
    }

    console.log("[AI Minigames] extracted HTML, length:", html.length, "— posting message.");
    try {
        await postMinigameMessage(html);
    } catch (e) {
        console.error("[AI Minigames] postMinigameMessage threw:", e);
        toastr?.error?.("AI Minigames: generated the game but failed to post it. Check console.");
    }
}

// ---------------------------------------------------------------------------
// Settings drawer
// ---------------------------------------------------------------------------
function addExtensionSettings(settings) {
    const settingsContainer = document.getElementById("extensions_settings2");
    if (!settingsContainer) return;

    const inlineDrawer = document.createElement("div");
    inlineDrawer.classList.add("inline-drawer");
    settingsContainer.append(inlineDrawer);

    const inlineDrawerToggle = document.createElement("div");
    inlineDrawerToggle.classList.add("inline-drawer-toggle", "inline-drawer-header");

    const title = document.createElement("b");
    title.textContent = "AI Minigames";

    const inlineDrawerIcon = document.createElement("div");
    inlineDrawerIcon.classList.add("inline-drawer-icon", "fa-solid", "fa-circle-chevron-down", "down");

    inlineDrawerToggle.append(title, inlineDrawerIcon);

    const content = document.createElement("div");
    content.classList.add("inline-drawer-content");
    content.id = "aimg_settings";

    content.innerHTML = `
        <div class="aimg-row">
            <label>
                <input type="checkbox" id="aimg_enabled" ${settings.enabled ? "checked" : ""}/>
                Enabled
            </label>
        </div>
        <div class="aimg-row">
            <label for="aimg_insert_mode">Feed result back as:</label>
            <select id="aimg_insert_mode">
                <option value="system" ${settings.insertMode === "system" ? "selected" : ""}>System message in chat</option>
                <option value="extension_prompt" ${settings.insertMode === "extension_prompt" ? "selected" : ""}>Hidden context injection</option>
            </select>
        </div>
        <div class="aimg-row">
            <input type="text" id="aimg_description" placeholder="Describe a minigame… e.g. a stealth escape past a suspicious NPC" />
            <button id="aimg_generate_btn" class="menu_button">Generate</button>
        </div>
        <div class="aimg-hint">Tip: you can also type <code>/minigame &lt;description&gt;</code> in chat if slash commands are available in your ST build.</div>
    `;

    inlineDrawer.append(inlineDrawerToggle, content);

    content.querySelector("#aimg_enabled").addEventListener("change", (e) => {
        settings.enabled = e.target.checked;
        saveSettingsDebounced();
    });
    content.querySelector("#aimg_insert_mode").addEventListener("change", (e) => {
        settings.insertMode = e.target.value;
        saveSettingsDebounced();
    });
    content.querySelector("#aimg_generate_btn").addEventListener("click", () => {
        const desc = content.querySelector("#aimg_description").value;
        requestMinigame(desc);
    });
}

// ---------------------------------------------------------------------------
// Optional slash command registration — feature-detected, never statically
// imported, so an ST build without this API just skips it silently.
// ---------------------------------------------------------------------------
function tryRegisterSlashCommand() {
    try {
        const context = getContext();
        if (context && typeof context.registerSlashCommand === "function") {
            context.registerSlashCommand(
                "minigame",
                (_args, description) => {
                    requestMinigame(description);
                    return "";
                },
                [],
                "<span class=\"monospace\">(description)</span> — ask the AI to generate a minigame",
                true,
                true,
            );
            console.log("[AI Minigames] /minigame slash command registered.");
        } else {
            console.warn("[AI Minigames] context.registerSlashCommand not available — slash command NOT registered. Use the settings-drawer Generate button instead.");
            toastr?.warning?.("AI Minigames: slash command unavailable in this ST version — use the extension panel's Generate button instead.");
        }
    } catch (e) {
        console.warn("[AI Minigames] slash command registration threw:", e);
    }
}

jQuery(() => {
    try {
        const settings = getSettings();
        addExtensionSettings(settings);
        tryRegisterSlashCommand();

        eventSource.on(event_types.CHAT_CHANGED, () => {
            // Clear any pending hidden injection when the chat changes.
            try {
                const context = getContext();
                if (typeof context.setExtensionPrompt === "function") {
                    context.setExtensionPrompt(EXT_PROMPT_KEY, "", 1, 0, false);
                }
            } catch {}
        });

        console.log("[AI Minigames] loaded.");
    } catch (e) {
        try {
            if (typeof toastr !== "undefined") {
                toastr.error?.("AI Minigames: initialization error — " + e.message, "AI Minigames");
            }
        } catch {}
        console.error("[AI Minigames] init failed:", e);
    }
});
