// Loads the extension in Chromium with a mocked Marinara runtime and checks:
// 1) scanChat turns the model's JSON into voice blocks with 역할/사용 언어 lines
// 2) a manual /api/translate request uses the live preset text (not the stale field) plus voice notes and the persona name
const fs = require("fs");
const { chromium } = require("playwright");
const file = process.argv[2];
const code = fs.readFileSync(file, "utf8");

(async () => {
  let failed = 0;
  const check = (label, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };

  // ---- 1. scanChat in isolation ----
  const start = code.indexOf("  async function scanChat(");
  const end = code.indexOf("  /* ---------- render scheduling");
  const scanSrc = code.slice(start, end);
  const speechStart = code.indexOf("  const SCAN_SPEECH = `");
  const speechEnd = code.indexOf("  const SCAN_WORLD = `");
  const fake = {
    characters: [
      { character: "Mina", age: "24", relations: "Ethan: 연인", language: "", speech: "- 반말", samples: ["뭐야", "됐어"] },
      { character: "Ethan", age: "27", relations: "Mina: 연인", language: "영어 (한국어는 서툶)", speech: "- 반말, 짧게", samples: ["Hey."] },
      { character: "Pierre", age: "", relations: "", language: "프랑스어 (추정)", speech: "- 존댓말", samples: [] },
    ],
  };
  let seenSystem = "";
  const harness = new Function("deps", `
    const { collectMaterial, llm, getChat, getPersona, parseJsonLoose, targetLang, SCAN_GLOSSARY, SCAN_WORLD } = deps;
${code.slice(speechStart, speechEnd)}
${code.slice(code.indexOf("  function cleanEntries("), code.indexOf("  /* ---------- rendered-DOM paragraphs"))}
${scanSrc}
    return scanChat;`);
  const scanChat = harness({
    collectMaterial: async () => "material",
    llm: async (system) => { seenSystem = system; return JSON.stringify(fake); },
    getChat: async () => ({ personaId: "p1" }),
    getPersona: async () => ({ name: "mina" }),
    parseJsonLoose: JSON.parse,
    targetLang: () => "Korean",
    SCAN_GLOSSARY: "", SCAN_WORLD: "",
  });
  const out = await scanChat("chat1", "speech");
  console.log(out.map((e) => `[${e.name}]\n${e.style}`).join("\n\n"));
  check("scan prompt asks for language", /"language" is written in Korean/.test(seenSystem) && seenSystem.includes('"language":""'));
  check("persona marked (case-insensitive)", out[0].style.startsWith("- 역할: 유저 페르소나"));
  check("non-persona not marked", !out[1].style.includes("역할"));
  check("empty language omitted", !out[0].style.includes("사용 언어"));
  check("language line written", out[1].style.includes("- 사용 언어: 영어 (한국어는 서툶)"));
  check("(추정) kept for review", out[2].style.includes("- 사용 언어: 프랑스어 (추정)"));

  // ---- 1b. syncSourceToEdits in isolation ----
  {
    const fnSrc = code.slice(code.indexOf("  async function syncSourceToEdits("), code.indexOf("  async function setMessageView("));
    const calls = { patch: null, saved: null, llmUser: "" };
    const content = "First paragraph stays.\n\n*It was thirty-one degrees.*\n\n마르첼로 | \"Ciao.\" (안녕.)";
    const sync = new Function("deps", `
      const { currentMessage, messageCache, blockKey, stripMarks, llm, api, setCachedContent, getRecord, saveRecord } = deps;
      const SYNC_SOURCE_SYSTEM = "system";
      ${fnSrc}
      return syncSourceToEdits;`)({
      currentMessage: () => ({ id: "m1", content }),
      messageCache: new Map(),
      blockKey: (s) => s.replace(/[*_]/g, "").replace(/\s+/g, " ").trim(),
      stripMarks: (s) => s,
      llm: async (system, user) => { calls.llmUser = user; return "*It was thirty-two degrees.*"; },
      api: async (path, opts) => { calls.patch = { path, body: opts.body }; return {}; },
      setCachedContent: () => {},
      getRecord: () => ({ v: 1, map: { "It was thirty-one degrees.": "서른한 도였다." }, edited: {}, view: "", at: 1 }),
      saveRecord: async (c, m, rec) => { calls.saved = rec; },
    });
    const n = await sync("c1", "m1", { "It was thirty-one degrees.": "32도였다." }, { "It was thirty-one degrees.": "서른한 도였다." });
    check("source sync rewrites only the edited paragraph", n === 1 && calls.patch?.body.content === "First paragraph stays.\n\n*It was thirty-two degrees.*\n\n마르첼로 | \"Ciao.\" (안녕.)");
    check("source sync sends old and corrected Korean", calls.llmUser.includes("서른한 도였다.") && calls.llmUser.includes("32도였다."));
    check("translation moved to the new paragraph key", calls.saved?.map["It was thirty-two degrees."] === "32도였다." && !("It was thirty-one degrees." in calls.saved.map) && calls.saved.edited["It was thirty-two degrees."] === 1);
  }

  // ---- 1c. unitKind: dialogue already paired with a Korean translation is not re-sent ----
  {
    const pick = (a, b) => code.slice(code.indexOf(a), code.indexOf(b));
    const { unitKind } = new Function(`${[
      pick("  function langScript(", "  function normalizeForKey("),
      pick("  function stripMarks(", "  /** Rebuilds translated text"),
      pick("  function unitKind(", "  function fallbackRoot("),
    ].join("\n")}; return { unitKind };`)();
    check("paired dialogue with speaker label kept", unitKind('마르첼로 | <x1>"Did you practice that line on the plane, tesoro?"</x1> (비행기에서 연습이라도 했어, 자기?)', "Korean") === "same");
    check("paired dialogue inside raw speaker tag kept", unitKind('<speaker="로렌조">로렌조 | "Allora cercate meglio, nemmeno a Napoli."</speaker> (그럼 더 똑바로 찾아.)', "Korean") === "same");
    check("foreign line without translation still sent", unitKind('루카 | "Che ha detto? Inglese?"', "Korean") === "text");
    check("narration around a paired line still sent", unitKind('He smiled. "Come here." (이리 와.)', "Korean") === "text");
    check("pairing rule only for Korean targets", unitKind('마르첼로 | "Come here." (이리 와.)', "Japanese") === "text");
  }

  // ---- 2. full extension in a page ----
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route("http://marinara.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto("http://marinara.test/");
  const voice = "[Mina]\n- 역할: 유저 페르소나\n- 반말\n\n[Ethan]\n- 사용 언어: 영어 (한국어는 서툶)\n- 반말";
  const translateWith = (page, presetId) => page.evaluate(async ({ code, voice, presetId }) => {
    const sent = [];
    const realFetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/translate")) {
        sent.push(JSON.parse(init?.body ?? (await input.text())));
        return new Response(JSON.stringify({ translatedText: "ok" }), { status: 200 });
      }
      if (url.includes("/chats/c1")) return new Response(JSON.stringify({ id: "c1", personaId: "p1" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/personas/p1")) return new Response(JSON.stringify({ id: "p1", name: "Mina" }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    window.fetch = realFetch;
    localStorage.setItem("marinara-active-chat-id", "c1");
    const config = {
      defaults: {
        incomingPresetId: presetId,
        freeContextEnabled: true,
        freeContext: "STYLE-RULE: never use 계집.",
        incomingVoiceEnabled: true,
        incomingVoicePrompt: voice,
      },
    };
    window.marinara = {
      extension: { id: "test" },
      storage: { get: async () => ({ config }), patch: async (v) => v },
      onCleanup() {}, log: { warn: (...a) => console.log("warn", ...a), info() {} },
      setInterval: (f, t) => setInterval(f, t), clearInterval: (i) => clearInterval(i),
      setTimeout: (f, t) => setTimeout(f, t), clearTimeout: (i) => clearTimeout(i),
    };
    (0, eval)(code);
    await new Promise((r) => setTimeout(r, 300));
    await window.fetch("/api/translate", {
      method: "POST",
      body: JSON.stringify({ provider: "ai", text: "\"Hey,\" Ethan said. She smiled.", targetLanguage: "Korean", systemPrompt: "STALE OLD PROMPT", connectionId: "c1" }),
    });
    return sent;
  }, { code, voice, presetId });
  const result = await translateWith(page, "builtin-korean-style-foreign-dialogue-generate");
  const keepPage = await browser.newPage();
  await keepPage.route("http://marinara.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await keepPage.goto("http://marinara.test/");
  const keepResult = await translateWith(keepPage, "builtin-korean-style-keep-model-dialogue");
  await browser.close();
  const keepSp = (keepResult[keepResult.length - 1] || {}).systemPrompt || "";
  check("keep-model-dialogue preset used live, with persona", keepSp.includes("Copy such a line exactly as written") && keepSp.includes("persona is named \"Mina\"") && !keepSp.includes("STALE OLD PROMPT"));
  check("keep-model-dialogue preset protects originals and markers", keepSp.includes("Never change a word inside the quoted original") && keepSp.includes("markers such as <x1>…</x1>") && keepSp.includes("Ignore the speaker label"));
  check("기타 지침 sent as style instructions, not reference-only", keepSp.includes("# User Translation Style Instructions\n") && keepSp.includes("STYLE-RULE: never use 계집.") && !keepSp.includes("Reference Only"));
  const req = result[result.length - 1] || {};
  const sp = req.systemPrompt || "";
  check("request intercepted", !!sp);
  check("stale field prompt replaced by live preset", !sp.includes("STALE OLD PROMPT") && sp.includes("write it in that language yourself"));
  check("voice notes with 사용 언어 appended", sp.includes("# Character Voice Instructions") && sp.includes("- 사용 언어: 영어"));
  check("persona name injected", sp.includes("# User Persona") && sp.includes("persona is named \"Mina\""));
  check("system prompt under 5000 chars (no raw fallback needed)", sp.length < 5000);
  console.log("system prompt length:", sp.length);
  process.exit(failed ? 1 : 0);
})();
