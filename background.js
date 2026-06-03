let lastStatus = {
  status: "idle",
  index: 0,
  total: 0,
  currentChar: "",
  message: "Ready"
};

chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !chrome.sidePanel?.open) return;

  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    console.warn("Unable to open Human Doc Typer side panel:", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "HDT_STATUS") {
    lastStatus = {
      ...lastStatus,
      ...message.payload,
      tabId: sender.tab?.id,
      frameId: sender.frameId,
      updatedAt: Date.now()
    };

    chrome.runtime.sendMessage({ type: "HDT_STATUS_BROADCAST", payload: lastStatus }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "HDT_GET_BACKGROUND_STATUS") {
    sendResponse({ ok: true, payload: lastStatus });
    return false;
  }

  return false;
});
