const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");

test("side panel exposes transcript, notes, timestamp, and export controls", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /data-panel="transcript"/);
  assert.match(html, /data-panel="notes"/);
  assert.match(html, /id="noteDocument"/);
  assert.match(html, /id="exportNotesTxt"/);
  assert.match(html, /id="exportNotesMarkdown"/);
  assert.match(html, /id="exportTxt"/);
  assert.match(html, /id="exportMarkdown"/);
  assert.match(js, /action: "seekToKnowledgeTime"/);
  assert.match(js, /ICRStorage\.getNotes/);
});

test("notes use a continuous autosaved whiteboard", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /Notes 白板/);
  assert.match(js, /saveNoteDocument/);
  assert.match(js, /scheduleWhiteboardSave/);
  assert.match(js, /buildNotesExport/);
  assert.match(js, /updateNoteComment/);
  assert.match(js, /chrome\.scripting\.executeScript/);
});

test("manifest registers a service worker and side panel", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
});

test("player controls can open the knowledge side panel", () => {
  const content = read("content.js");
  const background = read("background.js");
  assert.match(content, /class="icr-open-panel"/);
  assert.match(content, /action: "openKnowledgePanel"/);
  assert.match(background, /message\.action !== "openKnowledgePanel"/);
  assert.match(background, /chrome\.sidePanel[\s\S]*?\.open\(\{ tabId \}\)/);
});

test("player can save the current Chinese caption as a note", () => {
  const content = read("content.js");
  assert.match(content, /class="icr-note"/);
  assert.match(content, /saveVisibleCaptionNote/);
  assert.match(content, /ICRStorage\.saveNote/);
  assert.match(content, /event\.key\.toLowerCase\(\) !== "n"/);
});
