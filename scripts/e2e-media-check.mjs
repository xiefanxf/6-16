import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTRAIT_PRELOAD_URLS } from "../src/portraits.js";
import { SCENES } from "../src/story.js";

const runtimeModules = "/Users/xiefan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const require = createRequire(`${runtimeModules}/package.json`);
const { chromium } = require("playwright");

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const port = 4175;
const mime = {
  ".css": "text/css",
  ".html": "text/html",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".wav": "audio/wav",
};

const expectedAudio = [
  "ambient.m4a",
  "bell.m4a",
  "confrontation.m4a",
  "fact.m4a",
  "impact.m4a",
  "investigation.m4a",
  "memory-stinger.m4a",
  "memory.m4a",
  "rain-bed.m4a",
  "static.m4a",
];
const expectedImages = [...new Set([
  ...Object.values(SCENES),
  ...PORTRAIT_PRELOAD_URLS,
])];
const requiredHtmlHints = [
  { href: "./assets/classroom-preview.jpg", rel: "preload" },
  { href: "./assets/classroom-rain.jpg", rel: "preload" },
  { href: "./assets/records-room-rain.jpg", rel: "prefetch" },
  { href: "./assets/old-corridor-rain.jpg", rel: "prefetch" },
  { href: "./assets/portraits/generated/rin.png", rel: "prefetch" },
  { href: "./assets/portraits/generated/yuma.png", rel: "prefetch" },
];

function safePath(url) {
  const pathname = decodeURIComponent(new URL(url, `http://127.0.0.1:${port}`).pathname);
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = normalize(join(dist, requested));
  return resolved.startsWith(dist) ? resolved : null;
}

const server = createServer(async (request, response) => {
  const path = safePath(request.url ?? "/");
  if (!path) return response.writeHead(403).end("Forbidden");
  try {
    const body = await readFile(path);
    response.writeHead(200, { "Content-Type": mime[extname(path)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});

const observedAudio = new Map();
const findings = [];

async function lineText(page) {
  return ((await page.locator(".line").textContent()) ?? "").trim();
}

async function closeFactIfNeeded(page) {
  if (await page.getByRole("dialog", { name: "获得事实卡" }).count()) {
    await page.getByRole("button", { name: "收下事实", exact: true }).click();
    return true;
  }
  return false;
}

async function advance(page) {
  if (await closeFactIfNeeded(page)) return;
  await page.getByTestId("dialogue-advance").click();
}

async function advanceUntil(page, predicate, limit = 120, { allowChoices = false } = {}) {
  for (let step = 0; step < limit; step += 1) {
    const portraitCount = await page.locator(".character-portrait").count();
    const state = {
      line: await lineText(page),
      speaker: ((await page.locator(".speaker").textContent()) ?? "").trim(),
      choices: await page.locator(".choices button").allTextContents(),
      hasPortrait: portraitCount > 0,
      portraitLabel: portraitCount > 0 ? ((await page.locator(".portrait-caption strong").textContent()) ?? "").trim() : "",
    };
    if (predicate(state)) return state;
    if (state.choices.length && !allowChoices) throw new Error(`Unexpected choice while searching: ${state.choices.join(" | ")}`);
    await advance(page);
  }
  throw new Error("advanceUntil reached limit");
}

async function advanceUntilChoice(page, limit = 80) {
  return advanceUntil(page, (state) => state.choices.length > 0, limit, { allowChoices: true });
}

async function verifyImageDecoding(page, sources) {
  return page.evaluate(async (imageSources) => Promise.all(imageSources.map((source) => (
    new Promise((resolve) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve({ ok: image.naturalWidth > 0 && image.naturalHeight > 0, source });
      image.onerror = () => resolve({ ok: false, source });
      image.src = source;
    })
  ))), sources);
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" });
  page.on("response", (response) => {
    const marker = "/assets/audio/";
    const url = response.url();
    if (!url.includes(marker)) return;
    observedAudio.set(url.split(marker)[1], response.status());
  });

  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });
  const htmlHints = await page.locator("link[rel='preload'], link[rel='prefetch']").evaluateAll((links) => (
    links.map((link) => ({ href: link.getAttribute("href"), rel: link.getAttribute("rel") }))
  ));
  for (const hint of requiredHtmlHints) {
    if (!htmlHints.some((item) => item.href === hint.href && item.rel === hint.rel)) {
      findings.push(`Missing HTML ${hint.rel} hint: ${hint.href}`);
    }
  }

  const decodedImages = await verifyImageDecoding(page, expectedImages);
  decodedImages.filter((item) => !item.ok).forEach((item) => {
    findings.push(`Image failed to decode: ${item.source}`);
  });

  const skipOpening = page.getByRole("button", { name: "跳过", exact: true });
  if (await skipOpening.count()) await skipOpening.click();
  await page.getByRole("button", { name: /开始游戏/ }).click();
  await page.waitForTimeout(1200);

  const firstLine = await lineText(page);
  await page.locator(".scene-layer").click({ position: { x: 80, y: 80 } });
  const afterBackgroundClick = await lineText(page);
  if (afterBackgroundClick !== firstLine) findings.push("Background click advanced dialogue.");

  await advance(page);
  const yuma = await advanceUntil(page, (state) => state.speaker === "神谷悠真");
  if (!yuma.hasPortrait || yuma.portraitLabel !== "神谷悠真") findings.push("Yuma portrait did not render on his first line.");

  await advanceUntilChoice(page);
  await page.getByRole("button", { name: "“你们是谁？”", exact: true }).click();
  await advanceUntilChoice(page);
  await page.getByRole("button", { name: "检查主教学楼", exact: true }).click();

  const broadcast = await advanceUntil(page, (state) => state.speaker === "广播中的女声");
  if (broadcast.hasPortrait) findings.push("Broadcast voice rendered a character portrait.");

  const haruka = await advanceUntil(page, (state) => state.speaker.includes("夏见遥") || state.speaker === "未知女声");
  if (!haruka.hasPortrait) findings.push("Haruka memory line did not render a portrait.");

  await page.waitForTimeout(800);
  for (const file of expectedAudio) {
    if (observedAudio.get(file) !== 200) findings.push(`Audio asset not loaded with 200: ${file}`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const report = {
  audioLoaded: Object.fromEntries([...observedAudio.entries()].sort(([left], [right]) => left.localeCompare(right))),
  imageCount: expectedImages.length,
  findings,
  passed: findings.length === 0,
};

console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exitCode = 1;
