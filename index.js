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
You are generating a tiny, self-contained browser minigame to be embedded in a
roleplay chat as an <iframe>. Output ONLY one HTML code block, nothing else —
no commentary before or after.

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
4. Keep the game simple enough to render and finish in under a couple minutes.
   Clear on-screen instructions. Legible on a dark background — use light text.
5. Do not use localStorage, sessionStorage, or cookies.
6. Avoid JS template literals (backtick strings) anywhere in your script — use
   string concatenation or .join() instead. This is important: your output will
   be extracted from a fenced code block, and a stray backtick inside your own
   JS can break that extraction.

Output the HTML now, in a single \`\`\`html code block.
`.trim();

function extractHtml(text) {
    if (!text) return null;

    // Prefer structural extraction (DOCTYPE/<html>...</html>) over fence-matching.
    // Generated game JS very often contains template literals with backticks
    // (e.g. `Score: ${score}`), and a naive ``` ... ``` regex closes early on
    // the first stray backtick sequence inside the code, truncating the game.
    // This is a known, common failure mode when models wrap HTML/JS in fences
    // (see e.g. the SillyTavern-WeatherPack extension, whose job is literally
    // un-mangling HTML/JS that got clipped by backtick fences).
    const docMatch = text.match(/<!DOCTYPE[\s\S]*?<\/html>/i) || text.match(/<html[\s\S]*?<\/html>/i);
    if (docMatch) return docMatch[0].trim();

    // Fallback: fence-based extraction, only if there's no </html> to anchor on
    // (e.g. the model omitted <html> tags entirely and just gave <style>/<script>).
    const fenced = text.match(/```html\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();

    // Last resort: raw text that looks like markup with no fences at all.
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

function renderGameIntoChat(html) {
    const context = getContext();
    const chatEl = document.getElementById("chat");
    if (!chatEl) {
        toastr?.error?.("AI Minigames: couldn't find #chat to render into.");
        return;
    }

    gameCounter += 1;
    const frameId = `ai-minigame-frame-${gameCounter}`;

    const wrapper = document.createElement("div");
    wrapper.className = "aimg-wrapper";
    wrapper.innerHTML = `
        <div class="aimg-header">
            <span class="aimg-tag">🎮 Minigame</span>
            <span class="aimg-status" data-role="status">in progress…</span>
        </div>
        <iframe id="${frameId}" class="aimg-frame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    `;
    chatEl.appendChild(wrapper);
    wrapper.scrollIntoView({ behavior: "smooth", block: "end" });

    const iframe = wrapper.querySelector(`#${frameId}`);
    iframe.srcdoc = wrapGameHtml(html);

    const listener = (event) => {
        if (!event.data || event.data.__aiMinigame !== true) return;
        if (event.source !== iframe.contentWindow) return;

        window.removeEventListener("message", listener);
        const result = event.data.result || {};
        const statusEl = wrapper.querySelector('[data-role="status"]');
        if (statusEl) statusEl.textContent = `finished — ${result.outcome ?? "done"}`;
        wrapper.classList.add("aimg-finished");

        handleGameResult(result);
    };
    window.addEventListener("message", listener);
}

// ---------------------------------------------------------------------------
// Feeding the result back into the roleplay.
// ---------------------------------------------------------------------------
async function handleGameResult(result) {
    const settings = getSettings();
    const context = getContext();

    const summaryLine = `[Minigame result — outcome: ${result.outcome ?? "unknown"}. ${result.summary ?? ""}]`.trim();

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
        raw = await context.generateQuietPrompt(GAME_CONTRACT_PROMPT(description), false, false);
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

    console.log("[AI Minigames] extracted HTML, length:", html.length, "— rendering now.");
    try {
        renderGameIntoChat(html);
    } catch (e) {
        console.error("[AI Minigames] renderGameIntoChat threw:", e);
        toastr?.error?.("AI Minigames: generated the game but failed to render it. Check console.");
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
