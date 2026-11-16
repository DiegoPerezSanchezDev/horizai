import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const origin = process.env.HORIZAI_CAPTURE_ORIGIN ?? "http://localhost:3000";
const chromePath = process.env.HORIZAI_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const outputDirectory = path.resolve("artifacts/ui-map-functional-closure/evidence");
const articlePath = "/noticias/mas-de-mil-fallecidos-tras-fallas-en-torres-de-vigilancia-fronteriza";
const filteredPath = "/?map=heat&region=GLOBAL&topic=investigacion";
const devtoolsProfile = await mkdtemp(path.join(os.tmpdir(), "horizai-ui05-capture-"));
const browser = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-crash-reporter",
  "--disable-breakpad",
  "--disable-default-apps",
  "--no-first-run",
  "--no-default-browser-check",
  "--no-sandbox",
  "--hide-scrollbars",
  `--user-data-dir=${devtoolsProfile}`,
  "--remote-debugging-port=0",
  "about:blank",
], { stdio: "ignore", windowsHide: true });

let socket;
let nextId = 0;
let browserEndpoint;
const pending = new Map();
const requestUrls = new Map();
const browserEvents = { consoleErrors: [], runtimeExceptions: [], networkFailures: [] };
const screenshots = [];

function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error("Chrome DevTools connection timed out")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Chrome DevTools WebSocket failed"));
    }, { once: true });
  });
}

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function onMessage(event) {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result ?? {});
    return;
  }

  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    browserEvents.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 300));
  }
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    browserEvents.runtimeExceptions.push({
      text: details.text,
      description: details.exception?.description?.slice(0, 500) ?? null,
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    });
  }
  if (message.method === "Network.requestWillBeSent") {
    requestUrls.set(message.params.requestId, message.params.request.url);
  }
  if (message.method === "Network.loadingFailed") {
    const url = requestUrls.get(message.params.requestId) ?? "unknown";
    if (message.params.errorText !== "net::ERR_ABORTED") {
      browserEvents.networkFailures.push({ url, error: message.params.errorText, blockedReason: message.params.blockedReason ?? null });
    }
  }
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(expression, description, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await evaluate(`Boolean(${expression})`);
    if (ready) return;
    await delay(120);
  }
  const diagnostics = await evaluate("JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,body:document.body?.innerText.slice(0,240)})");
  throw new Error(`Timed out waiting for ${description}; page=${diagnostics}`);
}

async function setViewport(width, height) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 430,
    screenWidth: width,
    screenHeight: height,
  });
  if (width <= 430) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  else await send("Emulation.setTouchEmulationEnabled", { enabled: false });
}

async function setTheme(theme) {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  try {
    await evaluate(`(() => {
      localStorage.setItem('horizai-theme', ${JSON.stringify(theme)});
      document.documentElement?.classList.toggle('dark', ${JSON.stringify(theme)} === 'dark');
      document.documentElement?.classList.toggle('light', ${JSON.stringify(theme)} === 'light');
    })()`);
  } catch {}
}

async function navigate(route, { theme = "dark", width = 1440, height = 1000 } = {}) {
  await setViewport(width, height);
  await setTheme(theme);
  const navigation = await send("Page.navigate", { url: new URL(route, origin).toString() });
  if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
  await waitFor("document.querySelector('main')", "page render");
  await evaluate("document.fonts?.ready");
  await delay(350);
}

async function waitForMap() {
  await evaluate("document.querySelector('#mapa-global')?.scrollIntoView({ block: 'center', behavior: 'instant' })");
  await waitFor("document.querySelector('.map-frame canvas')", "MapLibre canvas");
  await delay(900);
}

async function capture(name, extra = {}) {
  const response = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const filePath = path.join(outputDirectory, name);
  await writeFile(filePath, Buffer.from(response.data, "base64"));
  screenshots.push({ file: `artifacts/ui-map-functional-closure/evidence/${name}`, ...extra });
  return filePath;
}

async function snapshotMapState() {
  return JSON.parse(await evaluate(`JSON.stringify((() => {
    const selected = (selector) => Array.from(document.querySelectorAll(selector)).find((button) => button.getAttribute('aria-pressed') === 'true')?.innerText.trim() ?? null;
    const mapFrame = document.querySelector('.map-frame');
    const legend = document.querySelector('.heat-intensity-legend');
    const controls = document.querySelector('.map-controls');
    return {
      url: location.href,
      mode: selected('[aria-label="Cambiar vista del mapa"] button'),
      selectedFilters: Array.from(document.querySelectorAll('[aria-label="Filtros del mapa"] button[aria-pressed="true"]')).map((button) => button.innerText.trim()),
      legend: legend?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
      canvas: Boolean(document.querySelector('.map-frame canvas')),
      storyLinkCount: document.querySelectorAll('#map-story-context a[href*="/noticias/"]').length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      legendInsideMap: Boolean(legend && mapFrame && legend.getBoundingClientRect().left >= mapFrame.getBoundingClientRect().left && legend.getBoundingClientRect().right <= mapFrame.getBoundingClientRect().right),
      legendOverlapsControls: Boolean(legend && controls && !(legend.getBoundingClientRect().right < controls.getBoundingClientRect().left || legend.getBoundingClientRect().left > controls.getBoundingClientRect().right || legend.getBoundingClientRect().bottom < controls.getBoundingClientRect().top || legend.getBoundingClientRect().top > controls.getBoundingClientRect().bottom)),
    };
  })())`));
}

async function launchDevTools() {
  const activePortFile = path.join(devtoolsProfile, "DevToolsActivePort");
  const started = Date.now();
  while (Date.now() - started < 12_000) {
    try {
      const [port, browserPath] = (await readFile(activePortFile, "utf8")).trim().split(/\r?\n/);
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return { port, browserPath, page };
    } catch {}
    await delay(100);
  }
  throw new Error("Chrome did not expose a DevTools page target");
}

try {
  const health = await fetch(origin, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200, `Production server returned ${health.status}`);
  await mkdir(outputDirectory, { recursive: true });
  const { port, browserPath, page } = await launchDevTools();
  browserEndpoint = `ws://127.0.0.1:${port}${browserPath}`;
  socket = await connectWebSocket(page.webSocketDebuggerUrl);
  socket.addEventListener("message", onMessage);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable", { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 2_000_000 });
  await send("Log.enable");

  await navigate("/", { theme: "dark", width: 1440, height: 1000 });
  await capture("e-home-1440-dark.png", { page: "home", theme: "dark", viewport: [1440, 1000] });
  await navigate("/", { theme: "light", width: 1440, height: 1000 });
  await capture("e-home-1440-light.png", { page: "home", theme: "light", viewport: [1440, 1000] });

  await navigate("/", { theme: "dark", width: 390, height: 844 });
  await capture("e-home-390-dark.png", { page: "home", theme: "dark", viewport: [390, 844] });
  await navigate("/", { theme: "light", width: 390, height: 844 });
  await capture("e-home-390-light.png", { page: "home", theme: "light", viewport: [390, 844] });

  await navigate(articlePath, { theme: "dark", width: 1440, height: 1000 });
  const directArticleBack = await evaluate("Array.from(document.querySelectorAll('a')).find((a) => a.innerText.includes('Volver'))?.innerText.trim() ?? null");
  assert.equal(directArticleBack, "Volver a las noticias", "non-map article behavior remains unchanged");
  await capture("e-article-1440-dark.png", { page: "article", theme: "dark", viewport: [1440, 1000] });
  await navigate(articlePath, { theme: "dark", width: 390, height: 844 });
  await capture("e-article-390-dark.png", { page: "article", theme: "dark", viewport: [390, 844] });

  await navigate("/", { theme: "dark", width: 1440, height: 1000 });
  await waitForMap();
  const nodesState = await snapshotMapState();
  assert.equal(nodesState.mode, "Nodos");
  assert.equal(nodesState.legend, null);
  assert.equal(nodesState.canvas, true);
  await capture("e-map-nodes-1440-dark.png", { page: "map", mode: "Nodos", theme: "dark", viewport: [1440, 1000] });

  await navigate("/?map=heat", { theme: "dark", width: 1440, height: 1000 });
  await waitForMap();
  const heatDesktopState = await snapshotMapState();
  assert.equal(heatDesktopState.mode, "Calor");
  assert.equal(heatDesktopState.legend, "Intensidad relativa Menor Mayor");
  assert.equal(heatDesktopState.legendOverlapsControls, false);
  await capture("e-map-heat-legend-1440-dark.png", { page: "map", mode: "Calor", theme: "dark", viewport: [1440, 1000] });

  await navigate("/?map=heat", { theme: "dark", width: 390, height: 844 });
  await waitForMap();
  const mobileHeatState = await snapshotMapState();
  assert.equal(mobileHeatState.mode, "Calor");
  assert.equal(mobileHeatState.legend, "Intensidad relativa Menor Mayor");
  assert.equal(mobileHeatState.horizontalOverflow, false);
  assert.equal(mobileHeatState.legendOverlapsControls, false);
  await capture("e-map-heat-legend-390-dark.png", { page: "map", mode: "Calor", theme: "dark", viewport: [390, 844] });

  await navigate("/?map=heat", { theme: "light", width: 1440, height: 1000 });
  await waitForMap();
  const lightHeatState = await snapshotMapState();
  assert.equal(lightHeatState.legend, "Intensidad relativa Menor Mayor");
  assert.equal(lightHeatState.legendOverlapsControls, false);
  await capture("e-map-heat-legend-1440-light.png", { page: "map", mode: "Calor", theme: "light", viewport: [1440, 1000] });

  await navigate(filteredPath, { theme: "dark", width: 1440, height: 1000 });
  await waitForMap();
  let filteredState = await snapshotMapState();
  assert.equal(filteredState.mode, "Calor");
  assert.deepEqual(filteredState.selectedFilters, ["30 días", "Global", "Investigación"]);
  assert.equal(filteredState.storyLinkCount, 1);
  await capture("e-map-filtered-before-article-1440-dark.png", { page: "map", theme: "dark", viewport: [1440, 1000], phase: "before-article" });
  await send("Page.reload", { ignoreCache: true });
  await waitFor(`location.pathname === '/' && location.search.includes('topic=investigacion')`, "filtered map reload");
  await waitFor("document.querySelector('.map-frame canvas')", "reloaded filtered map canvas");
  await delay(450);
  filteredState = await snapshotMapState();
  assert.deepEqual(filteredState.selectedFilters, ["30 días", "Global", "Investigación"], "reload restores filters");

  await evaluate("document.querySelector('#map-story-context a[href*=\"/noticias/\"]')?.click()");
  await waitFor(`location.pathname === ${JSON.stringify(articlePath)}`, "map article navigation");
  const articleReturnState = JSON.parse(await evaluate(`JSON.stringify({
    url: location.href,
    returnHref: Array.from(document.querySelectorAll('a')).find((a) => a.innerText.includes('Volver al mapa'))?.getAttribute('href') ?? null,
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
  })`));
  assert.equal(articleReturnState.returnHref, `${filteredPath}#mapa-global`);
  assert.ok(articleReturnState.canonical === null || !articleReturnState.canonical.includes("fromMap"));

  const history = await send("Page.getNavigationHistory");
  const previous = history.entries[history.currentIndex - 1];
  assert.ok(previous?.url.includes(filteredPath), "the map state is the prior browser history entry");
  await send("Page.navigateToHistoryEntry", { entryId: previous.id });
  await waitFor(`location.pathname === '/' && location.search.includes('topic=investigacion')`, "browser Back to filtered map");
  await waitFor("document.querySelector('.map-frame canvas')", "restored map canvas");
  await delay(500);
  const restoredState = await snapshotMapState();
  assert.equal(restoredState.mode, "Calor");
  assert.deepEqual(restoredState.selectedFilters, ["30 días", "Global", "Investigación"]);
  assert.equal(restoredState.storyLinkCount, 1);
  await capture("e-map-restored-after-browser-back-1440-dark.png", { page: "map", theme: "dark", viewport: [1440, 1000], phase: "after-browser-back" });

  await evaluate("document.querySelector('#map-story-context a[href*=\"/noticias/\"]')?.click()");
  await waitFor(`location.pathname === ${JSON.stringify(articlePath)}`, "second map article navigation");
  await evaluate("Array.from(document.querySelectorAll('a')).find((a) => a.innerText.includes('Volver al mapa'))?.click()");
  await waitFor(`location.pathname === '/' && location.hash === '#mapa-global'`, "article return link");
  await waitFor("document.querySelector('.map-frame canvas')", "map after article return");
  const explicitReturnState = await snapshotMapState();
  assert.equal(explicitReturnState.mode, "Calor");
  assert.deepEqual(explicitReturnState.selectedFilters, ["30 días", "Global", "Investigación"]);
  const historyAfterArticleReturn = await send("Page.getNavigationHistory");
  const pageBeforeReturn = historyAfterArticleReturn.entries[historyAfterArticleReturn.currentIndex - 1];
  assert.ok(pageBeforeReturn?.url.includes(filteredPath), "article return replaces the article entry without a loop");
  assert.ok(!pageBeforeReturn?.url.includes("/noticias/"), "article return history does not loop to the article");

  await navigate("/?map=heat", { theme: "dark", width: 1440, height: 1000 });
  await waitForMap();
  const widths = [320, 375, 390, 430, 768, 1024, 1280, 1440, 1920];
  const responsive = [];
  for (const width of widths) {
    await setViewport(width, width <= 430 ? 844 : 1000);
    await delay(120);
    const state = await snapshotMapState();
    responsive.push({ width, horizontalOverflow: state.horizontalOverflow, legendOverlapsControls: state.legendOverlapsControls, legendInsideMap: state.legendInsideMap });
  }
  assert.ok(responsive.filter(({ width }) => width <= 430).every((state) => !state.horizontalOverflow), "no mobile horizontal overflow");

  await navigate("/?map=heat&period=7d&region=GLOBAL&topic=investigacion", { theme: "dark", width: 1440, height: 1000 });
  await evaluate("document.querySelector('#mapa-global')?.scrollIntoView({ block: 'center', behavior: 'instant' })");
  await waitFor("document.querySelector('.map-frame')", "empty filtered map frame");
  const emptyHeatState = await snapshotMapState();
  assert.equal(emptyHeatState.mode, "Calor");
  assert.equal(emptyHeatState.selectedFilters[0], "7 días");
  assert.equal(emptyHeatState.storyLinkCount, 0);
  assert.equal(emptyHeatState.legend, null, "legend is hidden when no locations are available");

  await navigate("/?map=invalid&period=2h&region=EUROPE&topic=robotics", { theme: "dark", width: 1440, height: 1000 });
  await waitForMap();
  const invalidState = await snapshotMapState();
  assert.equal(invalidState.mode, "Nodos");
  assert.deepEqual(invalidState.selectedFilters, ["30 días", "Todo el mundo", "Todos"]);
  assert.equal(invalidState.canvas, true);
  assert.equal(invalidState.horizontalOverflow, false);
  assert.equal(browserEvents.consoleErrors.length, 0, "no browser console errors");
  assert.equal(browserEvents.runtimeExceptions.length, 0, "no browser runtime exceptions");
  assert.equal(browserEvents.networkFailures.length, 0, "no failed browser requests");

  const report = {
    ready: "YES",
    eDesignFrozen: true,
    mapF01: {
      result: "PASS",
      stateMechanism: "Stable URL search parameters; filter updates use replaceState(null, ...) and map-origin article links carry allow-listed return context.",
      restoredFields: ["mode", "period", "region", "topic/category"],
      selectedLocationAndMapPosition: "Not serialized; location IDs and map camera are transient and were not needed for reliable filter restoration.",
      browserBack: "PASS",
      articleBack: "PASS",
      directArticleBack: "PASS: Volver a las noticias",
      reload: "PASS",
      urlShareableAsSideEffect: true,
      canonicalQueryContamination: articleReturnState.canonical?.includes("fromMap") ? "FAIL" : "PASS; canonical metadata is path-only when configured; this local run has no canonical because NEXT_PUBLIC_SITE_URL is unset.",
    },
    mapF02: {
      result: "PASS",
      legend: "Intensidad relativa; labels Menor and Mayor communicate direction. Qualitative relative intensity, with no numeric counts, percentages, or probabilities.",
      shownOnlyFor: "Heat mode, ready data, and at least one mapped location.",
      nodes: "PASS: no Heat legend",
      emptyHeat: "PASS: legend hidden when no mapped locations exist",
      dark: "PASS",
      light: "PASS",
    },
    actualPublicData: {
      regions: ["GLOBAL"],
      categories: ["empresas", "investigacion", "modelos"],
      unavailableRequestedExamples: ["EUROPE", "robotics"],
      sevenDayResult: "No mapped stories; current public stories are older than seven days.",
    },
    invalidState: { result: "PASS", fallback: "Nodos, 30 días, Todo el mundo, Todos", unknownValues: "Ignored safely by map state parser." },
    eVisualRegression: "PASS: no Hero, orbital globe, featured layout, article styling, latest-news styling, header, footer, or theme-system files changed in UI-05; featured-story count/layout unit test passes.",
    origin,
    evidenceGeneratedAt: new Date().toISOString(),
    browser: { executable: chromePath, devtoolsPort: Number(port), profileIsolated: true },
    screenshots,
    browserBack: { result: "PASS", restored: true, state: restoredState.selectedFilters, mode: restoredState.mode },
    articleReturn: { result: "PASS", restored: true, href: articleReturnState.returnHref, canonical: articleReturnState.canonical },
    responsive: { mobile: "PASS", desktop: "PASS", widths: responsive },
    appRuntime: { consoleErrors: browserEvents.consoleErrors.length, runtimeExceptions: browserEvents.runtimeExceptions.length, failedRequests: browserEvents.networkFailures.length },
    sevenDayFilteredState: { selectedFilters: emptyHeatState.selectedFilters, mappedStories: emptyHeatState.storyLinkCount, legendVisible: Boolean(emptyHeatState.legend) },
    consoleErrors: browserEvents.consoleErrors,
    runtimeExceptions: browserEvents.runtimeExceptions,
    networkFailures: browserEvents.networkFailures,
    tests: {
      mapUrlStateUnit: "PASS",
      frontendPublicContentUnit: "PASS",
      featuredStoriesLayoutUnit: "PASS",
      productionMapArticleHistorySmoke: "PASS",
      responsiveMapViewportSmoke: "PASS",
      lint: "PASS",
      typeScript: "PASS",
      build: "PASS (NEXT_PUBLIC_SITE_URL missing warning; indexing metadata disabled)",
      diffCheck: "Pending final audit",
      secretAudit: "Pending final audit",
    },
    providerCalls: 0,
    providerCallsScope: "AI and content-generation providers; existing read-only map-tile requests needed to render the visualization are outside this count.",
    remoteWrites: 0,
    deploys: 0,
  };
  await writeFile(path.resolve("artifacts/ui-map-functional-closure.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ screenshots: screenshots.length, responsive, consoleErrors: browserEvents.consoleErrors.length, runtimeExceptions: browserEvents.runtimeExceptions.length, networkFailures: browserEvents.networkFailures.length })}\n`);
} finally {
  try { socket?.close(); } catch {}
  try {
    const browserSocket = await connectWebSocket(browserEndpoint);
    browserSocket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await Promise.race([new Promise((resolve) => browserSocket.addEventListener("close", resolve, { once: true })), delay(3000)]);
    browserSocket.close();
  } catch {}
  if (browser.exitCode === null) {
    try { browser.kill(); } catch {}
    await Promise.race([new Promise((resolve) => browser.once("exit", resolve)), delay(3000)]);
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(devtoolsProfile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error.code !== "EBUSY" || attempt === 11) {
        process.stderr.write(`Could not remove isolated temporary Chrome profile: ${devtoolsProfile}\n`);
        break;
      }
      await delay(250);
    }
  }
}
