let activeTabId = null;
let activeVideoId = null;
let currentVideo = null;
let currentTranscript = null;
let currentNotes = [];
let currentNoteDocument = null;
let noteSaveTimer = null;
const noteCommentTimers = new Map();
let latestLoadId = 0;

function formatTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("youtube.com") ? parsed.searchParams.get("v") : null;
  } catch {
    return null;
  }
}

async function getActiveVideoState() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  const videoId = extractVideoId(tab?.url || "");
  if (!tab?.id || !videoId) return null;
  activeTabId = tab.id;
  activeVideoId = videoId;
  try {
    return await chrome.tabs.sendMessage(tab.id, { action: "getKnowledgeVideoState" });
  } catch {
    return { youtubeVideoId: videoId, url: tab.url, title: tab.title || "YouTube 视频" };
  }
}

async function loadData() {
  const loadId = ++latestLoadId;
  const liveState = await getActiveVideoState();
  const empty = document.getElementById("emptyState");
  if (!liveState || !activeVideoId) {
    empty.hidden = false;
    document.querySelectorAll(".summary, .tabs, .panel").forEach((node) => {
      node.hidden = true;
    });
    return;
  }
  empty.hidden = true;
  document.querySelectorAll(".summary, .tabs, .panel").forEach((node) => {
    node.hidden = false;
  });

  const requestedVideoId = activeVideoId;
  const [storedVideo, transcript, notes, noteDocument] = await Promise.all([
    ICRStorage.getVideo(requestedVideoId),
    ICRStorage.getTranscript(requestedVideoId),
    ICRStorage.getNotes(requestedVideoId),
    ICRStorage.getNoteDocument(requestedVideoId),
  ]);
  if (loadId !== latestLoadId || requestedVideoId !== activeVideoId) return;
  currentVideo = storedVideo || liveState;
  currentTranscript = transcript;
  currentNotes = notes;
  currentNoteDocument = noteDocument;
  render();
}

function render() {
  document.getElementById("videoTitle").textContent = currentVideo?.title || "视频知识原料包";
  const link = document.getElementById("videoUrl");
  link.href = currentVideo?.url || "#";
  link.textContent = currentVideo?.url || "";
  document.getElementById("segmentCount").textContent = currentTranscript?.segments?.length || 0;
  document.getElementById("noteCount").textContent = currentNotes.length;
  document.getElementById("captureStatus").textContent = ({
    recording: "记录中",
    paused: "已暂停",
    stopped: "已停止",
    idle: "未记录",
  })[currentTranscript?.captureStatus] || "未记录";
  renderTranscript();
  renderNotes();
  renderNoteDocument();
}

function createTimeButton(milliseconds) {
  const button = document.createElement("button");
  button.className = "time";
  button.type = "button";
  button.textContent = formatTime(milliseconds);
  button.addEventListener("click", () => seekTo(milliseconds));
  return button;
}

function renderTranscript() {
  const list = document.getElementById("transcriptList");
  list.replaceChildren();
  const segments = currentTranscript?.segments || [];
  if (!segments.length) {
    const message = document.createElement("p");
    message.className = "hint";
    message.textContent = "还没有字幕记录。请在视频上点击“开始记录”。";
    list.appendChild(message);
    return;
  }
  segments.forEach((segment) => {
    const item = document.createElement("article");
    item.className = "item";
    item.appendChild(createTimeButton(segment.startMs));
    const text = document.createElement("p");
    text.textContent = segment.textZh;
    item.appendChild(text);
    list.appendChild(item);
  });
}

function renderNotes() {
  const list = document.getElementById("notesList");
  list.replaceChildren();
  if (!currentNotes.length) {
    const message = document.createElement("p");
    message.className = "hint";
    message.textContent = "还没有笔记。";
    list.appendChild(message);
    return;
  }
  [...currentNotes]
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .forEach((note) => {
      const item = document.createElement("article");
      item.className = "note-capture";
      const head = document.createElement("div");
      head.className = "note-capture-head";
      head.appendChild(createTimeButton(note.timestampMs));
      const text = document.createElement("p");
      text.className = "captured-text";
      text.textContent = note.text;
      head.appendChild(text);
      const remove = document.createElement("button");
      remove.className = "delete";
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "删除这条字幕引用";
      remove.addEventListener("click", async () => {
        currentNotes = await ICRStorage.deleteNote(activeVideoId, note.id);
        render();
      });
      head.appendChild(remove);
      item.appendChild(head);

      const comment = document.createElement("textarea");
      comment.className = "note-comment";
      comment.rows = 3;
      comment.placeholder = "在这条视频笔记下面继续写你的心得和想法……";
      comment.value = note.comment || "";
      const saveStatus = document.createElement("span");
      saveStatus.className = "note-save-status";
      comment.addEventListener("input", () => {
        scheduleNoteCommentSave(note.id, comment.value, saveStatus);
      });
      comment.addEventListener("blur", () => {
        void saveNoteComment(note.id, comment.value, saveStatus);
      });
      item.appendChild(comment);
      item.appendChild(saveStatus);
      list.appendChild(item);
    });
}

async function saveNoteComment(noteId, comment, status) {
  clearTimeout(noteCommentTimers.get(noteId));
  noteCommentTimers.delete(noteId);
  try {
    currentNotes = await ICRStorage.updateNoteComment(
      activeVideoId,
      noteId,
      comment,
    );
    status.textContent = "已自动保存";
  } catch (error) {
    console.error("[沉浸式字幕朗读器] 保存笔记想法失败：", error);
    status.textContent = "保存失败";
  }
}

function scheduleNoteCommentSave(noteId, comment, status) {
  status.textContent = "正在保存…";
  clearTimeout(noteCommentTimers.get(noteId));
  noteCommentTimers.set(
    noteId,
    setTimeout(() => void saveNoteComment(noteId, comment, status), 500),
  );
}

function renderNoteDocument() {
  const editor = document.getElementById("noteDocument");
  if (document.activeElement !== editor) {
    editor.value = currentNoteDocument?.body || "";
  }
}

async function seekTo(milliseconds) {
  await getActiveVideoState();
  if (!activeTabId) return;
  const seconds = milliseconds / 1000;
  let result = await chrome.tabs.sendMessage(activeTabId, {
    action: "seekToKnowledgeTime",
    seconds,
  }).catch(() => null);

  if (!result?.success) {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: (targetSeconds) => {
        const video = document.querySelector("video.html5-main-video, #movie_player video");
        if (!video) return false;
        video.currentTime = Math.max(0, Number(targetSeconds) || 0);
        void video.play();
        return true;
      },
      args: [seconds],
    }).catch(() => []);
    result = { success: Boolean(injection?.[0]?.result) };
  }
  const status = document.getElementById("noteDocumentStatus");
  if (status) {
    status.textContent = result?.success
      ? `已跳转到 ${formatTime(milliseconds)} 并开始播放。`
      : "无法控制视频，请刷新 YouTube 页面后再试。";
  }
}

async function saveWhiteboard() {
  clearTimeout(noteSaveTimer);
  if (!activeVideoId) return;
  const editor = document.getElementById("noteDocument");
  const status = document.getElementById("noteDocumentStatus");
  try {
    currentNoteDocument = await ICRStorage.saveNoteDocument(
      activeVideoId,
      editor.value,
    );
    status.textContent = "已自动保存。";
  } catch (error) {
    console.error("[沉浸式字幕朗读器] 保存 Notes 白板失败：", error);
    status.textContent = "保存失败，请重新加载插件后再试。";
  }
}

function scheduleWhiteboardSave() {
  const status = document.getElementById("noteDocumentStatus");
  status.textContent = "正在自动保存…";
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(() => void saveWhiteboard(), 500);
}

function getWhiteboardBody() {
  return document.getElementById("noteDocument")?.value || currentNoteDocument?.body || "";
}

function buildExport(format) {
  const segments = currentTranscript?.segments || [];
  const lines = [];
  if (format === "markdown") {
    lines.push(`# ${currentVideo?.title || "视频知识原料包"}`, "");
    lines.push(`- URL：${currentVideo?.url || ""}`);
    lines.push(`- YouTube Video ID：${activeVideoId}`, "", "## 中文字幕", "");
    segments.forEach((segment) => lines.push(`- [${formatTime(segment.startMs)}] ${segment.textZh}`));
    lines.push("", "## Notes", "");
    [...currentNotes]
      .sort((left, right) => left.timestampMs - right.timestampMs)
      .forEach((note) => {
        lines.push(`- [${formatTime(note.timestampMs)}] ${note.text}`);
        if (note.comment) lines.push(`  - 我的想法：${note.comment}`);
      });
    if (getWhiteboardBody()) {
      lines.push("", "## 我的心得与想法", "", getWhiteboardBody());
    }
  } else {
    lines.push(currentVideo?.title || "视频知识原料包");
    lines.push(currentVideo?.url || "", `YouTube Video ID: ${activeVideoId}`, "", "中文字幕", "");
    segments.forEach((segment) => lines.push(`[${formatTime(segment.startMs)}] ${segment.textZh}`));
    lines.push("", "Notes", "");
    [...currentNotes]
      .sort((left, right) => left.timestampMs - right.timestampMs)
      .forEach((note) => {
        lines.push(`[${formatTime(note.timestampMs)}] ${note.text}`);
        if (note.comment) lines.push(`我的想法：${note.comment}`);
      });
    if (getWhiteboardBody()) {
      lines.push("", "我的心得与想法", "", getWhiteboardBody());
    }
  }
  return lines.join("\n");
}

function buildNotesExport(format) {
  const lines = [];
  if (format === "markdown") {
    lines.push(`# ${currentVideo?.title || "视频笔记"}`, "");
    lines.push(`- URL：${currentVideo?.url || ""}`, "", "## 时间戳笔记", "");
    [...currentNotes]
      .sort((left, right) => left.timestampMs - right.timestampMs)
      .forEach((note) => {
        lines.push(`- [${formatTime(note.timestampMs)}] **${note.text}**`);
        if (note.comment) lines.push(`  - 我的想法：${note.comment}`);
      });
    lines.push("", "## 我的心得与想法", "", getWhiteboardBody());
  } else {
    lines.push(currentVideo?.title || "视频笔记", currentVideo?.url || "", "", "时间戳笔记", "");
    [...currentNotes]
      .sort((left, right) => left.timestampMs - right.timestampMs)
      .forEach((note) => {
        lines.push(`[${formatTime(note.timestampMs)}] ${note.text}`);
        if (note.comment) lines.push(`我的想法：${note.comment}`, "");
      });
    lines.push("", "我的心得与想法", "", getWhiteboardBody());
  }
  return lines.join("\n");
}

function downloadExport(format) {
  const extension = format === "markdown" ? "md" : "txt";
  const blob = new Blob([buildExport(format)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${(currentVideo?.title || "video-knowledge").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80)}.${extension}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadNotes(format) {
  const extension = format === "markdown" ? "md" : "txt";
  const blob = new Blob([buildNotesExport(format)], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${(currentVideo?.title || "video-notes").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80)}-Notes.${extension}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    document.querySelectorAll(".panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.panel === button.dataset.tab);
    });
  });
});
document.getElementById("exportTxt").addEventListener("click", () => downloadExport("txt"));
document.getElementById("exportMarkdown").addEventListener("click", () => downloadExport("markdown"));
document.getElementById("exportNotesTxt").addEventListener("click", () => downloadNotes("txt"));
document.getElementById("exportNotesMarkdown").addEventListener("click", () => downloadNotes("markdown"));
document.getElementById("noteDocument").addEventListener("input", scheduleWhiteboardSave);
document.getElementById("noteDocument").addEventListener("blur", () => void saveWhiteboard());
chrome.storage.onChanged.addListener(() => {
  const activeEditor = document.activeElement;
  if (
    activeEditor?.id === "noteDocument" ||
    activeEditor?.classList?.contains("note-comment")
  ) {
    return;
  }
  void loadData();
});
chrome.tabs.onActivated.addListener(() => void loadData());
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status === "complete")) void loadData();
});
void loadData();

globalThis.__ICR_PANEL_TESTING__ = { formatTime, extractVideoId };
