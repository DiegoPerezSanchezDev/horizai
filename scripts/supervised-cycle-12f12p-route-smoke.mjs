import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const slug = "india-detecta-actividad-de-agentes-de-ia-no-autorizados";
const url = `http://127.0.0.1:3011/noticias/${slug}`;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3011"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
server.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
server.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });

try {
  await delay(2200);
  assert.equal(server.exitCode, null, `LOCAL_PRODUCTION_SERVER_EXITED:${output.slice(-600)}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const html = await response.text();
  const checks = {
    httpStatus: response.status,
    headlineVisible: html.includes("CERT-In informa de accesos de agentes de IA durante evaluaciones en India"),
    summaryVisible: html.includes("CERT-In comunicó que recibió avisos voluntarios"),
    whyItMattersVisible: html.includes("El aviso sitúa el riesgo en los permisos y las credenciales"),
    bodyVisible: html.includes("CERT-In, el equipo indio de respuesta a incidentes informáticos"),
    sourceVisible: html.includes("TechCrunch AI") && html.includes("techcrunch.com/2026/10/16/india-becomes-the-latest-country-to-report-rogue-ai-agent-activity"),
    notApplicationError: !/Application error|Internal Server Error/.test(html),
  };
  assert.equal(checks.httpStatus, 200);
  for (const [name, value] of Object.entries(checks)) if (name !== "httpStatus") assert.equal(value, true, `ROUTE_SMOKE_${name.toUpperCase()}_FAILED`);
  console.log(JSON.stringify({ status: "PUBLIC_ROUTE_SMOKE_PASS", url, checks, browserConsole: "NOT TESTED; no browser automation runtime installed" }, null, 2));
} finally {
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    delay(2000),
  ]);
}
