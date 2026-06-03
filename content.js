const MESSAGE = {
  START: "HDT_START",
  PAUSE: "HDT_PAUSE",
  RESUME: "HDT_RESUME",
  STOP: "HDT_STOP",
  STATUS: "HDT_STATUS",
  GET_STATUS: "HDT_GET_STATUS"
};

const DEFAULT_SETTINGS = {
  wpm: 65,
  randomnessMs: 45,
  errorRate: 2,
  falseStartRate: 1.2
};

const KEY_NEIGHBORS = {
  q: ["w", "a"],
  w: ["q", "e", "a", "s"],
  e: ["w", "r", "s", "d"],
  r: ["e", "t", "d", "f"],
  t: ["r", "y", "f", "g"],
  y: ["t", "u", "g", "h"],
  u: ["y", "i", "h", "j"],
  i: ["u", "o", "j", "k"],
  o: ["i", "p", "k", "l"],
  p: ["o", "l"],
  a: ["q", "w", "s", "z"],
  s: ["w", "e", "a", "d", "z", "x"],
  d: ["e", "r", "s", "f", "x", "c"],
  f: ["r", "t", "d", "g", "c", "v"],
  g: ["t", "y", "f", "h", "v", "b"],
  h: ["y", "u", "g", "j", "b", "n"],
  j: ["u", "i", "h", "k", "n", "m"],
  k: ["i", "o", "j", "l", "m"],
  l: ["o", "p", "k"],
  z: ["a", "s", "x"],
  x: ["z", "s", "d", "c"],
  c: ["x", "d", "f", "v"],
  v: ["c", "f", "g", "b"],
  b: ["v", "g", "h", "n"],
  n: ["b", "h", "j", "m"],
  m: ["n", "j", "k"]
};

let state = {
  text: "",
  index: 0,
  status: "idle",
  currentChar: "",
  settings: { ...DEFAULT_SETTINGS },
  taskId: 0,
  falseStartsUsed: 0,
  falseStartLimit: 2,
  lastError: ""
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === MESSAGE.START) {
    startTyping(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === MESSAGE.PAUSE) {
    if (state.status === "running") state.status = "paused";
    sendStatus("Paused");
    sendResponse({ ok: true, state: publicState() });
    return false;
  }

  if (message.type === MESSAGE.RESUME) {
    if (state.status === "paused") state.status = "running";
    sendStatus("Running");
    sendResponse({ ok: true, state: publicState() });
    return false;
  }

  if (message.type === MESSAGE.STOP) {
    state.status = "stopped";
    state.taskId += 1;
    sendStatus("Stopped");
    sendResponse({ ok: true, state: publicState() });
    return false;
  }

  if (message.type === MESSAGE.GET_STATUS) {
    sendResponse({ ok: true, state: publicState() });
    return false;
  }

  return false;
});

async function startTyping(payload = {}) {
  const text = String(payload.text ?? "");
  if (!text.trim()) {
    state.lastError = "Add text before starting.";
    sendStatus(state.lastError);
    return { ok: false, error: state.lastError, state: publicState() };
  }

  const target = findEditableTarget();
  if (!target) {
    state.lastError = "Focus the insertion point inside Google Docs, then start again.";
    sendStatus(state.lastError);
    return { ok: false, error: state.lastError, state: publicState() };
  }

  state = {
    text,
    index: 0,
    status: "running",
    currentChar: "",
    settings: sanitizeSettings(payload.settings),
    taskId: state.taskId + 1,
    falseStartsUsed: 0,
    falseStartLimit: falseStartLimitFor(text),
    lastError: ""
  };

  sendStatus("Starting");
  runTypingLoop(state.taskId).catch((error) => {
    if (error?.name === "AbortError") return;
    state.status = "error";
    state.lastError = error?.message || "Typing failed.";
    sendStatus(state.lastError);
  });

  return { ok: true, state: publicState() };
}

async function runTypingLoop(taskId) {
  while (state.status !== "stopped" && taskId === state.taskId && state.index < state.text.length) {
    await waitWhilePausedOrStopped(taskId);
    if (state.status !== "running" || taskId !== state.taskId) break;

    const char = state.text[state.index];
    state.currentChar = char;

    if (shouldMakeTypo(char)) {
      await typeTypoThenCorrect(char, taskId);
    } else {
      await typeCharacter(char);
    }

    state.index += 1;
    sendStatus("Running");

    if (shouldDoFalseStart(char)) {
      await typeFalseStartThenDelete(taskId);
    }

    await humanDelayFor(char, taskId);
  }

  if (taskId === state.taskId && state.status !== "stopped") {
    state.status = "completed";
    state.currentChar = "";
    sendStatus("Completed");
  }
}

async function typeTypoThenCorrect(correctChar, taskId) {
  const wrongChar = neighborFor(correctChar);
  if (!wrongChar) {
    await typeCharacter(correctChar);
    return;
  }

  await typeCharacter(wrongChar);
  await controlledSleep(randomBetween(180, 520), taskId);
  await pressBackspace();
  await controlledSleep(randomBetween(140, 420), taskId);
  await typeCharacter(correctChar);
}

async function typeFalseStartThenDelete(taskId) {
  const phrase = nextFalseStartPhrase();
  if (!phrase) return;

  state.falseStartsUsed += 1;

  await controlledSleep(randomBetween(360, 900), taskId);

  for (const char of phrase) {
    await waitWhilePausedOrStopped(taskId);
    state.currentChar = char;
    await typeCharacter(char);
    sendStatus("Revising");
    await humanDelayFor(char, taskId);
  }

  await controlledSleep(randomBetween(700, 1800), taskId);

  for (let i = phrase.length - 1; i >= 0; i -= 1) {
    await waitWhilePausedOrStopped(taskId);
    state.currentChar = "Backspace";
    await pressBackspace();
    sendStatus("Deleting false start");
    await controlledSleep(randomBetween(35, 95), taskId);
  }

  state.currentChar = "";
  await controlledSleep(randomBetween(350, 1000), taskId);
}

function findEditableTarget() {
  focusGoogleDocsEditor();

  const active = deepActiveElement(document);
  if (isEditable(active)) return active;

  const candidates = [
    "textarea.docs-texteventtarget",
    "textarea.docs-texteventtarget-iframe",
    "[contenteditable='true']",
    "[role='textbox']",
    ".kix-appview-editor"
  ];

  for (const selector of candidates) {
    const element = document.querySelector(selector);
    if (isEditable(element) || element?.focus) {
      element.focus({ preventScroll: true });
      const focused = deepActiveElement(document);
      if (isEditable(element)) return element;
      if (isEditable(focused)) return focused;
    }
  }

  for (const frame of document.querySelectorAll("iframe")) {
    try {
      const framedDocument = frame.contentDocument;
      if (!framedDocument) continue;
      const framedActive = deepActiveElement(framedDocument);
      if (isEditable(framedActive)) return framedActive;
      const textTarget = framedDocument.querySelector("textarea, [contenteditable='true'], [role='textbox']");
      if (textTarget) {
        textTarget.focus({ preventScroll: true });
        return textTarget;
      }
    } catch {
      // Cross-origin frames are expected in parts of Google Docs.
    }
  }

  return null;
}

function focusGoogleDocsEditor() {
  const active = deepActiveElement(document);
  if (isEditable(active)) return;

  const editor = document.querySelector(".kix-appview-editor, .kix-canvas-tile-content, [aria-label='Document content']");
  if (!editor) return;

  try {
    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    editor.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    editor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    editor.focus?.({ preventScroll: true });
  } catch {
    editor.focus?.();
  }
}

function deepActiveElement(rootDocument) {
  let active = rootDocument.activeElement;

  while (active?.tagName === "IFRAME") {
    try {
      const nextDocument = active.contentDocument;
      if (!nextDocument?.activeElement || nextDocument.activeElement === active) break;
      active = nextDocument.activeElement;
    } catch {
      break;
    }
  }

  return active;
}

function isEditable(element) {
  if (!element) return false;
  const tag = element.tagName?.toLowerCase();
  return tag === "textarea" || tag === "input" || element.isContentEditable || element.getAttribute?.("role") === "textbox";
}

async function typeCharacter(char) {
  const target = findEditableTarget();
  if (!target) throw new Error("Could not find an editable Google Docs target.");

  if (char === "\n") {
    dispatchKey(target, "Enter", {
      code: "Enter",
      keyCode: 13,
      inputType: "insertParagraph",
      data: "\n"
    });
    applyText(target, "\n", "insertParagraph");
    return;
  }

  dispatchKey(target, char, {
    code: codeForChar(char),
    keyCode: keyCodeForChar(char),
    inputType: "insertText",
    data: char
  });
  applyText(target, char, "insertText");
}

async function pressBackspace() {
  const target = findEditableTarget();
  if (!target) throw new Error("Could not find an editable Google Docs target.");

  dispatchKey(target, "Backspace", {
    code: "Backspace",
    keyCode: 8,
    inputType: "deleteContentBackward",
    data: null
  });

  if ("selectionStart" in target && "selectionEnd" in target && typeof target.value === "string") {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (start !== end) {
      target.setRangeText("", start, end, "end");
    } else if (start > 0) {
      target.setRangeText("", start - 1, start, "end");
    }
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    return;
  }

  document.execCommand?.("delete", false);
  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
}

function dispatchKey(target, key, options) {
  const keyboardBase = {
    key,
    code: options.code,
    keyCode: options.keyCode,
    which: options.keyCode,
    bubbles: true,
    cancelable: true,
    composed: true
  };

  // Browser-created events cannot be truly trusted. Google Docs may ignore some
  // synthetic events, so this sequence is paired with editable-target fallbacks.
  target.dispatchEvent(new KeyboardEvent("keydown", keyboardBase));
  if (key.length === 1 || key === "Enter") {
    target.dispatchEvent(new KeyboardEvent("keypress", keyboardBase));
    target.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: options.inputType,
      data: options.data
    }));
  }
  target.dispatchEvent(new KeyboardEvent("keyup", keyboardBase));
}

function applyText(target, text, inputType) {
  if ("selectionStart" in target && "selectionEnd" in target && typeof target.value === "string") {
    target.setRangeText(text, target.selectionStart, target.selectionEnd, "end");
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text }));
    return;
  }

  if (target.isContentEditable) {
    document.execCommand?.("insertText", false, text);
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text }));
    return;
  }

  document.execCommand?.("insertText", false, text);
  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: text }));
}

function shouldMakeTypo(char) {
  if (!neighborFor(char)) return false;
  return Math.random() < state.settings.errorRate / 100;
}

function neighborFor(char) {
  const lower = char.toLowerCase();
  const neighbors = KEY_NEIGHBORS[lower];
  if (!neighbors?.length) return "";
  const picked = neighbors[Math.floor(Math.random() * neighbors.length)];
  return char === lower ? picked : picked.toUpperCase();
}

function sanitizeSettings(settings = {}) {
  const wpm = Number(settings.wpm);
  const randomnessMs = Number(settings.randomnessMs);
  const errorRate = Number(settings.errorRate);
  const falseStartRate = Number(settings.falseStartRate);

  return {
    wpm: clamp(Number.isFinite(wpm) ? wpm : DEFAULT_SETTINGS.wpm, 20, 140),
    randomnessMs: clamp(Number.isFinite(randomnessMs) ? randomnessMs : DEFAULT_SETTINGS.randomnessMs, 0, 150),
    errorRate: clamp(Number.isFinite(errorRate) ? errorRate : 0, 0, 15),
    falseStartRate: clamp(Number.isFinite(falseStartRate) ? falseStartRate : DEFAULT_SETTINGS.falseStartRate, 0, 5)
  };
}

function falseStartLimitFor(text) {
  if (text.length < 220) return 1;
  if (text.length < 900) return 2;
  return 3;
}

function shouldDoFalseStart(char) {
  if (char !== " ") return false;
  if (state.falseStartsUsed >= state.falseStartLimit) return false;
  if (state.settings.falseStartRate <= 0) return false;
  if (state.index < 24 || state.text.length - state.index < 35) return false;
  if (/[.!?\n]\s*$/.test(state.text.slice(Math.max(0, state.index - 3), state.index + 1))) return false;

  return Math.random() < state.settings.falseStartRate / 100;
}

function nextFalseStartPhrase() {
  const upcoming = state.text.slice(state.index).trimStart();
  const matches = upcoming.match(/[\w'-]+[,.!?;:]?/g);
  if (!matches || matches.length < 2) return "";

  const count = Math.min(matches.length, Math.floor(randomBetween(2, 5)));
  const words = matches.slice(0, count);
  const phrase = `${words.join(" ")} `;

  if (phrase.length > 42 || /[\n\r]/.test(phrase)) return "";
  return phrase;
}

function baseDelayMs() {
  return 60000 / (state.settings.wpm * 5);
}

async function humanDelayFor(char, taskId) {
  let delay = baseDelayMs() + randomBetween(-state.settings.randomnessMs, state.settings.randomnessMs);

  if (char === ",") delay += randomBetween(180, 520);
  if (/[.!?;:]/.test(char)) delay += randomBetween(520, 1300);
  if (char === "\n") delay += randomBetween(900, 2200);
  if (char === " " && Math.random() < 0.04) delay += randomBetween(250, 900);

  await controlledSleep(Math.max(25, delay), taskId);
}

async function waitWhilePausedOrStopped(taskId) {
  while (state.status === "paused" && taskId === state.taskId) {
    await sleep(120);
  }

  if (state.status === "stopped" || taskId !== state.taskId) {
    const error = new Error("Stopped");
    error.name = "AbortError";
    throw error;
  }
}

async function controlledSleep(ms, taskId) {
  const endAt = performance.now() + ms;
  while (performance.now() < endAt) {
    await waitWhilePausedOrStopped(taskId);
    await sleep(Math.min(80, endAt - performance.now()));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function keyCodeForChar(char) {
  if (char === "\n") return 13;
  const upper = char.toUpperCase();
  return upper.length === 1 ? upper.charCodeAt(0) : 0;
}

function codeForChar(char) {
  if (/^[a-z]$/i.test(char)) return `Key${char.toUpperCase()}`;
  if (/^[0-9]$/.test(char)) return `Digit${char}`;
  if (char === " ") return "Space";
  return "";
}

function publicState() {
  return {
    status: state.status,
    index: state.index,
    total: state.text.length,
    currentChar: state.currentChar,
    settings: state.settings,
    lastError: state.lastError
  };
}

function sendStatus(message) {
  chrome.runtime.sendMessage({
    type: MESSAGE.STATUS,
    payload: {
      ...publicState(),
      message
    }
  }).catch(() => {});
}
