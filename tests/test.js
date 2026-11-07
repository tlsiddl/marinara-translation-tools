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
