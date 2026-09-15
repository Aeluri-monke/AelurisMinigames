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
timestamp/weather headers, status cards, or scene-setting formatting before,
during, or after your answer — not even one line of it, not even a fenced
block labeled "mb" or anything else. Your entire response must be nothing but
the code block below and absolutely nothing else. If you notice yourself
starting to write a story, a scene, or a character voice, stop and discard
it — that is not what this task is.

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
    const fenceMatch = text.match(/```html\s*([\s\S]*)```/i);
    if (fenceMatch) candidates.push(fenceMatch[1].trim());
    // A generic, unlabeled ``` fence is deliberately NOT tried as a fallback
    // here — a roleplay response can easily contain some other unrelated
    // fenced block (a status card, a time/weather readout, etc.), and a
    // short unrelated fence being mistaken for "the game" is worse than
    // just failing loudly and asking the model to try again.

    // A real game always has a <script> tag. If nothing we found has one,
    // this wasn't a game at all — likely the model ignored the contract and
    // wrote roleplay/narrative text instead. Don't settle for a plausible-
    // looking fragment; refuse so the caller can retry instead of posting
    // broken or unrelated content into the chat.
    const withScript = candidates.filter((c) => /<script/i.test(c));
    if (!withScript.length) return null;

    withScript.sort((a, b) => b.length - a.length);
    return withScript[0];
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
    if (mesEl.querySelector(`[data-aimg-game="${gameId}"]`)) {
        return; // already injected — this one's fine to stay silent, it's the normal re-render case
    }
    const entry = gameStore.get(gameId);
    if (!entry || !entry.html) {
        console.warn("[AI Minigames] injectIframeIntoMessage: no stored entry/html for game", gameId, "— gameStore has keys:", Array.from(gameStore.keys()));
        return;
    }

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
    let mesElCount = 0;
    let markedCount = 0;
    document.querySelectorAll("#chat .mes").forEach((mesEl) => {
        mesElCount += 1;
        const mesId = mesEl.getAttribute("mesid");
        if (mesId === null) return;
        const chatEntry = context.chat?.[Number(mesId)];
        const gameId = chatEntry?.extra?.aimg_game;
        if (gameId) {
            markedCount += 1;
            found += 1;
            injectIframeIntoMessage(mesEl, gameId);
        }
    });
    console.log(`[AI Minigames] scanForGameMarkers: scanned ${mesElCount} .mes elements, ${markedCount} carried an aimg_game marker.`);
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
// Function-tool registration — the real fix. Instead of asking the model to
// output a fenced code block in free text (which roleplay narrative, decoy
// tags, and fence-breakout backticks have all broken in different ways
// tonight), register a proper JSON-schema tool. When the model calls it,
// the html arrives as a clean, structured argument — no text-mining at all.
// Per ST's docs, tool calls only fire on NORMAL generations, never on
// "quiet"/background ones, so this only works by nudging the model during
// an actual visible turn (see queueMinigameToolRequest below).
// ---------------------------------------------------------------------------
const TOOL_NAME = "submit_minigame";
let toolRegistered = false;

function minigameToolDescription() {
    return "Submit a self-contained HTML/CSS/JS minigame to be embedded in the roleplay chat as an interactive game. Call this whenever the user has requested a minigame (e.g. via /minigame) or the scene calls for one. The html argument must be a single complete HTML document with all CSS in a <style> tag and all JS in a <script> tag, no external resources. The game's own script must call window.onGameComplete({outcome, summary, details}) exactly once when it ends — that function is injected automatically by the host, do not define it yourself.";
}

function minigameToolParameters() {
    return {
        $schema: "http://json-schema.org/draft-04/schema#",
        type: "object",
        properties: {
            html: {
                type: "string",
                description: "A complete, self-contained HTML document (<!DOCTYPE html>, <html>, <head><style>...</style></head>, <body>...<script>...</script></body>) implementing the requested minigame. No localStorage/sessionStorage/cookies, no external resources. Its script must call window.onGameComplete({outcome, summary, details}) exactly once when the game ends.",
            },
        },
        required: ["html"],
    };
}

function registerMinigameTool() {
    try {
        const context = getContext();
        if (typeof context.registerFunctionTool !== "function") {
            console.warn("[AI Minigames] registerFunctionTool unavailable — tool-calling path disabled, text-extraction fallback only.");
            return;
        }
        context.registerFunctionTool({
            name: TOOL_NAME,
            displayName: "Submit Minigame",
            description: minigameToolDescription(),
            parameters: minigameToolParameters(),
            action: async ({ html }) => {
                console.log("[AI Minigames] tool call received, html length:", html?.length ?? 0);
                if (!html || !/<script/i.test(html)) {
                    console.warn("[AI Minigames] tool call html missing a <script> tag — rejecting.");
                    return "Error: html must be a complete document containing a <script> tag with the game logic. Please retry the tool call with valid html.";
                }
                await postMinigameMessage(html);
                return "Minigame embedded in chat successfully.";
            },
        });
        toolRegistered = true;
        console.log("[AI Minigames] submit_minigame function tool registered.");
    } catch (e) {
        console.warn("[AI Minigames] registerFunctionTool threw:", e);
    }
}

function toolCallingReady() {
    if (!toolRegistered) return false;
    try {
        const context = getContext();
        if (typeof context.isToolCallingSupported === "function" && !context.isToolCallingSupported()) return false;
        if (typeof context.canPerformToolCalls === "function" && !context.canPerformToolCalls("normal")) return false;
        return true;
    } catch (e) {
        return false;
    }
}

const TOOL_NUDGE_KEY = "ai_minigames_tool_nudge";

function toolNudgePrompt(description) {
    return `[SYSTEM: The user has requested an embedded minigame via /minigame. In this reply, call the ${TOOL_NAME} tool with a complete, working self-contained HTML/CSS/JS minigame matching this request: "${description}". You may narrate normally alongside it, but you MUST actually call the tool — describing the game in prose instead of calling it does not satisfy this request.]`;
}

// ---------------------------------------------------------------------------
// Requesting a minigame from the connected API.
// ---------------------------------------------------------------------------
async function requestMinigame(description, { triggerGeneration } = {}) {
    if (!description || !description.trim()) {
        toastr?.warning?.("Describe the minigame you want first, e.g. /minigame a lockpicking puzzle");
        return;
    }
    const context = getContext();
    const settings = getSettings();
    settings.lastGameDescription = description;
    saveSettingsDebounced();

    if (toolCallingReady() && typeof context.setExtensionPrompt === "function") {
        console.log("[AI Minigames] using function-tool path for this request.");
        context.setExtensionPrompt(TOOL_NUDGE_KEY, toolNudgePrompt(description), 1, 0, false);
        toastr?.info?.("Asking the AI to build your minigame…");
        if (triggerGeneration && typeof context.generate === "function") {
            // Only the settings-drawer button needs this: a slash command is
            // already running inside ST's own normal Generate call, which
            // will naturally pick up the nudge right after the command
            // finishes — calling generate() again there would be re-entrant.
            try {
                await context.generate();
            } catch (e) {
                console.warn("[AI Minigames] context.generate() threw:", e);
            }
        } else if (triggerGeneration) {
            toastr?.info?.("Now send any message to let the AI build the game.");
        }
        return;
    }

    console.log("[AI Minigames] tool-calling unavailable — falling back to text-extraction path.");
    if (typeof context.generateQuietPrompt !== "function" && typeof context.generateRaw !== "function") {
        console.error("[AI Minigames] neither generateRaw nor generateQuietPrompt available. Context keys:", Object.keys(context));
        toastr?.error?.("AI Minigames: this ST version doesn't expose a generation API this extension can use.");
        return;
    }

    console.log("[AI Minigames] requesting generation for:", description);
    toastr?.info?.("Asking the AI to build your minigame…");
    let raw;
    try {
        if (typeof context.generateRaw === "function") {
            console.log("[AI Minigames] using generateRaw for isolation.");
            try {
                raw = await context.generateRaw({
                    prompt: GAME_CONTRACT_PROMPT(description),
                    systemPrompt: GAME_CONTRACT_PROMPT(description),
                });
            } catch (rawError) {
                console.warn("[AI Minigames] generateRaw threw, falling back to generateQuietPrompt:", rawError);
                raw = null;
            }
            if (!raw) {
                raw = await context.generateQuietPrompt({
                    quietPrompt: GAME_CONTRACT_PROMPT(description),
                    quietToLoud: false,
                    skipWIAN: true,
                });
            }
        } else {
            console.log("[AI Minigames] generateRaw unavailable — falling back to generateQuietPrompt (full chat context included).");
            raw = await context.generateQuietPrompt({
                quietPrompt: GAME_CONTRACT_PROMPT(description),
                quietToLoud: false,
                skipWIAN: true,
            });
        }
    } catch (e) {
        console.error("[AI Minigames] generation call threw:", e);
        toastr?.error?.("AI Minigames: generation failed. Check console.");
        return;
    }

    // generateQuietPrompt/generateRaw's return shape isn't 100% consistent across ST versions —
    // coerce defensively instead of assuming it's always a plain string.
    if (raw && typeof raw === "object") {
        raw = raw.text ?? raw.message ?? raw.content ?? JSON.stringify(raw);
    }
    console.log("[AI Minigames] raw response length:", raw?.length ?? 0);

    const html = extractHtml(String(raw ?? ""));
    if (!html) {
        toastr?.error?.("AI Minigames: the model responded with roleplay/text instead of a working game. Try again — see console for the raw response.");
        console.warn("[AI Minigames] no valid game HTML found. Raw response:", raw);
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
        requestMinigame(desc, { triggerGeneration: true });
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
                    requestMinigame(description, { triggerGeneration: false });
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
        registerMinigameTool();

        eventSource.on(event_types.CHAT_CHANGED, () => {
            // Clear any pending hidden injection when the chat changes.
            try {
                const context = getContext();
                if (typeof context.setExtensionPrompt === "function") {
                    context.setExtensionPrompt(EXT_PROMPT_KEY, "", 1, 0, false);
                    context.setExtensionPrompt(TOOL_NUDGE_KEY, "", 1, 0, false);
                }
            } catch {}
        });

        eventSource.on(event_types.GENERATION_ENDED, () => {
            // The tool nudge is one-shot — clear it after every generation so
            // it doesn't bleed into unrelated future turns.
            try {
                const context = getContext();
                if (typeof context.setExtensionPrompt === "function") {
                    context.setExtensionPrompt(TOOL_NUDGE_KEY, "", 1, 0, false);
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
