// Node-only checks for names from 세계관 설정집 (World Archive), no browser. The functions are cut out of extension.js and run with fake dependencies:
// 1) round trip: glossary → archive names (the glossary's own pairs plus one new pair) → glossary adds 1, then 0 and saves nothing the second time
// 2) an existing line is never changed, even when the archive's Korean (or English) name differs or only the case differs
// 3) 404, a failed request, a timeout-like rejection, or a malformed payload changes nothing and shows no notice
// 4) nothing runs before the stored config loaded; a chat without its own settings starts from the defaults, which stay as they were
// 5) NPC 자동 수집 asks for the names before its scans, and the chat-open / page-load paths call the sync
// Run: node tests/archive-names.test.js personal-extension/extension.js
const fs = require("fs");
const file = process.argv[2];
const code = fs.readFileSync(file, "utf8");

const cut = (from, to) => {
  const a = code.indexOf(from);
  const b = code.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`source markers not found: ${from} … ${to}`);
  return code.slice(a, b);
};

(async () => {
  let failed = 0;
  const check = (label, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !extra ? "" : ` — ${extra}`}`); if (!ok) failed++; };

  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  let server = async () => json({ names: [] });
  const requests = [];
  const notices = [];
  let writes = 0;

  const make = new Function("deps", `
    const { marinara, paragraph, fetch } = deps;
    const window = {};
    const originalFetch = { call: (_self, input, init) => fetch(input, init) };
    let storedConfig = deps.initial;
    const currentScope = (config, chatId) => ({ ...(config.chats[chatId] ?? config.defaults) });
    const queueConfigWrite = async (build) => { deps.wrote(); storedConfig = build(storedConfig); return storedConfig; };
${cut("  function parseGlossary(", "  function glossarySection(")}
${cut("  function glossaryIndex(", "  /* ---------- item editors for the glossary and voice notes")}
    return {
      syncArchiveNames, archiveNamePairs,
      ready: () => { archiveNamesReady = true; },
      config: () => storedConfig,
      setConfig: (c) => { storedConfig = c; },
    };`);
  const glossary = "Severus Snape = 세베루스 스네이프\nHogwarts = 호그와트\n미네르바 맥고나걸 = Minerva McGonagall";
  const initial = {
    chats: { c1: { glossary, incomingVoicePrompt: "", incomingVoiceEnabled: false } },
    defaults: { glossary: "Quidditch = 퀴디치", incomingVoicePrompt: "", incomingVoiceEnabled: false },
  };
  const t = make({
    marinara: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id), log: { warn() {} } },
    paragraph: { notify: (text) => notices.push(text) },
    fetch: (input, init) => { requests.push({ url: String(input), init }); return server(input, init); },
    initial: JSON.parse(JSON.stringify(initial)),
    wrote: () => { writes++; },
  });
  const snapshot = () => JSON.stringify(t.config());

  // 4a. not ready yet: no request at all
  server = async () => json({ names: [{ original: "Albus Dumbledore", translation: "알버스 덤블도어", kind: "인물" }] });
  check("before the stored config loaded nothing is fetched", (await t.syncArchiveNames("c1")) === 0 && requests.length === 0 && writes === 0);
  t.ready();

  // 1. round trip
  const fromGlossary = [
    { original: "Severus Snape", translation: "세베루스 스네이프", kind: "인물" },
    { original: "Hogwarts", translation: "호그와트", kind: "장소" },
    { original: "Minerva McGonagall", translation: "미네르바 맥고나걸", kind: "인물" },
  ];
  const archive = { names: [...fromGlossary, { original: "Albus Dumbledore", translation: "알버스 덤블도어", kind: "인물" }] };
  server = async () => json(archive);
  const first = await t.syncArchiveNames("c1");
  const afterFirst = t.config().chats.c1.glossary;
  check("the request is a same-origin GET of the room's names", requests.length === 1
    && requests[0].url === "/api/world-archive/rooms/c1/names"
    && (requests[0].init.method ?? "GET") === "GET" && requests[0].init.credentials === "same-origin", JSON.stringify(requests[0]));
  check("first round adds exactly the one new pair", first === 1 && afterFirst === `${glossary}\nAlbus Dumbledore = 알버스 덤블도어`, afterFirst);
  check("first round saves once and tells the user", writes === 1 && notices.length === 1 && notices[0] === "설정집에서 이름 1개를 단어장에 넣었어요", notices.join(" / "));
  const before = snapshot();
  const second = await t.syncArchiveNames("c1");
  check("second round adds 0, saves nothing, says nothing", second === 0 && writes === 1 && notices.length === 1 && snapshot() === before);

  // 2. existing lines win
  server = async () => json({ names: [
    { original: "Severus Snape", translation: "세브루스 스네이프", kind: "인물" },
    { original: "severus snape", translation: "스네이프 교수", kind: "인물" },
    { original: "Professor Snape", translation: "세베루스 스네이프", kind: "인물" },
    { original: "MINERVA MCGONAGALL", translation: "맥고나걸 교수", kind: "인물" },
  ] });
  check("a differing Korean name, a case-only match, or a shared Korean name changes nothing",
    (await t.syncArchiveNames("c1")) === 0 && snapshot() === before && writes === 1 && notices.length === 1);
  server = async () => json({ names: [
    { original: "Severus Snape", translation: "세브루스 스네이프" },
    { original: "Rubeus Hagrid", translation: "루비우스 해그리드" },
  ] });
  await t.syncArchiveNames("c1");
  const lines = t.config().chats.c1.glossary.split("\n");
  check("with a new pair beside a differing one, only the new line is added and old lines stay as they were",
    lines.length === 5 && lines.slice(0, 4).join("\n") === afterFirst && lines[4] === "Rubeus Hagrid = 루비우스 해그리드", lines.join(" | "));
  check("the notice counts only what was added", notices.length === 2 && notices[1] === "설정집에서 이름 1개를 단어장에 넣었어요");

  // 3. failures change nothing
  const steady = snapshot();
  const quiet = [
    ["404 (World Archive not installed)", async () => json({ error: "not found" }, 404)],
    ["500", async () => json({ names: [{ original: "Draco Malfoy", translation: "드레이코 말포이" }] }, 500)],
    ["a failed request", async () => { throw new TypeError("Failed to fetch"); }],
    ["an aborted request", async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }],
    ["a non-JSON body", async () => new Response("<html>nope</html>", { status: 200 })],
    ["names that is not a list", async () => json({ names: "Draco Malfoy = 드레이코 말포이" })],
    ["no names field", async () => json({ rooms: [] })],
    ["null", async () => json(null)],
    ["an empty list (room not linked)", async () => json({ names: [] })],
    ["entries without strings or with \"=\" / line breaks", async () => json({ names: [
      null, 3, { original: "Draco Malfoy" }, { translation: "드레이코 말포이" }, { original: 5, translation: "다섯" },
      { original: "A = B", translation: "에이" }, { original: "Ginny", translation: "지니\n= 위즐리" },
    ] })],
  ];
  for (const [label, handler] of quiet) {
    server = handler;
    const w = writes, n = notices.length;
    const got = await t.syncArchiveNames("c1");
    check(`${label}: nothing changes, no notice`, got === 0 && writes === w && notices.length === n && snapshot() === steady);
  }
  check("payload reader keeps only usable pairs", JSON.stringify(t.archiveNamePairs({ names: [{ original: " Luna Lovegood ", translation: " 루나 러브굿 " }, { original: "x=y", translation: "z" }] }))
    === JSON.stringify([{ src: "Luna Lovegood", dst: "루나 러브굿" }]));

  // 4b. a chat without its own settings
  server = async () => json({ names: [{ original: "Quidditch", translation: "퀴디치" }, { original: "Luna Lovegood", translation: "루나 러브굿" }] });
  const defaultsBefore = JSON.stringify(t.config().defaults);
  const c2 = await t.syncArchiveNames("c2");
  check("a chat on the default glossary gets its own glossary: defaults + the new name, defaults untouched",
    c2 === 1 && t.config().chats.c2.glossary === "Quidditch = 퀴디치\nLuna Lovegood = 루나 러브굿" && JSON.stringify(t.config().defaults) === defaultsBefore);
  check("no chat id: nothing is fetched", (await (async () => { const r = requests.length; await t.syncArchiveNames(""); await t.syncArchiveNames(null); return requests.length === r; })()));

  // 5a. NPC 자동 수집 runs the name sync first
  const timers = [];
  const log = [];
  const makeTick = new Function("deps", `
    const { scopeFor, collectApply, scanChat, notify, marinara, setTimeout, syncNames } = deps;
    let disposed = false;
${cut("  const autoCollectCounts = new Map();", "  /* ---------- toast ----------")}
    return { autoCollectTick };`);
  const tick = makeTick({
    scopeFor: () => ({ autoCollectEnabled: true, autoCollectEvery: 1 }),
    collectApply: async () => ({ voice: 0, glossary: 0 }),
    scanChat: async (chatId, kind) => { log.push(`${chatId}:${kind}`); return []; },
    notify: () => {},
    marinara: { log: { warn() {} } },
    setTimeout: (fn) => { timers.push(fn); },
    syncNames: async (chatId) => { log.push(`${chatId}:names`); return 0; },
  });
  tick.autoCollectTick("c1");
  while (timers.length) await timers.shift()();
  check("each NPC 자동 수집 run asks for the names, then scans", log.join() === "c1:names,c1:speech,c1:glossary", log.join());
  const brokenTick = makeTick({
    scopeFor: () => ({ autoCollectEnabled: true, autoCollectEvery: 1 }),
    collectApply: async () => ({ voice: 0, glossary: 0 }),
    scanChat: async (chatId, kind) => { log.push(`${chatId}:${kind}`); return []; },
    notify: () => {}, marinara: { log: { warn() {} } }, setTimeout: (fn) => { timers.push(fn); },
    syncNames: undefined,
  });
  log.length = 0;
  brokenTick.autoCollectTick("c1");
  while (timers.length) await timers.shift()();
  check("without a name sync the run still scans", log.join() === "c1:speech,c1:glossary");

  // 5b. wiring in the page bootstrap
  const checkActive = cut("  function checkActiveChat() {", "  // Coming back to the page");
  const load = code.slice(code.lastIndexOf("  void marinara.storage"));
  const onLoad = load.slice(0, load.indexOf("    .catch((error) => {"));
  const onLoadFailed = load.slice(load.indexOf("    .catch((error) => {"));
  check("opening a chat syncs its names", /activeChatId = nextChatId;[\s\S]*syncArchiveNames\(activeChatId\)/.test(checkActive));
  check("the page load syncs the open chat only after the config loaded",
    /storedConfig = normalizeStoredConfig\(value\?\.config\);[\s\S]*archiveNamesReady = true;[\s\S]*syncArchiveNames\(activeChatId\)/.test(onLoad)
    && onLoadFailed.length > 0 && !onLoadFailed.includes("archiveNamesReady"));
  check("the paragraph translator gets the sync", /collectApply: applyAutoCollected,\s*syncNames: syncArchiveNames,/.test(code));

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
