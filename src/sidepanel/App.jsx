import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./App.module.css";

const DEFAULT_SETTINGS = {
  wpm: 65,
  randomnessMs: 45,
  errorRate: 2
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

  useEffect(() => {
    const listener = (message) => {
      if (message?.type === "HDT_STATUS_BROADCAST" || message?.type === "HDT_STATUS") {
        setTypingStatus((current) => ({ ...current, ...message.payload }));
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({ type: "HDT_GET_BACKGROUND_STATUS" }, (response) => {
      if (response?.ok && response.payload) {
        setTypingStatus((current) => ({ ...current, ...response.payload }));
      }
    });

    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const sendToActiveDoc = useCallback(async (type, payload = {}) => {
    setNotice("");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    if (!tab.url?.startsWith("https://docs.google.com/")) {
      throw new Error("Open a Google Docs document and place the cursor where typing should start.");
    }

    return chrome.tabs.sendMessage(tab.id, { type, payload }, { frameId: 0 });
  }, []);

  const runCommand = useCallback(async (type, payload) => {
    try {
      const response = await sendToActiveDoc(type, payload);
      if (response?.state) {
        setTypingStatus((current) => ({ ...current, ...response.state }));
      }
      if (response?.error) setNotice(response.error);
    } catch (error) {
      const message = normalizeChromeError(error);
      setNotice(message);
    }
  }, [sendToActiveDoc]);

  const updateSetting = (key, value) => {
    setSettings((current) => ({
      ...current,
      [key]: Number(value)
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
