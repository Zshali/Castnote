const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createStorageHarness() {
  const records = {};
  const chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: records[key] };
        },
        async set(values) {
          Object.assign(records, JSON.parse(JSON.stringify(values)));
        },
      },
    },
  };
  const context = vm.createContext({ chrome, console, Date });
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "storage.js"),
    "utf8",
  );
  vm.runInContext(source, context);
  return { storage: context.ICRStorage, records };
}

test("growing Immersive Translate cue updates one segment", () => {
  const { storage } = createStorageHarness();
  const first = storage.mergeCaptionSegment([], {
    videoId: "video-1",
    textZh: "这是一个",
    startMs: 1000,
    observedAt: "2026-09-09T10:00:00.000Z",
  });
  const second = storage.mergeCaptionSegment(first.segments, {
    videoId: "video-1",
    textZh: "这是一个完整句子",
    startMs: 1800,
    observedAt: "2026-09-09T10:00:01.000Z",
  });

  assert.equal(second.action, "extended");
  assert.equal(second.segments.length, 1);
  assert.equal(second.segments[0].textZh, "这是一个完整句子");
  assert.equal(second.segments[0].startMs, 1000);
});

test("rolling caption window stores only its unseen suffix", () => {
  const { storage } = createStorageHarness();
  const first = storage.mergeCaptionSegment([], {
    videoId: "video-1",
    textZh: "今天我们学习知识管理",
    startMs: 1000,
  });
  const second = storage.mergeCaptionSegment(first.segments, {
    videoId: "video-1",
    textZh: "知识管理可以帮助长期积累",
    startMs: 7000,
  });

  assert.equal(second.action, "overlap-appended");
  assert.equal(second.segments.length, 2);
  assert.equal(second.segments[1].textZh, "可以帮助长期积累");
  assert.equal(second.segments[1].sequence, 1);
});

test("video and transcript records persist with schema and source metadata", async () => {
  const { storage } = createStorageHarness();
  const video = await storage.upsertVideo({
    youtubeVideoId: "abc123",
    title: "测试视频",
    url: "https://www.youtube.com/watch?v=abc123",
    durationMs: 120000,
  });
  await storage.setCaptureStatus("abc123", "recording");
  const result = await storage.saveCaptionSnapshot({
    videoId: "abc123",
    textZh: "第一段中文字幕",
    startMs: 2500,
  });

  assert.equal(video.schemaVersion, 1);
  assert.equal(video.id, "video:abc123");
  assert.equal(result.transcript.source, "immersive-translate");
  assert.equal(result.transcript.targetLanguage, "zh-CN");
  assert.equal(result.transcript.segments[0].timeAccuracy, "estimated");
  assert.equal(result.transcript.segments[0].startMs, 2500);
});

test("manifest loads storage before the page controller", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.permissions, ["storage", "tabs", "sidePanel", "scripting"]);
  assert.deepEqual(manifest.host_permissions, ["https://www.youtube.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, ["storage.js", "content.js"]);
});

test("notes persist with video and subtitle evidence references", async () => {
  const { storage } = createStorageHarness();
  const note = await storage.saveNote({
    videoId: "abc123",
    timestampMs: 42000,
    text: "这是一条用户自己的判断。",
    segmentIds: ["segment:abc123:40000:evidence"],
  });
  const notes = await storage.getNotes("abc123");

  assert.equal(notes.length, 1);
  assert.equal(note.videoId, "video:abc123");
  assert.equal(note.timestampMs, 42000);
  assert.deepEqual(
    JSON.parse(JSON.stringify(note.segmentIds)),
    ["segment:abc123:40000:evidence"],
  );
});

test("a continuous note document persists separately for each video", async () => {
  const { storage } = createStorageHarness();
  await storage.saveNoteDocument("abc123", "我的理解\n\n下一步行动");
  const noteDocument = await storage.getNoteDocument("abc123");

  assert.equal(noteDocument.id, "note-document:abc123");
  assert.equal(noteDocument.videoId, "video:abc123");
  assert.equal(noteDocument.body, "我的理解\n\n下一步行动");
});

test("handwritten thoughts persist under a captured video note", async () => {
  const { storage } = createStorageHarness();
  const note = await storage.saveNote({
    videoId: "abc123",
    timestampMs: 99000,
    text: "屏幕抓取的中文字幕",
  });
  await storage.updateNoteComment("abc123", note.id, "这是我自己的判断。");
  const notes = await storage.getNotes("abc123");

  assert.equal(notes[0].text, "屏幕抓取的中文字幕");
  assert.equal(notes[0].comment, "这是我自己的判断。");
});
