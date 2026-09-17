const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHelpers() {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "content.js"), "utf8");
  const fakeElement = {
    observe() {},
    addEventListener() {},
  };
  const context = vm.createContext({
    console,
    URLSearchParams,
    location: { search: "?v=test" },
    document: {
      documentElement: fakeElement,
      querySelector() { return null; },
      getElementById() { return null; },
      addEventListener() {},
    },
    window: { addEventListener() {} },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
    },
    ICRStorage: {},
    speechSynthesis: { addEventListener() {} },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    clearTimeout() {},
    setTimeout() { return 1; },
  });
  vm.runInContext(source, context);
  return context.__ICR_TESTING__;
}

test("caption text is normalized", () => {
  const { normalizeCaptionText } = loadHelpers();
  assert.equal(normalizeCaptionText("  你好   世界 \n"), "你好 世界");
});

test("duplicate spoken and queued captions are rejected", () => {
  const { shouldQueueCaption } = loadHelpers();
  assert.equal(shouldQueueCaption("你好", ["你好"], []), false);
  assert.equal(shouldQueueCaption("下一句", [], ["下一句"]), false);
  assert.equal(shouldQueueCaption("新的字幕", ["你好"], []), true);
});

test("note timestamps are formatted for the player confirmation", () => {
  const { formatNoteTime } = loadHelpers();
  assert.equal(formatNoteTime(19000), "0:19");
  assert.equal(formatNoteTime(754000), "12:34");
});
