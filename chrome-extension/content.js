/**
 * WhiteCode Meet Automation - Content Script
 * Injected into meet.google.com to track ongoing discussions in English and Marathi.
 */

const BACKEND_URL = "http://localhost:3000";

let isTracking = false;
let mediaRecorder = null;
let audioStream = null;
let captionObserver = null;
let lastCaptionText = "";
let lastCaptionTime = 0;

// Extract Google Meet meeting code from URL (e.g. "abc-defg-hij")
function getMeetingCode() {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
  const parts = path.split("/");
  const code = parts[parts.length - 1];
  if (code && code.replace(/-/g, "").length >= 9) {
    return code;
  }
  return null;
}

// Automatically turn on Google Meet live captions if not already on
function autoEnableCaptions() {
  const captionButtons = document.querySelectorAll(
    'button[aria-label*="caption" i], button[aria-label*="कॅपशन" i], button[data-tooltip*="caption" i]'
  );
  for (const btn of captionButtons) {
    const isPressed = btn.getAttribute("aria-pressed");
    if (isPressed === "false") {
      console.log("[WhiteCode Sync] Auto-enabling Google Meet live captions...");
      btn.click();
      break;
    }
  }
}

// Detect and filter out Google Meet system accessibility toasts and UI announcements
function isSystemNotification(text) {
  if (!text || text.trim().length === 0) return true;
  const t = text.trim();
  const systemPatterns = [
    /microphone is (on|off)/i,
    /camera is (on|off)/i,
    /left the meeting/i,
    /joined the (meeting|call)/i,
    /has joined/i,
    /has left/i,
    /rate the audio and video/i,
    /returning to home screen/i,
    /\b\d+\s*seconds?\s*left/i,
    /someone wants to join/i,
    /admit/i,
    /you are muted/i,
    /your mic is/i,
    /turn on microphone/i,
    /presenting to everyone/i,
    /stop presenting/i,
    /jump to latest/i,
    /captions have been turned (on|off)/i,
    /chat messages/i,
    /in-call messages/i,
    /can't start video/i,
    /network connection is unstable/i,
  ];
  return systemPatterns.some((pattern) => pattern.test(t));
}

let observedSpeakers = new Set();

// Scrapes and extracts all active attending participants from Google Meet DOM
function extractMeetingParticipants() {
  const participants = new Set(observedSpeakers);

  const ignoredPatterns = /^(You|You \(Presenting\)|Presenting|Turn on|Turn off|More options|Details|People|Chat|Activities|Search for people|Everyone|In call|Meeting details|Host controls|Raise hand|Turn on captions|Microphone|Camera)$/i;

  // 1. Participant video tiles, name badges, and self-view
  document.querySelectorAll('span[jsname="Wvd9Cc"], .ZjFb7c, .XEazBc, .poVWob, .cS7aqe, .GvcuGe, span.NOTWr, span.dwLV7d, [data-self-name]').forEach((el) => {
    const selfName = el.getAttribute("data-self-name");
    if (selfName && selfName.trim().length > 1 && !ignoredPatterns.test(selfName.trim())) {
      participants.add(selfName.trim());
    }
    const name = (el.innerText || "").trim();
    if (
      name &&
      name.length >= 2 &&
      !name.includes("\n") &&
      !ignoredPatterns.test(name)
    ) {
      participants.add(name);
    }
  });

  // 2. People panel items (when opened or in DOM)
  document.querySelectorAll('div[role="listitem"] .zWGUib, div[role="listitem"] .KV10e, div[data-participant-id] span, div[data-requested-participant-id]').forEach((el) => {
    const name = (el.innerText || "").split("\n")[0].trim();
    if (name && name.length >= 2 && !ignoredPatterns.test(name)) {
      participants.add(name);
    }
  });

  return Array.from(participants);
}

// Observe Google Meet live captions DOM in real-time
function startCaptionObserver() {
  if (captionObserver) return;

  autoEnableCaptions();

  captionObserver = new MutationObserver((mutations) => {
    if (!isTracking) return;

    // Search for actual speech caption containers in Google Meet (excluding system toasts)
    const captionContainers = document.querySelectorAll(
      '.nM7ykc, .iTTPOb, [jsname="YSxPC"], div[jscontroller="D1tHje"]'
    );

    for (const container of captionContainers) {
      const text = (container.innerText || "").trim();
      if (!text || text === lastCaptionText || isSystemNotification(text)) continue;

      const now = Date.now();
      if (now - lastCaptionTime < 1500) continue; // Debounce rapid DOM updates

      lastCaptionText = text;
      lastCaptionTime = now;

      const meetingCode = getMeetingCode();
      if (!meetingCode) continue;

      // Extract speaker name if available in parent or sibling elements
      let speaker = "Participant";
      const speakerEl = container.closest(".nM7ykc")?.querySelector(".zs75Bi, .NWLHx, span:first-child");
      if (speakerEl && speakerEl.innerText) {
        speaker = speakerEl.innerText.trim();
        if (speaker && speaker !== "Participant" && speaker !== "Speaker") {
          observedSpeakers.add(speaker);
        }
      }

      console.log(`[WhiteCode Sync] Discussion captured [${speaker}]: ${text}`);

      // Stream to WhiteCode backend
      fetch(`${BACKEND_URL}/api/meet/caption-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingCode,
          speaker,
          text,
        }),
      }).catch((err) => {
        console.warn("[WhiteCode Sync] Failed to stream caption to backend:", err.message);
      });
    }
  });

  captionObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  console.log("[WhiteCode Sync] Captions observer active.");
}

let recordedAudioBlobs = [];

// Start audio recording with MediaRecorder (accumulates valid full audio track)
async function startAudioRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") return;
  recordedAudioBlobs = [];

  try {
    console.log("[WhiteCode Sync] Requesting high-fidelity microphone stream with noise cancellation...");
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1,
      },
    });
    
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    mediaRecorder = new MediaRecorder(audioStream, {
      mimeType,
      audioBitsPerSecond: 128000,
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedAudioBlobs.push(event.data);
      }
    };

    // Buffer audio data continuously
    mediaRecorder.start(2000);
    console.log("[WhiteCode Sync] Audio recording active (collecting 128kbps noise-suppressed discussion track).");
  } catch (err) {
    console.warn("[WhiteCode Sync] Microphone access not granted. Relying on live captions observer:", err.message);
  }
}

// Stop audio recording and upload the complete assembled audio file
async function stopAudioRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      mediaRecorder.onstop = resolve;
      try {
        mediaRecorder.stop();
      } catch {
        resolve();
      }
    });
  }
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }

  // If audio was collected, upload the single assembled valid WebM file
  if (recordedAudioBlobs.length > 0) {
    const meetingCode = getMeetingCode();
    const completeBlob = new Blob(recordedAudioBlobs, { type: "audio/webm" });
    recordedAudioBlobs = [];

    if (meetingCode && completeBlob.size > 5000) {
      console.log(`[WhiteCode Sync] Uploading complete valid audio file (${completeBlob.size} bytes) for meeting ${meetingCode}...`);
      const participants = extractMeetingParticipants();
      console.log(`[WhiteCode Sync] Detected meeting participants (${participants.length}):`, participants);

      const formData = new FormData();
      formData.append("audio", completeBlob, `meeting-${meetingCode}-${Date.now()}.webm`);
      formData.append("meetingCode", meetingCode);
      formData.append("speaker", "Meeting Participant");
      formData.append("participants", JSON.stringify(participants));

      try {
        const res = await fetch(`${BACKEND_URL}/api/meet/audio-chunk`, {
          method: "POST",
          body: formData,
        });
        const json = await res.json();
        if (json.success && json.transcribedText) {
          console.log(`[WhiteCode Sync] Discussion audio transcribed: "${json.transcribedText}"`);
        }
        return json;
      } catch (err) {
        console.warn("[WhiteCode Sync] Final audio upload error:", err.message);
      }
    }
  }
  return null;
}

// Listen for messages from popup.js
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "GET_STATUS") {
    sendResponse({
      meetingCode: getMeetingCode(),
      isTracking,
      url: window.location.href,
      participants: extractMeetingParticipants(),
    });
    return true;
  }

  if (message.action === "START_TRACKING") {
    isTracking = true;
    startCaptionObserver();
    void startAudioRecording();
    sendResponse({ success: true, isTracking: true, meetingCode: getMeetingCode() });
    return true;
  }

  if (message.action === "STOP_TRACKING") {
    isTracking = false;
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    // Await audio upload and Gemini transcription before telling popup we're done
    stopAudioRecording()
      .then((uploadResult) => {
        sendResponse({ success: true, isTracking: false, uploadResult });
      })
      .catch((err) => {
        console.warn("[WhiteCode Sync] Error during stopAudioRecording:", err);
        sendResponse({ success: true, isTracking: false });
      });
    return true; // Keep message channel open for async response
  }
});

// Auto-start tracking if on active meeting
window.addEventListener("load", () => {
  const code = getMeetingCode();
  if (code) {
    console.log(`[WhiteCode Sync] Detected Google Meet space: ${code}`);
  }
});
