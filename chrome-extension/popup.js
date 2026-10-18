/**
 * WhiteCode Meet Automation - Popup Logic
 */

const BACKEND_URL = "http://localhost:3000";

let currentMeetingCode = null;
let isTracking = false;
let pollInterval = null;

// DOM Elements
const serverBadge = document.getElementById("serverBadge");
const serverStatusText = document.getElementById("serverStatusText");
const meetCodePill = document.getElementById("meetCodePill");
const recDot = document.getElementById("recDot");
const recStatusText = document.getElementById("recStatusText");
const trackBtn = document.getElementById("trackBtn");
const trackBtnText = document.getElementById("trackBtnText");
const finalizeBtn = document.getElementById("finalizeBtn");
const viewTasksheetsBtn = document.getElementById("viewTasksheetsBtn");
const transcriptBox = document.getElementById("transcriptBox");
const charCount = document.getElementById("charCount");
const resultAlert = document.getElementById("resultAlert");

// Check connection to local WhiteCode backend
async function checkBackendHealth() {
  try {
    const res = await fetch(`${BACKEND_URL}/stored-meetings`, { method: "GET" });
    if (res.ok) {
      serverBadge.className = "status-badge";
      serverStatusText.textContent = "Connected (Port 3000)";
      return true;
    }
  } catch (err) {
    serverBadge.className = "status-badge offline";
    serverStatusText.textContent = "Backend Offline";
  }
  return false;
}

// Get active Google Meet tab
async function getActiveMeetTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (activeTab && activeTab.url && activeTab.url.includes("meet.google.com")) {
    return activeTab;
  }
  return null;
}

// Fetch live transcript from backend
async function refreshTranscript() {
  if (!currentMeetingCode) return;

  try {
    const res = await fetch(`${BACKEND_URL}/api/meet/${currentMeetingCode}/transcript`);
    if (res.ok) {
      const data = await res.json();
      if (data.transcript && data.transcript.trim()) {
        transcriptBox.textContent = data.transcript;
        charCount.textContent = `${data.transcript.length} chars`;
        transcriptBox.scrollTop = transcriptBox.scrollHeight;
      }
    }
  } catch (err) {
    // Ignore polling errors
  }
}

// Initialize popup
async function init() {
  await checkBackendHealth();

  const tab = await getActiveMeetTab();
  if (!tab || !tab.id) {
    meetCodePill.textContent = "Not on Google Meet";
    meetCodePill.style.color = "#94a3b8";
    trackBtn.disabled = true;
    trackBtn.style.opacity = "0.5";
    return;
  }

  // Ask content script for meeting code and tracking status
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "GET_STATUS" });
    if (response && response.meetingCode) {
      currentMeetingCode = response.meetingCode;
      meetCodePill.textContent = currentMeetingCode;
      isTracking = Boolean(response.isTracking);
      updateUI();
      void refreshTranscript();
    } else {
      meetCodePill.textContent = "Join Call to Sync";
    }
  } catch (err) {
    // Content script might not be injected yet (e.g. if loaded before extension)
    console.warn("Could not message content script:", err);
    meetCodePill.textContent = "Refresh Meet Page";
  }
}

function updateUI() {
  if (isTracking) {
    recDot.className = "rec-dot active";
    recStatusText.textContent = "Tracking Live";
    recStatusText.style.color = "#ef4444";
    trackBtnText.textContent = "Pause Tracking";
    finalizeBtn.style.display = "flex";
    if (!pollInterval) {
      pollInterval = setInterval(refreshTranscript, 4000);
    }
  } else {
    recDot.className = "rec-dot";
    recStatusText.textContent = "Idle";
    recStatusText.style.color = "#94a3b8";
    trackBtnText.textContent = "Start Discussion Tracking";
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }
}

// Track button click
trackBtn.addEventListener("click", async () => {
  const tab = await getActiveMeetTab();
  if (!tab || !tab.id) return;

  const action = isTracking ? "STOP_TRACKING" : "START_TRACKING";
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action });
    if (res && res.success) {
      isTracking = res.isTracking;
      if (res.meetingCode) {
        currentMeetingCode = res.meetingCode;
        meetCodePill.textContent = currentMeetingCode;
      }
      updateUI();
    }
  } catch (err) {
    alert("Please reload the Google Meet tab once to connect the WhiteCode extension.");
  }
});

// Finalize discussion and fill Tasksheet
finalizeBtn.addEventListener("click", async () => {
  if (!currentMeetingCode) {
    alert("No active meeting code detected.");
    return;
  }

  finalizeBtn.disabled = true;
  finalizeBtn.style.opacity = "0.7";
  finalizeBtn.textContent = "⏳ Uploading & Transcribing Audio...";

  // 1. Tell content script to stop recording and upload audio
  let detectedParticipants = [];
  const tab = await getActiveMeetTab();
  if (tab && tab.id) {
    try {
      const statusRes = await chrome.tabs.sendMessage(tab.id, { action: "GET_STATUS" });
      if (statusRes && statusRes.participants) {
        detectedParticipants = statusRes.participants;
      }
    } catch {}

    try {
      await chrome.tabs.sendMessage(tab.id, { action: "STOP_TRACKING" });
    } catch {}
  }

  // 2. Fetch updated transcript so the popup immediately displays what was transcribed
  await refreshTranscript();

  // 3. Trigger meeting classification and tasksheet sync with full discussion topics
  finalizeBtn.textContent = "⏳ Extracting Discussion Topics & Syncing Tasksheet...";

  try {
    const res = await fetch(`${BACKEND_URL}/api/meet/finalize-discussion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        meetingCode: currentMeetingCode,
        participants: detectedParticipants,
      }),
    });

    const data = await res.json();
    if (data.success) {
      const topicsList = (data.classifiedProject?.topicsDiscussed && data.classifiedProject.topicsDiscussed.length > 0)
        ? data.classifiedProject.topicsDiscussed.map(t => `<span style="display:block; margin-bottom: 2px;">• ${t}</span>`).join("")
        : `<span>${data.classifiedProject?.taskDetails || "Discussion logged"}</span>`;

      resultAlert.style.display = "block";
      resultAlert.innerHTML = `
        <div style="font-weight: bold; color: #34d399; margin-bottom: 4px;">✅ Tasksheet Updated!</div>
        <div style="font-size: 13px; margin-bottom: 6px;">
          <strong>Project:</strong> ${data.classifiedProject?.projectName || "Assigned"}
        </div>
        <div style="background: rgba(0,0,0,0.25); padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.4; color: #e2e8f0; margin-bottom: 8px;">
          <strong style="color: #a5b4fc; display: block; margin-bottom: 3px;">What Was Discussed:</strong>
          ${topicsList}
        </div>
        <a href="${BACKEND_URL}/tasksheets" target="_blank" style="color: #6ee7b7; text-decoration: underline; font-size: 12px;">View Employee Tasksheets</a>
      `;
      isTracking = false;
      updateUI();
    } else {
      alert("Finalize failed: " + (data.error || data.message));
    }
  } catch (err) {
    alert("Error calling backend finalize API: " + err.message);
  } finally {
    finalizeBtn.disabled = false;
    finalizeBtn.style.opacity = "1";
    finalizeBtn.innerHTML = "<span>⚡</span> <span>Finalize & Fill Tasksheet</span>";
  }
});

// View Tasksheets Dashboard
viewTasksheetsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: `${BACKEND_URL}/tasksheets` });
});

document.addEventListener("DOMContentLoaded", init);
