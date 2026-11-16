import "server-only";
import { editorialReviewSchema, type EditorialReview } from "./review.ts";

// Entirely invented examples. Dates, scores, sources and proof states are simulated.
// No production artifacts, unpublished text, prompts or extraction bodies are used.
const normal: EditorialReview = {
  reviewId: "demo-madrid", attemptId: "demo-attempt-01", draftId: "demo-draft-01", articleId: null,
  reviewStatus: "WAITING_FOR_HUMAN_REVIEW", consumed: false,
  humanRevisionId: null, approvalTarget: "ORIGINAL", approvalTargetSha256: "a".repeat(64),
  sourceLineageSha256: "b".repeat(64), criticProofStatus: "PASS", m34Status: "PASS", sourceLineageStatus: "PASS",
  headline: "Un laboratorio público de Madrid abre sus modelos de IA para investigar el consumo energético",
  summary: "El proyecto ficticio permite comparar modelos pequeños en equipos de uso cotidiano. Sus resultados aún no han sido evaluados de forma independiente.",
  whyItMatters: "Medir el coste de ejecutar modelos ayuda a distinguir una mejora de laboratorio de una herramienta viable para instituciones con recursos limitados.",
  country: "España", region: "Europa", category: "Investigación", createdAt: "2026-10-21T08:20:00Z", rankerScore: null,
  body: [
    { kind: "paragraph", text: "En este ejemplo de desarrollo, un laboratorio público presenta un conjunto abierto de modelos y una metodología para estudiar cuánta energía necesitan al resolver tareas sencillas. La propuesta pone el foco en la ejecución local y en la posibilidad de repetir los experimentos." },
    { kind: "paragraph", text: "El anuncio describe un protocolo común para comparar respuestas en ordenadores de capacidad limitada. El material simulado incluye instrucciones de evaluación, condiciones de uso y una descripción de las limitaciones que el equipo identifica en sus propios ensayos." },
    { kind: "heading", text: "La comparación necesita contexto" },
    { kind: "paragraph", text: "Un resultado aislado no permite concluir que un modelo consuma menos en cualquier situación. El tipo de equipo, la duración de la tarea y la calidad de las respuestas cambian la lectura de los datos. Por eso, este borrador evita convertir la presentación del proyecto en una afirmación de superioridad." },
    { kind: "paragraph", text: "La apertura del método podría facilitar que otros grupos comprueben las mediciones. Hasta que exista esa evaluación, las conclusiones deben atribuirse al equipo y describirse como resultados preliminares, sin extrapolarlas al conjunto de aplicaciones de inteligencia artificial." },
    { kind: "heading", text: "Qué queda por comprobar" },
    { kind: "paragraph", text: "La revisión editorial debe comprobar que el alcance de cada afirmación coincide con la documentación enlazada. También debe diferenciar la disponibilidad del material de su validación independiente y conservar esa incertidumbre en el titular y el resumen." },
  ],
  sources: [
    { publisher: "laboratorio.example.org", title: "Presentación del proyecto abierto — fuente simulada", url: "https://example.org/?fixture=proyecto", publishedAt: "2026-10-21T07:00:00Z", classification: "PRIMARY" },
    { publisher: "observatorio.example.org", title: "Contexto sobre evaluación energética — fuente simulada", url: "https://example.org/?fixture=contexto", publishedAt: "2026-10-20T12:00:00Z", classification: "SECONDARY" },
  ],
  warnings: [],
};

const blocked: EditorialReview = {
  ...normal, reviewId: "demo-warning", attemptId: "demo-attempt-02", draftId: "demo-draft-02",
  headline: "Una red de hospitales estudia cómo evaluar asistentes clínicos antes de su adopción",
  summary: "Ejemplo sintético con una discrepancia de atribución pendiente. El borrador requiere revisión antes de poder avanzar.",
  whyItMatters: "El alcance de una prueba y el de una adopción clínica tienen implicaciones distintas. El texto debe reflejar esa diferencia con precisión.",
  createdAt: "2026-10-21T07:45:00Z", country: null, region: "Europa", category: "Salud",
  approvalTargetSha256: "c".repeat(64), sourceLineageStatus: "FAIL", m34Status: "FAIL",
  body: [
    { kind: "paragraph", text: "Este caso ficticio describe una propuesta de evaluación de asistentes para tareas administrativas. No representa un despliegue clínico ni aporta resultados sobre pacientes. El título de una de las referencias simuladas podría inducir a confundir ambas etapas." },
    { kind: "paragraph", text: "Antes de avanzar, el operador debe resolver la atribución de la afirmación principal y comprobar que todas las referencias pertenecen a la misma versión del documento. El borrador permanece pendiente y el bloqueo se muestra de forma explícita." },
  ],
  sources: [{ publisher: "red-salud.example.org", title: "Protocolo de evaluación — fuente simulada", url: "https://example.org/?fixture=salud", publishedAt: null, classification: "PRIMARY" }],
  warnings: [
    { id: "demo-lineage", severity: "BLOCKER", title: "Revisar la cadena de fuentes", detail: "Ejemplo de bloqueo: la referencia principal no coincide con la versión vinculada al borrador. Debe resolverse antes de una futura publicación." },
    { id: "demo-attribution", severity: "WARNING", title: "Atribución pendiente", detail: "El texto debe distinguir una propuesta de evaluación de una adopción confirmada." },
    { id: "demo-info", severity: "INFO", title: "Nota editorial", detail: "Este caso es sintético y sirve para comprobar los tres niveles de aviso." },
  ],
};

const corrected: EditorialReview = {
  ...normal, reviewId: "demo-corrected", attemptId: "demo-attempt-03", draftId: "demo-draft-03",
  headline: "Un consorcio europeo propone un marco común para documentar las limitaciones de los modelos",
  summary: "Revisión humana simulada: el titular y el cuerpo distinguen una propuesta de un estándar ya adoptado.",
  whyItMatters: "Documentar límites de forma comparable puede ayudar a evaluar herramientas sin confundir una iniciativa voluntaria con una obligación vigente.",
  country: null, region: "Europa", category: "Gobernanza", createdAt: "2026-10-21T07:10:00Z",
  humanRevisionId: "demo-revision-02", approvalTarget: "HUMAN_REVISION", approvalTargetSha256: "d".repeat(64),
  body: [
    { kind: "paragraph", text: "Esta revisión humana ficticia corrige el alcance de una propuesta documental. El consorcio del ejemplo invita a comparar cómo se comunican las limitaciones de los modelos, pero no ha establecido una norma obligatoria ni acredita que las organizaciones hayan adoptado el marco." },
    { kind: "heading", text: "Una corrección de alcance" },
    { kind: "paragraph", text: "La versión corregida sustituye una formulación que daba la adopción por hecha. Mantiene la atribución al consorcio y explica que el método está abierto a comentarios. El objetivo es conservar el valor informativo sin anticipar resultados que el material de referencia no demuestra." },
    { kind: "paragraph", text: "La decisión futura deberá quedar vinculada a esta revisión humana y a su hash exacto. Si el contenido cambia después de abrir la ficha, el servidor tendrá que exigir una nueva lectura antes de aceptar una aprobación." },
  ],
  sources: [{ publisher: "consorcio.example.org", title: "Propuesta de documentación — fuente simulada", url: "https://example.org/?fixture=marco", publishedAt: "2026-10-20T16:00:00Z", classification: "PRIMARY" }],
};

// Fourth example: carries invented ranking/verification/critic evidence so the scored detail and the digest can be reviewed.
const scored: EditorialReview = {
  ...normal, reviewId: "demo-scored", attemptId: "demo-attempt-04", draftId: "demo-draft-04",
  headline: "Un regulador asiático publica un borrador de requisitos de transparencia para modelos de gran tamaño",
  summary: "Ejemplo sintético con puntuación y evidencia completas: el borrador está en consulta y todavía no es una norma vigente.",
  whyItMatters: "Los requisitos de transparencia en consulta pueden anticipar obligaciones para los proveedores que operan en la región.",
  country: "Singapur", region: "Asia", category: "Regulación", createdAt: "2026-10-21T08:05:00Z", rankerScore: 81,
  approvalTargetSha256: "e".repeat(64), packageSha256: "f".repeat(64),
  evidence: {
    ranking: { importanceScore: 81, impact: 84, novelty: 70, reach: 78, credibility: 92, economicImpact: 74, momentum: 80, rankReason: "Ejemplo: afecta a varios proveedores, procede de una fuente oficial y marca el calendario regulatorio de la región." },
    verification: {
      status: "confirmed", confidenceScore: 88, reason: "Ejemplo: el documento oficial y un medio especializado coinciden en el alcance y el calendario.",
      verifiedFacts: [
        { claim: "El regulador publicó un borrador de requisitos de transparencia (ejemplo).", sources: ["regulador.example.org"] },
        { claim: "La consulta pública permanece abierta durante seis semanas (ejemplo).", sources: ["regulador.example.org", "medio.example.org"] },
      ],
      uncertainClaims: [{ claim: "No está claro si los requisitos alcanzarán a los modelos de código abierto (ejemplo).", sources: ["medio.example.org"] }],
      contradictions: [],
    },
    critic: {
      decision: "pass", severity: "low", notes: "Ejemplo: titular y resumen atribuyen la propuesta al regulador y no presentan el borrador como norma vigente.",
      issues: [{ code: "SCOPE_NOTE", severity: "low", message: "Ejemplo: conviene mantener 'borrador' visible en el titular." }],
      unsupportedClaims: [],
    },
  },
  sources: [
    { publisher: "regulador.example.org", title: "Borrador de requisitos de transparencia — fuente simulada", url: "https://example.org/?fixture=regulador", publishedAt: "2026-10-21T06:30:00Z", classification: "PRIMARY" },
    { publisher: "medio.example.org", title: "Análisis del borrador — fuente simulada", url: "https://example.org/?fixture=medio", publishedAt: "2026-10-21T07:15:00Z", classification: "SECONDARY" },
  ],
};

export const editorialFixtures = [normal, blocked, corrected, scored].map((review) => editorialReviewSchema.parse(review));
