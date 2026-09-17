(() => {
  "use strict";

  const CONTROL_ID = "icr-controls";
  const CAPTION_ID = "immersive-translate-caption-window";
  const ALLOWED_RATES = new Set([0.75, 1, 1.25, 1.5, 2]);
  const MAX_QUEUE_LENGTH = 3;

  let controls = null;
  let captionObserver = null;
  let pageObserver = null;
  let observedCaptionWindow = null;
  let stabilizationTimer = null;
  let queue = [];
  let recentTexts = [];
  let state = "stopped";
  let rate = 1;
  let generation = 0;
  let audioSnapshot = null;
  let currentVideoId = getVideoId();
  let recordingState = "idle";
  let recordingWriteChain = Promise.resolve();

  function normalizeCaptionText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function shouldQueueCaption(text, recent, pending) {
    const normalized = normalizeCaptionText(text);
    if (!normalized) return false;
    if (recent.includes(normalized)) return false;
    if (pending.some((item) => item === normalized)) return false;
    return true;
  }

  function getVideoId() {
    return new URLSearchParams(location.search).get("v") || "";
  }

  function findVideo() {
    return document.querySelector("video.html5-main-video, #movie_player video");
  }

  function findPlayer() {
    const video = findVideo();
    return (
      video?.closest("#movie_player, .html5-video-player") ||
      document.querySelector("ytd-player #movie_player, #movie_player")
    );
  }

  function getVideoMetadata() {
    const video = findVideo();
    const titleElement = document.querySelector(
      "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
    );
    const channelElement = document.querySelector(
      "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
    );
    return {
      youtubeVideoId: currentVideoId,
      title:
        titleElement?.textContent?.trim() ||
        document.title.replace(/\s*-\s*YouTube\s*$/, "").trim(),
      url: currentVideoId
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(currentVideoId)}`
        : location.href,
      channel: channelElement?.textContent?.trim() || "",
      durationMs: Number.isFinite(video?.duration)
        ? Math.round(video.duration * 1000)
        : null,
    };
  }

  function readImmersiveCaption() {
    const captionWindow = document.getElementById(CAPTION_ID);
    const root = captionWindow?.shadowRoot;
    if (!root) return "";
    return normalizeCaptionText(
      Array.from(root.querySelectorAll(".target-cue"))
        .map((node) => node.textContent)
        .join(" "),
    );
  }

  function chooseChineseVoice() {
    const voices = speechSynthesis.getVoices();
    return (
      voices.find((voice) => /^zh-CN$/i.test(voice.lang)) ||
      voices.find((voice) => /^zh(?:-|$)/i.test(voice.lang)) ||
      null
    );
  }

  function setStatus(message) {
    controls?.querySelector(".icr-status")?.replaceChildren(message || "");
  }

  function updateControls() {
    if (!controls) return;
    const play = controls.querySelector(".icr-play");
    const pause = controls.querySelector(".icr-pause");
    const stop = controls.querySelector(".icr-stop");
    play.textContent = state === "paused" ? "继续" : "朗读";
    pause.disabled = state !== "playing";
    stop.disabled = state === "stopped";
    controls.dataset.state = state;

    const record = controls.querySelector(".icr-record");
    const recordPause = controls.querySelector(".icr-record-pause");
    const recordStop = controls.querySelector(".icr-record-stop");
    record.textContent = recordingState === "paused" ? "继续记录" : "开始记录";
    record.disabled = recordingState === "recording";
    recordPause.disabled = recordingState !== "recording";
    recordStop.disabled = recordingState === "idle";
    controls.dataset.recording = recordingState;
  }

  function muteVideo() {
    const video = findVideo();
    if (!video) return;
    if (!audioSnapshot || audioSnapshot.video !== video) {
      restoreVideoAudio();
      audioSnapshot = { video, muted: video.muted, volume: video.volume };
    }
    video.muted = true;
  }

  function restoreVideoAudio() {
    if (!audioSnapshot) return;
    const { video, muted, volume } = audioSnapshot;
    if (video?.isConnected) {
      video.volume = volume;
      video.muted = muted;
    }
    audioSnapshot = null;
  }

  function speakNext(activeGeneration) {
    if (activeGeneration !== generation || state !== "playing") return;
    if (!queue.length) {
      setStatus("等待下一句中文字幕…");
      return;
    }

    const text = queue.shift();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = rate;
    const voice = chooseChineseVoice();
    if (voice) utterance.voice = voice;

    utterance.onend = () => {
      if (activeGeneration !== generation) return;
      recentTexts.push(text);
      recentTexts = recentTexts.slice(-20);
      speakNext(activeGeneration);
    };
    utterance.onerror = (event) => {
      if (activeGeneration !== generation) return;
      if (event.error === "canceled" || event.error === "interrupted") return;
      setStatus("朗读失败，请点击停止后重试。");
    };
    setStatus(`正在朗读：${text.slice(0, 24)}${text.length > 24 ? "…" : ""}`);
    speechSynthesis.speak(utterance);
  }

  function enqueueVisibleCaption() {
    const text = readImmersiveCaption();
    if (recordingState === "recording" && text) captureCaption(text);
    if (state === "stopped") return;
    if (!shouldQueueCaption(text, recentTexts, queue)) return;

    // Immersive Translate may refine the same cue several times. Replace an
    // unsaid prefix version instead of reading both versions aloud.
    const last = queue.at(-1);
    if (last && (text.startsWith(last) || last.startsWith(text))) queue.pop();
    queue.push(text);
    if (queue.length > MAX_QUEUE_LENGTH) queue = queue.slice(-MAX_QUEUE_LENGTH);

    if (state === "playing" && !speechSynthesis.speaking) {
      speakNext(generation);
    }
  }

  function scheduleCaptionRead() {
    clearTimeout(stabilizationTimer);
    stabilizationTimer = setTimeout(enqueueVisibleCaption, 220);
  }

  function connectCaptionObserver() {
    const captionWindow = document.getElementById(CAPTION_ID);
    if (!captionWindow?.shadowRoot) return false;
    if (observedCaptionWindow === captionWindow && captionObserver) return true;

    captionObserver?.disconnect();
    observedCaptionWindow = captionWindow;
    captionObserver = new MutationObserver(scheduleCaptionRead);
    captionObserver.observe(captionWindow.shadowRoot, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    scheduleCaptionRead();
    return true;
  }

  function setRecordingStatus(message) {
    controls
      ?.querySelector(".icr-record-status")
      ?.replaceChildren(message || "");
  }

  function formatNoteTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function setNoteStatus(message) {
    controls?.querySelector(".icr-note-status")?.replaceChildren(message || "");
  }

  async function saveVisibleCaptionNote() {
    const video = findVideo();
    const text = readImmersiveCaption();
    if (!currentVideoId || !video) {
      setNoteStatus("当前页面不是普通 YouTube 视频。");
      return;
    }
    if (!text) {
      setNoteStatus("当前没有检测到中文字幕，暂时无法记笔记。");
      return;
    }

    const timestampMs = Math.max(0, Math.round(video.currentTime * 1000));
    const button = controls?.querySelector(".icr-note");
    if (button) button.disabled = true;
    try {
      await ICRStorage.upsertVideo(getVideoMetadata());
      const transcript = await ICRStorage.getTranscript(currentVideoId);
      const closest = (transcript?.segments || [])
        .filter((segment) => segment.startMs <= timestampMs)
        .at(-1);
      await ICRStorage.saveNote({
        videoId: currentVideoId,
        timestampMs,
        text,
        segmentIds: closest ? [closest.id] : [],
      });
      setNoteStatus(`笔记已保存 ${formatNoteTime(timestampMs)}`);
    } catch (error) {
      console.error("[沉浸式字幕朗读器] 保存笔记失败：", error);
      setNoteStatus("笔记保存失败，请重新加载插件后再试。");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function captureCaption(text) {
    const video = findVideo();
    if (!currentVideoId || !video) return;
    const snapshot = {
      videoId: currentVideoId,
      textZh: text,
      startMs: Math.max(0, Math.round(video.currentTime * 1000)),
      observedAt: new Date().toISOString(),
    };
    recordingWriteChain = recordingWriteChain
      .then(() => ICRStorage.saveCaptionSnapshot(snapshot))
      .then(({ transcript, changed }) => {
        if (changed && currentVideoId === snapshot.videoId) {
          setRecordingStatus(`已记录 ${transcript.segments.length} 段中文字幕`);
        }
      })
      .catch((error) => {
        console.error("[沉浸式字幕朗读器] 保存字幕失败：", error);
        setRecordingStatus("保存失败，请停止后重试。");
      });
  }

  async function startRecording() {
    if (!currentVideoId) {
      setRecordingStatus("当前页面不是普通 YouTube 视频。");
      return;
    }
    if (!connectCaptionObserver()) {
      setRecordingStatus("未检测到沉浸式翻译字幕，请先开启双语字幕。");
      return;
    }
    try {
      await ICRStorage.upsertVideo(getVideoMetadata());
      const transcript = await ICRStorage.setCaptureStatus(
        currentVideoId,
        "recording",
      );
      recordingState = "recording";
      updateControls();
      setRecordingStatus(`正在记录，已有 ${transcript.segments.length} 段`);
      scheduleCaptionRead();
    } catch (error) {
      console.error("[沉浸式字幕朗读器] 开始记录失败：", error);
      setRecordingStatus("无法开始记录，请重新加载插件。");
    }
  }

  async function pauseRecording() {
    if (recordingState !== "recording" || !currentVideoId) return;
    recordingState = "paused";
    updateControls();
    setRecordingStatus("记录已暂停。");
    await ICRStorage.setCaptureStatus(currentVideoId, "paused").catch(() => {});
  }

  async function stopRecording(message = "记录已停止。") {
    const videoId = currentVideoId;
    recordingState = "idle";
    updateControls();
    setRecordingStatus(message);
    if (videoId) {
      await recordingWriteChain.catch(() => {});
      await ICRStorage.setCaptureStatus(videoId, "stopped").catch(() => {});
    }
    if (state === "stopped") {
      captionObserver?.disconnect();
      captionObserver = null;
      observedCaptionWindow = null;
    }
  }

  function startReading() {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setStatus("当前浏览器不支持语音朗读。");
      return;
    }
    if (state === "paused") {
      speechSynthesis.resume();
      state = "playing";
      setStatus("已继续朗读。");
      updateControls();
      return;
    }
    if (!connectCaptionObserver()) {
      setStatus("未检测到沉浸式翻译字幕，请先开启双语字幕。");
      return;
    }

    speechSynthesis.cancel();
    generation += 1;
    queue = [];
    recentTexts = [];
    state = "playing";
    muteVideo();
    updateControls();
    const text = readImmersiveCaption();
    if (text) {
      queue.push(text);
      speakNext(generation);
    } else {
      setStatus("等待沉浸式翻译显示中文字幕…");
    }
  }

  function pauseReading() {
    if (state !== "playing") return;
    speechSynthesis.pause();
    state = "paused";
    setStatus("已暂停。");
    updateControls();
  }

  function stopReading(message = "") {
    generation += 1;
    clearTimeout(stabilizationTimer);
    speechSynthesis?.cancel();
    queue = [];
    recentTexts = [];
    state = "stopped";
    restoreVideoAudio();
    setStatus(message);
    updateControls();
  }

  function createControls() {
    const player = findPlayer();
    if (!player || document.getElementById(CONTROL_ID)) return;
    controls = document.createElement("div");
    controls.id = CONTROL_ID;
    controls.innerHTML = `
      <div class="icr-row">
        <button class="icr-play" type="button">朗读</button>
        <button class="icr-pause" type="button" disabled>暂停</button>
        <button class="icr-stop" type="button" disabled>停止</button>
        <select class="icr-rate" aria-label="朗读倍速">
          <option value="0.75">0.75×</option>
          <option value="1" selected>1.0×</option>
          <option value="1.25">1.25×</option>
          <option value="1.5">1.5×</option>
          <option value="2">2.0×</option>
        </select>
        <button class="icr-note" type="button" title="保存当前中文字幕（快捷键 N）">记笔记 N</button>
        <span class="icr-status" aria-live="polite"></span>
      </div>
      <div class="icr-row icr-record-row">
        <button class="icr-record" type="button">开始记录</button>
        <button class="icr-record-pause" type="button" disabled>暂停记录</button>
        <button class="icr-record-stop" type="button" disabled>停止记录</button>
        <button class="icr-open-panel" type="button">打开原料包</button>
        <span class="icr-record-status" aria-live="polite"></span>
        <span class="icr-note-status" aria-live="polite"></span>
      </div>
    `;
    controls.addEventListener("click", (event) => event.stopPropagation());
    controls.querySelector(".icr-play").addEventListener("click", startReading);
    controls.querySelector(".icr-pause").addEventListener("click", pauseReading);
    controls.querySelector(".icr-stop").addEventListener("click", () => stopReading());
    controls.querySelector(".icr-note").addEventListener("click", () => {
      void saveVisibleCaptionNote();
    });
    controls.querySelector(".icr-record").addEventListener("click", startRecording);
    controls
      .querySelector(".icr-record-pause")
      .addEventListener("click", pauseRecording);
    controls
      .querySelector(".icr-record-stop")
      .addEventListener("click", () => stopRecording());
    controls.querySelector(".icr-open-panel").addEventListener("click", async () => {
      try {
        const result = await chrome.runtime.sendMessage({
          action: "openKnowledgePanel",
        });
        if (!result?.success) {
          setRecordingStatus("无法打开原料包，请重新加载插件后再试。");
        }
      } catch (error) {
        setRecordingStatus("无法打开原料包，请重新加载插件后再试。");
      }
    });
    controls.querySelector(".icr-rate").addEventListener("change", (event) => {
      const nextRate = Number(event.target.value);
      if (ALLOWED_RATES.has(nextRate)) rate = nextRate;
    });
    player.appendChild(controls);
  }

  function reconcilePage() {
    const nextVideoId = getVideoId();
    if (nextVideoId !== currentVideoId) {
      stopReading();
      void stopRecording("视频已切换，记录已停止。");
      currentVideoId = nextVideoId;
      captionObserver?.disconnect();
      captionObserver = null;
      observedCaptionWindow = null;
      controls?.remove();
      controls = null;
    }
    createControls();
    if (state !== "stopped" || recordingState !== "idle") {
      connectCaptionObserver();
    }
  }

  pageObserver = new MutationObserver(reconcilePage);
  pageObserver.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("yt-navigate-start", () => {
    stopReading();
    void stopRecording("视频已切换，记录已停止。");
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const isTyping =
      target instanceof HTMLElement &&
      (target.matches("input, textarea, select") || target.isContentEditable);
    if (
      event.key.toLowerCase() !== "n" ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isTyping
    ) {
      return;
    }
    event.preventDefault();
    void saveVisibleCaptionNote();
  });
  window.addEventListener("pagehide", () => {
    stopReading();
    void stopRecording("");
  });
  speechSynthesis?.addEventListener?.("voiceschanged", updateControls);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "getKnowledgeVideoState") {
      const video = findVideo();
      sendResponse({
        ...getVideoMetadata(),
        currentTimeMs: video ? Math.round(video.currentTime * 1000) : 0,
      });
      return false;
    }
    if (message.action === "seekToKnowledgeTime") {
      const video = findVideo();
      if (video) {
        video.currentTime = Math.max(0, Number(message.seconds) || 0);
        video.play().catch(() => {});
      }
      sendResponse({ success: Boolean(video) });
      return false;
    }
    return false;
  });
  reconcilePage();

  // Pure helpers for the small Node test suite. This object has no runtime role.
  globalThis.__ICR_TESTING__ = {
    normalizeCaptionText,
    shouldQueueCaption,
    formatNoteTime,
  };
})();
