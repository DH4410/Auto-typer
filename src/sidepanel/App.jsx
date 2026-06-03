import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./App.module.css";

const DEFAULT_SETTINGS = {
  wpm: 65,
  randomnessMs: 45,
  errorRate: 2,
  falseStartRate: 1.2,
  handsFreeControls: true
};

const EMPTY_STATUS = {
  status: "idle",
  index: 0,
  total: 0,
  currentChar: "",
  message: "Ready",
  lastError: ""
};

export default function App() {
  const [text, setText] = useState("");
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [typingStatus, setTypingStatus] = useState(EMPTY_STATUS);
  const [sessionTabId, setSessionTabId] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState("");

  const wordCount = useMemo(() => {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [text]);

  const progress = typingStatus.total
    ? Math.min(100, Math.round((typingStatus.index / typingStatus.total) * 100))
    : 0;

  const isRunning = typingStatus.status === "running";
  const isPaused = typingStatus.status === "paused";
  const canStart = text.trim().length > 0 && !isRunning && !isPaused;
  const estimate = useMemo(() => {
    const sourceText = typingStatus.status === "running" || typingStatus.status === "paused"
      ? text.slice(Math.min(typingStatus.index, text.length))
      : text;
    const totalMs = estimateTypingDurationMs(text, settings);
    const remainingMs = estimateTypingDurationMs(sourceText, settings);

    return {
      totalMs,
      remainingMs,
      finishAt: now + remainingMs
    };
  }, [now, settings, text, typingStatus.index, typingStatus.status]);

  useEffect(() => {
    const listener = (message) => {
      if (message?.type === "HDT_STATUS_BROADCAST" || message?.type === "HDT_STATUS") {
        setTypingStatus((current) => ({ ...current, ...message.payload }));
        if (message.payload?.tabId) setSessionTabId(message.payload.tabId);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({ type: "HDT_GET_BACKGROUND_STATUS" }, (response) => {
      if (response?.ok && response.payload) {
        setTypingStatus((current) => ({ ...current, ...response.payload }));
        if (response.payload.tabId) setSessionTabId(response.payload.tabId);
      }
    });

    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const sendToDoc = useCallback(async (type, payload = {}) => {
    setNotice("");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeDocTabId = tab?.url?.startsWith("https://docs.google.com/") ? tab.id : null;
    const targetTabId = type === "HDT_START"
      ? activeDocTabId
      : activeDocTabId || (settings.handsFreeControls ? sessionTabId : null);

    if (!targetTabId) {
      throw new Error("Open a Google Docs document and place the cursor where typing should start.");
    }

    const response = await chrome.tabs.sendMessage(targetTabId, { type, payload }, { frameId: 0 });
    setSessionTabId(targetTabId);
    return response;
  }, [sessionTabId, settings.handsFreeControls]);

  const runCommand = useCallback(async (type, payload) => {
    try {
      const response = await sendToDoc(type, payload);
      if (response?.state) {
        setTypingStatus((current) => ({ ...current, ...response.state }));
      }
      if (response?.error) setNotice(response.error);
    } catch (error) {
      const message = normalizeChromeError(error);
      setNotice(message);
    }
  }, [sendToDoc]);

  const updateSetting = (key, value) => {
    setSettings((current) => ({
      ...current,
      [key]: typeof value === "boolean" ? value : Number(value)
    }));
  };

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <h1>Human Doc Typer</h1>
          <p>Active Google Docs typing session</p>
        </div>
        <span className={`${styles.badge} ${styles[typingStatus.status] || ""}`}>
          {typingStatus.status}
        </span>
      </header>

      <section className={styles.editorSection}>
        <label className={styles.label} htmlFor="typing-text">
          Text to type
        </label>
        <textarea
          id="typing-text"
          className={styles.textarea}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Paste or write the text you want typed into the active Google Docs document."
          spellCheck="true"
        />
        <div className={styles.counts}>
          <span>{text.length.toLocaleString()} characters</span>
          <span>{wordCount.toLocaleString()} words</span>
        </div>
      </section>

      <section className={styles.controls} aria-label="Typing controls">
        <button
          className={styles.primaryButton}
          disabled={!canStart}
          onClick={() => runCommand("HDT_START", { text, settings })}
        >
          Start
        </button>
        <button disabled={!isRunning} onClick={() => runCommand("HDT_PAUSE")}>
          Pause
        </button>
        <button disabled={!isPaused} onClick={() => runCommand("HDT_RESUME")}>
          Resume
        </button>
        <button disabled={!isRunning && !isPaused} onClick={() => runCommand("HDT_STOP")}>
          Stop
        </button>
      </section>

      <section className={styles.statusPanel}>
        <div className={styles.statusTopline}>
          <span>{typingStatus.message || "Ready"}</span>
          <span>{progress}%</span>
        </div>
        <div className={styles.progressTrack} aria-label="Typing progress">
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>
        <div className={styles.statusDetails}>
          <span>
            {typingStatus.index.toLocaleString()} / {typingStatus.total.toLocaleString()}
          </span>
          <span>Current: {renderChar(typingStatus.currentChar)}</span>
        </div>
      </section>

      <section className={styles.estimatePanel}>
        <div>
          <span>Estimated total</span>
          <strong>{formatDuration(estimate.totalMs)}</strong>
        </div>
        <div>
          <span>Remaining</span>
          <strong>{formatDuration(estimate.remainingMs)}</strong>
        </div>
        <div>
          <span>Finish time</span>
          <strong>{formatClock(estimate.finishAt)}</strong>
        </div>
      </section>

      <section className={styles.settings}>
        <h2>Settings</h2>
        <SliderRow
          label="Target typing speed"
          value={settings.wpm}
          min={20}
          max={140}
          step={1}
          suffix="WPM"
          onChange={(value) => updateSetting("wpm", value)}
        />
        <SliderRow
          label="Randomness factor"
          value={settings.randomnessMs}
          min={0}
          max={150}
          step={5}
          suffix="ms"
          onChange={(value) => updateSetting("randomnessMs", value)}
        />
        <SliderRow
          label="Human error rate"
          value={settings.errorRate}
          min={0}
          max={15}
          step={0.5}
          suffix="%"
          onChange={(value) => updateSetting("errorRate", value)}
        />
        <SliderRow
          label="False start chance"
          value={settings.falseStartRate}
          min={0}
          max={5}
          step={0.1}
          suffix="%"
          onChange={(value) => updateSetting("falseStartRate", value)}
        />
        <label className={styles.toggleRow}>
          <span>
            <span>Hands-free controls</span>
            <small>Keep session controls tied to the started Docs tab.</small>
          </span>
          <input
            type="checkbox"
            checked={settings.handsFreeControls}
            onChange={(event) => updateSetting("handsFreeControls", event.target.checked)}
          />
        </label>
      </section>

      {notice && <p className={styles.notice}>{notice}</p>}
    </main>
  );
}

function SliderRow({ label, value, min, max, step, suffix, onChange }) {
  return (
    <label className={styles.sliderRow}>
      <span className={styles.sliderLabel}>
        <span>{label}</span>
        <strong>
          {value}
          {suffix}
        </strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function renderChar(char) {
  if (!char) return "none";
  if (char === "\n") return "line break";
  if (char === " ") return "space";
  return char;
}

function normalizeChromeError(error) {
  const raw = error?.message || String(error);
  if (raw.includes("Receiving end does not exist")) {
    return "Reload the Google Docs tab, click inside the document, then try again.";
  }
  return raw;
}

function estimateTypingDurationMs(text, settings) {
  if (!text) return 0;

  const baseDelay = 60000 / (settings.wpm * 5);
  const punctuationPauses = (text.match(/[.!?;:]/g) || []).length * 910;
  const commaPauses = (text.match(/,/g) || []).length * 350;
  const lineBreakPauses = (text.match(/\n/g) || []).length * 1550;
  const thinkingPauses = (text.match(/ /g) || []).length * 0.04 * 575;
  const typoCharacters = (text.match(/[a-z]/gi) || []).length * (settings.errorRate / 100);
  const typoCorrectionCost = typoCharacters * (baseDelay + 620);
  const falseStartCost = estimateFalseStartCost(text, settings, baseDelay);

  return Math.max(0, text.length * baseDelay + punctuationPauses + commaPauses + lineBreakPauses + thinkingPauses + typoCorrectionCost + falseStartCost);
}

function estimateFalseStartCost(text, settings, baseDelay) {
  if (!settings.falseStartRate || text.length < 60) return 0;

  const spaces = (text.match(/ /g) || []).length;
  const maxFalseStarts = text.length < 220 ? 1 : text.length < 900 ? 2 : 3;
  const expectedFalseStarts = Math.min(maxFalseStarts, spaces * (settings.falseStartRate / 100));
  const averagePhraseChars = 24;
  const typeAndDeleteCost = averagePhraseChars * (baseDelay + 65);
  const reconsiderPauses = 2400;

  return expectedFalseStarts * (typeAndDeleteCost + reconsiderPauses);
}

function formatDuration(ms) {
  if (!ms) return "0 min";

  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatClock(timestamp) {
  if (!timestamp) return "--:--";

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
}
