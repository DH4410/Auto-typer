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
  lastError: "",
  safetyPaused: false,
  safetyReason: ""
};

let typingTarget = null;
let typingCheckpoint = null;

installSafetyGuards();

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
    if (state.status === "paused" && state.safetyPaused) {
      const target = activeEditableTarget();
      if (!target) {
        const error = "Safety pause: click the exact place in the Google Doc where typing should continue, then press Resume again.";
        state.lastError = error;
        sendStatus(error);
        sendResponse({ ok: false, error, state: publicState() });
        return false;
      }

      typingTarget = target;
      typingCheckpoint = captureTypingCheckpoint(target);
      state.safetyPaused = false;
      state.safetyReason = "";
      state.lastError = "";
      state.status = "running";
      sendStatus("Running — safety guard re-anchored");
      sendResponse({ ok: true, state: publicState() });
      return false;
    }

    if (state.status === "paused") state.status = "running";
    sendStatus("Running");
    sendResponse({ ok: true, state: publicState() });
    return false;
  }

  if (message.type === MESSAGE.STOP) {
    state.status = "stopped";
    state.taskId += 1;
    state.safetyPaused = false;
    state.safetyReason = "";
    typingTarget = null;
    typingCheckpoint = null;
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
  const text = String(payload.text ?? "").replace(/\r\n?/g, "\n");
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
    lastError: "",
    safetyPaused: false,
    safetyReason: ""
  };

  typingTarget = target;
  typingCheckpoint = captureTypingCheckpoint(target);

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

    if (!validateTypingContext()) {
      await waitWhilePausedOrStopped(taskId);
      if (state.status !== "running" || taskId !== state.taskId) continue;
    }

    const char = nextCharacter(state.text, state.index);
    state.currentChar = char;

    if (shouldMakeTypo(char)) {
      await typeTypoThenCorrect(char, taskId);
    } else {
      await typeCharacter(char);
    }

    state.index += char.length;
    typingCheckpoint = captureTypingCheckpoint(typingTarget);
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
  const target = typingTarget;
  if (!target || !target.isConnected) {
    triggerSafetyPause("The Google Docs typing target changed or was removed.");
    throw safetyAbortError();
  }

  if (char === "\n") {
    dispatchKey(target, "Enter", {
      code: "Enter",
      keyCode: 13,
      charCode: 13,
      shiftKey: false,
      inputType: "insertParagraph",
      data: "\n"
    });
    applyText(target, "\n", "insertParagraph");
    return;
  }

  const keyInfo = keyboardInfoForChar(char);
  dispatchKey(target, char, {
    ...keyInfo,
    inputType: "insertText",
    data: char
  });
  applyText(target, char, "insertText");
}

async function pressBackspace() {
  const target = typingTarget;
  if (!target || !target.isConnected) {
    triggerSafetyPause("The Google Docs typing target changed or was removed.");
    throw safetyAbortError();
  }

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
  const modifierState = {
    shiftKey: Boolean(options.shiftKey),
    ctrlKey: false,
    altKey: false,
    metaKey: false
  };

  const keydownBase = {
    key,
    code: options.code || "",
    keyCode: options.keyCode || 0,
    which: options.keyCode || 0,
    ...modifierState,
    bubbles: true,
    cancelable: true,
    composed: true
  };

  // keydown/keyup use the physical key code, while keypress uses the actual
  // character code. Google Docs relies on this distinction for lowercase
  // letters and shifted punctuation.
  target.dispatchEvent(new KeyboardEvent("keydown", keydownBase));

  if (key === "Enter" || key.length === 1) {
    const charCode = options.charCode ?? (key.length === 1 ? key.charCodeAt(0) : options.keyCode || 0);
    target.dispatchEvent(new KeyboardEvent("keypress", {
      ...keydownBase,
      keyCode: charCode,
      which: charCode,
      charCode
    }));
  }

  if (options.inputType === "insertText" || options.inputType === "insertParagraph") {
    target.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: options.inputType,
      data: options.data
    }));
  }

  target.dispatchEvent(new KeyboardEvent("keyup", keydownBase));
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

function nextCharacter(text, index) {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function keyboardInfoForChar(char) {
  if (/^[a-z]$/.test(char)) {
    return {
      code: `Key${char.toUpperCase()}`,
      keyCode: char.toUpperCase().charCodeAt(0),
      charCode: char.charCodeAt(0),
      shiftKey: false
    };
  }

  if (/^[A-Z]$/.test(char)) {
    return {
      code: `Key${char}`,
      keyCode: char.charCodeAt(0),
      charCode: char.charCodeAt(0),
      shiftKey: true
    };
  }

  if (/^[0-9]$/.test(char)) {
    return {
      code: `Digit${char}`,
      keyCode: char.charCodeAt(0),
      charCode: char.charCodeAt(0),
      shiftKey: false
    };
  }

  if (char === " ") {
    return { code: "Space", keyCode: 32, charCode: 32, shiftKey: false };
  }

  const punctuation = {
    "`": ["Backquote", 192, false],
    "~": ["Backquote", 192, true],
    "-": ["Minus", 189, false],
    "_": ["Minus", 189, true],
    "=": ["Equal", 187, false],
    "+": ["Equal", 187, true],
    "[": ["BracketLeft", 219, false],
    "{": ["BracketLeft", 219, true],
    "]": ["BracketRight", 221, false],
    "}": ["BracketRight", 221, true],
    "\\": ["Backslash", 220, false],
    "|": ["Backslash", 220, true],
    ";": ["Semicolon", 186, false],
    ":": ["Semicolon", 186, true],
    "'": ["Quote", 222, false],
    "\"": ["Quote", 222, true],
    ",": ["Comma", 188, false],
    "<": ["Comma", 188, true],
    ".": ["Period", 190, false],
    ">": ["Period", 190, true],
    "/": ["Slash", 191, false],
    "?": ["Slash", 191, true],
    "!": ["Digit1", 49, true],
    "@": ["Digit2", 50, true],
    "#": ["Digit3", 51, true],
    "$": ["Digit4", 52, true],
    "%": ["Digit5", 53, true],
    "^": ["Digit6", 54, true],
    "&": ["Digit7", 55, true],
    "*": ["Digit8", 56, true],
    "(": ["Digit9", 57, true],
    ")": ["Digit0", 48, true]
  };

  const mapped = punctuation[char];
  if (mapped) {
    return {
      code: mapped[0],
      keyCode: mapped[1],
      charCode: char.charCodeAt(0),
      shiftKey: mapped[2]
    };
  }

  // Non-ASCII text (accented letters, currency symbols, CJK, emoji, etc.)
  // is inserted using its exact InputEvent data.
  return {
    code: "",
    keyCode: char.length === 1 ? char.charCodeAt(0) : 0,
    charCode: char.length === 1 ? char.charCodeAt(0) : 0,
    shiftKey: false
  };
}


function installSafetyGuards() {
  const pauseForUserInteraction = (event) => {
    if (state.status !== "running" || !event.isTrusted) return;
    triggerSafetyPause("You interacted with the document while typing.");
  };

  document.addEventListener("pointerdown", pauseForUserInteraction, true);
  document.addEventListener("mousedown", pauseForUserInteraction, true);
  document.addEventListener("touchstart", pauseForUserInteraction, true);
  document.addEventListener("keydown", pauseForUserInteraction, true);

  document.addEventListener("visibilitychange", () => {
    if (state.status === "running" && document.visibilityState === "hidden") {
      triggerSafetyPause("The Google Docs tab was hidden or changed.");
    }
  });
}

function activeEditableTarget() {
  const active = deepActiveElement(document);
  return isEditable(active) ? active : null;
}

function validateTypingContext() {
  if (state.status !== "running") return false;

  if (!typingTarget || !typingTarget.isConnected) {
    triggerSafetyPause("The Google Docs typing target changed or was removed.");
    return false;
  }

  const active = activeEditableTarget();
  if (active !== typingTarget) {
    triggerSafetyPause("The document cursor or input focus moved.");
    return false;
  }

  if (!checkpointMatches(typingTarget, typingCheckpoint)) {
    triggerSafetyPause("The text or caret immediately before the typing point changed.");
    return false;
  }

  return true;
}

function triggerSafetyPause(reason) {
  if (state.status !== "running") return;

  state.status = "paused";
  state.safetyPaused = true;
  state.safetyReason = reason;
  state.lastError = "";
  sendStatus(`Safety pause: ${reason} Click the intended typing position and press Resume.`);
}

function safetyAbortError() {
  const error = new Error("Safety pause");
  error.name = "AbortError";
  return error;
}

function captureTypingCheckpoint(target) {
  if (!target) return null;

  // Google Docs' hidden text-event textarea is frequently cleared/recycled by
  // Docs itself, so comparing its value causes false alarms. Trusted mouse/key
  // interaction and target identity still protect this case.
  if (target.matches?.("textarea.docs-texteventtarget, textarea.docs-texteventtarget-iframe")) {
    return { kind: "docs-text-event-target" };
  }

  if ("selectionStart" in target && "selectionEnd" in target && typeof target.value === "string") {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    return {
      kind: "text-control",
      start,
      end,
      before: target.value.slice(Math.max(0, start - 80), start)
    };
  }

  if (target.isContentEditable) {
    const selection = target.ownerDocument?.getSelection?.();
    if (!selection || !selection.rangeCount) return { kind: "contenteditable-unreadable" };

    const range = selection.getRangeAt(0);
    if (!target.contains(range.startContainer)) return { kind: "contenteditable-unreadable" };

    try {
      const beforeRange = range.cloneRange();
      beforeRange.selectNodeContents(target);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      return {
        kind: "contenteditable",
        before: beforeRange.toString().slice(-80),
        collapsed: selection.isCollapsed
      };
    } catch {
      return { kind: "contenteditable-unreadable" };
    }
  }

  return { kind: "unreadable" };
}

function checkpointMatches(target, checkpoint) {
  if (!checkpoint) return true;

  if (checkpoint.kind === "docs-text-event-target" || checkpoint.kind === "unreadable" || checkpoint.kind === "contenteditable-unreadable") {
    return true;
  }

  const current = captureTypingCheckpoint(target);
  if (!current || current.kind !== checkpoint.kind) return false;

  if (checkpoint.kind === "text-control") {
    return current.start === checkpoint.start &&
      current.end === checkpoint.end &&
      current.before === checkpoint.before;
  }

  if (checkpoint.kind === "contenteditable") {
    return current.before === checkpoint.before &&
      current.collapsed === checkpoint.collapsed;
  }

  return true;
}

function publicState() {
  return {
    status: state.status,
    index: state.index,
    total: state.text.length,
    currentChar: state.currentChar,
    settings: state.settings,
    lastError: state.lastError,
    safetyPaused: state.safetyPaused,
    safetyReason: state.safetyReason
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
