(() => {
  "use strict";

  const SCHEMA_VERSION = 1;
  const VIDEO_PREFIX = "icr_video_";
  const TRANSCRIPT_PREFIX = "icr_transcript_";
  const NOTES_PREFIX = "icr_notes_";
  const NOTE_DOCUMENT_PREFIX = "icr_note_document_";

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function hashText(text) {
    let hash = 2166136261;
    for (const character of normalizeText(text)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function transcriptIdFor(videoId) {
    return `transcript:${videoId}:immersive-translate:zh-CN`;
  }

  function videoKey(videoId) {
    return `${VIDEO_PREFIX}${videoId}`;
  }

  function transcriptKey(videoId) {
    return `${TRANSCRIPT_PREFIX}${transcriptIdFor(videoId)}`;
  }

  function notesKey(videoId) {
    return `${NOTES_PREFIX}${videoId}`;
  }

  function noteDocumentKey(videoId) {
    return `${NOTE_DOCUMENT_PREFIX}${videoId}`;
  }

  function makeSegmentId(videoId, startMs, text) {
    return `segment:${videoId}:${startMs}:${hashText(text)}`;
  }

  function findSuffixPrefixOverlap(previousText, nextText) {
    const previous = normalizeText(previousText);
    const next = normalizeText(nextText);
    const max = Math.min(previous.length, next.length);
    for (let length = max; length >= 4; length -= 1) {
      if (previous.slice(-length) === next.slice(0, length)) return length;
    }
    return 0;
  }

  /**
   * Turns Immersive Translate's rolling caption snapshots into stable segments.
   * A growing cue updates the last segment; a rolling window stores only its new
   * suffix; a genuinely new cue becomes a new segment.
   */
  function mergeCaptionSegment(segments, snapshot) {
    const text = normalizeText(snapshot?.textZh);
    if (!text) return { segments, changed: false, action: "ignored" };

    const next = Array.isArray(segments) ? segments.map((item) => ({ ...item })) : [];
    const last = next.at(-1);
    const startMs = Math.max(0, Math.floor(Number(snapshot.startMs) || 0));
    const observedAt = snapshot.observedAt || new Date().toISOString();

    if (last) {
      if (last.textZh === text || last.contentHash === hashText(text)) {
        return { segments, changed: false, action: "duplicate" };
      }

      const closeInTime = startMs - last.startMs <= 5000;
      if (closeInTime && text.startsWith(last.textZh)) {
        last.textZh = text;
        last.contentHash = hashText(text);
        last.updatedAt = observedAt;
        return { segments: next, changed: true, action: "extended" };
      }
      if (closeInTime && last.textZh.startsWith(text)) {
        return { segments, changed: false, action: "older-version" };
      }

      const overlap = findSuffixPrefixOverlap(last.textZh, text);
      if (overlap) {
        const remainder = normalizeText(text.slice(overlap));
        if (!remainder) return { segments, changed: false, action: "duplicate" };
        const segment = {
          id: makeSegmentId(snapshot.videoId, startMs, remainder),
          videoId: snapshot.videoId,
          transcriptId: transcriptIdFor(snapshot.videoId),
          sequence: next.length,
          startMs,
          endMs: null,
          sourceText: null,
          textZh: remainder,
          source: "immersive-translate",
          contentHash: hashText(remainder),
          timeAccuracy: "estimated",
          capturedAt: observedAt,
          updatedAt: observedAt,
        };
        next.push(segment);
        return { segments: next, changed: true, action: "overlap-appended" };
      }
    }

    const segment = {
      id: makeSegmentId(snapshot.videoId, startMs, text),
      videoId: snapshot.videoId,
      transcriptId: transcriptIdFor(snapshot.videoId),
      sequence: next.length,
      startMs,
      endMs: null,
      sourceText: null,
      textZh: text,
      source: "immersive-translate",
      contentHash: hashText(text),
      timeAccuracy: "estimated",
      capturedAt: observedAt,
      updatedAt: observedAt,
    };
    next.push(segment);
    return { segments: next, changed: true, action: "appended" };
  }

  async function upsertVideo(input) {
    const key = videoKey(input.youtubeVideoId);
    const stored = await chrome.storage.local.get(key);
    const now = new Date().toISOString();
    const previous = stored[key] || {};
    const video = {
      schemaVersion: SCHEMA_VERSION,
      id: `video:${input.youtubeVideoId}`,
      youtubeVideoId: input.youtubeVideoId,
      title: input.title || previous.title || "未命名视频",
      url: input.url,
      channel: input.channel || previous.channel || "",
      durationMs: Number.isFinite(input.durationMs)
        ? input.durationMs
        : previous.durationMs || null,
      createdAt: previous.createdAt || now,
      updatedAt: now,
    };
    await chrome.storage.local.set({ [key]: video });
    return video;
  }

  async function getVideo(videoId) {
    const key = videoKey(videoId);
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  async function getTranscript(videoId) {
    const key = transcriptKey(videoId);
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  async function ensureTranscript(videoId) {
    const existing = await getTranscript(videoId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const transcript = {
      schemaVersion: SCHEMA_VERSION,
      id: transcriptIdFor(videoId),
      videoId: `video:${videoId}`,
      source: "immersive-translate",
      sourceLanguage: null,
      targetLanguage: "zh-CN",
      captureStatus: "idle",
      segments: [],
      createdAt: now,
      updatedAt: now,
    };
    await chrome.storage.local.set({ [transcriptKey(videoId)]: transcript });
    return transcript;
  }

  async function setCaptureStatus(videoId, captureStatus) {
    const transcript = await ensureTranscript(videoId);
    transcript.captureStatus = captureStatus;
    transcript.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [transcriptKey(videoId)]: transcript });
    return transcript;
  }

  async function saveCaptionSnapshot(snapshot) {
    const transcript = await ensureTranscript(snapshot.videoId);
    const result = mergeCaptionSegment(transcript.segments, snapshot);
    if (!result.changed) return { transcript, ...result };
    transcript.segments = result.segments;
    transcript.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [transcriptKey(snapshot.videoId)]: transcript });
    return { transcript, ...result };
  }

  async function getNotes(videoId) {
    const key = notesKey(videoId);
    const stored = await chrome.storage.local.get(key);
    return stored[key] || [];
  }

  async function saveNote(input) {
    const key = notesKey(input.videoId);
    const notes = await getNotes(input.videoId);
    const now = new Date().toISOString();
    const note = {
      schemaVersion: SCHEMA_VERSION,
      id: `note:${input.videoId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      videoId: `video:${input.videoId}`,
      timestampMs: Math.max(0, Math.floor(Number(input.timestampMs) || 0)),
      text: normalizeText(input.text),
      comment: String(input.comment || ""),
      segmentIds: Array.isArray(input.segmentIds) ? input.segmentIds : [],
      createdAt: now,
      updatedAt: now,
    };
    const updated = [note, ...notes].slice(0, 500);
    await chrome.storage.local.set({ [key]: updated });
    return note;
  }

  async function deleteNote(videoId, noteId) {
    const key = notesKey(videoId);
    const notes = await getNotes(videoId);
    const updated = notes.filter((note) => note.id !== noteId);
    await chrome.storage.local.set({ [key]: updated });
    return updated;
  }

  async function updateNoteComment(videoId, noteId, comment) {
    const key = notesKey(videoId);
    const notes = await getNotes(videoId);
    const now = new Date().toISOString();
    const updated = notes.map((note) =>
      note.id === noteId
        ? { ...note, comment: String(comment || ""), updatedAt: now }
        : note,
    );
    await chrome.storage.local.set({ [key]: updated });
    return updated;
  }

  async function getNoteDocument(videoId) {
    const key = noteDocumentKey(videoId);
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  async function saveNoteDocument(videoId, body) {
    const key = noteDocumentKey(videoId);
    const previous = await getNoteDocument(videoId);
    const now = new Date().toISOString();
    const noteDocument = {
      schemaVersion: SCHEMA_VERSION,
      id: `note-document:${videoId}`,
      videoId: `video:${videoId}`,
      body: String(body || ""),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    await chrome.storage.local.set({ [key]: noteDocument });
    return noteDocument;
  }

  globalThis.ICRStorage = Object.freeze({
    SCHEMA_VERSION,
    transcriptIdFor,
    hashText,
    findSuffixPrefixOverlap,
    mergeCaptionSegment,
    upsertVideo,
    getVideo,
    getTranscript,
    ensureTranscript,
    setCaptureStatus,
    saveCaptionSnapshot,
    getNotes,
    saveNote,
    deleteNote,
    updateNoteComment,
    getNoteDocument,
    saveNoteDocument,
  });
})();
