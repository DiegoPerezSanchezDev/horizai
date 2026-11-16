// P0-b offline discovery corpus. Synthetic fixtures; no network, no providers.
// Labels follow docs/editorial-scope-and-source-policy-p0a.md, NOT current code behaviour.
// expected.stage:
//   "admit"  -> a legitimate candidate that discovery should pass downstream
//   "drop"   -> discovery should discard it, with expected.reason
// topic: "in" (AI/tech scope) | "out" (outside scope; discovery has no topic filter, so it is
//        expected to pass through and be measured as downstream noise, not as a discovery defect).

export const NOW = new Date("2026-11-06T12:00:00Z");
export const WINDOW_HOURS = 48;

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const sources = [
  { key: "es", id: id(1), name: "Fixture ES", url: "https://es.example", feedUrl: "https://es.example/feed.xml", discoveryMethod: "rss", sourceType: "website", countryCode: "ES", language: "es", priority: 80 },
  { key: "en", id: id(2), name: "Fixture EN", url: "https://en.example", feedUrl: "https://en.example/feed.xml", discoveryMethod: "rss", sourceType: "website", countryCode: "US", language: "en", priority: 80 },
  { key: "pt", id: id(3), name: "Fixture PT", url: "https://pt.example", feedUrl: "https://pt.example/feed.xml", discoveryMethod: "atom", sourceType: "website", countryCode: "BR", language: "pt", priority: 70 },
  { key: "fr", id: id(4), name: "Fixture FR", url: "https://fr.example", feedUrl: "https://fr.example/feed.xml", discoveryMethod: "rss", sourceType: "website", countryCode: "FR", language: "fr", priority: 70 },
  { key: "de", id: id(5), name: "Fixture DE", url: "https://de.example", feedUrl: "https://de.example/feed.xml", discoveryMethod: "rss", sourceType: "website", countryCode: "DE", language: "de", priority: 70 },
  { key: "zh", id: id(6), name: "Fixture ZH", url: "https://zh.example", feedUrl: "https://zh.example/feed.xml", discoveryMethod: "rss", sourceType: "website", countryCode: "CN", language: "zh", priority: 70 },
  { key: "ja", id: id(7), name: "Fixture JA", url: "https://ja.example", feedUrl: "https://ja.example/feed.xml", discoveryMethod: "rss", sourceType: "website", countryCode: "JP", language: "ja", priority: 70 },
  { key: "ar", id: id(8), name: "Fixture AR", url: "https://ar.example", feedUrl: "https://ar.example/feed.xml", discoveryMethod: "rss", sourceType: "website", countryCode: "AE", language: "ar", priority: 60 },
  // A source with an empty day: legitimate absence, not a failure.
  { key: "quiet", id: id(9), name: "Fixture Quiet", url: "https://quiet.example", feedUrl: "https://quiet.example/feed.xml", discoveryMethod: "rss", sourceType: "website", countryCode: "KE", language: "en", priority: 50 },
  // A source whose feed fails: failure isolation.
  { key: "broken", id: id(10), name: "Fixture Broken", url: "https://broken.example", feedUrl: "https://broken.example/feed.xml", discoveryMethod: "rss", sourceType: "website", countryCode: "IN", language: "en", priority: 50 },
];

// Dates relative to NOW (2026-11-06T12:00Z). Window = 48 h.
const RECENT = "Thu, 05 Nov 2026 09:00:00 GMT";
const RECENT_ISO = "2026-11-05T09:00:00Z";
const OLD = "Mon, 26 Oct 2026 09:00:00 GMT";
const FUTURE = "Sun, 15 Nov 2026 09:00:00 GMT";

// items: { n, src, title, excerpt, date(raw string|null), dateTag, link|null, expected:{stage,reason?}, topic, newsCountry, note }
export const items = [
  // --- legitimate AI/tech items, several languages ---
  { n: "es-ia-1", src: "es", title: "Un nuevo modelo de lenguaje abierto supera a sus rivales en razonamiento", excerpt: "Investigadores publican resultados que comparan el modelo con sistemas cerrados.", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "ES" },
  { n: "en-chip-1", src: "en", title: "Chipmaker unveils new AI accelerator for data centers", excerpt: "The company says the part doubles inference throughput.", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "US" },
  { n: "pt-reg-1", src: "pt", title: "Brasil debate regulação de inteligência artificial no Senado", excerpt: "Projeto define regras para sistemas de alto risco.", date: RECENT_ISO, expected: { stage: "admit" }, topic: "in", newsCountry: "BR" },
  { n: "fr-cyber-1", src: "fr", title: "Une faille critique touche des serveurs d'IA exposés", excerpt: "Des chercheurs signalent une vulnérabilité exploitable à distance.", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "FR" },
  { n: "de-robot-1", src: "de", title: "Neuer Humanoid-Roboter geht in die Serienfertigung", excerpt: "Der Hersteller nennt erste Kunden in der Logistik.", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "DE" },
  { n: "zh-ai-1", src: "zh", title: "国产大模型发布新版本，推理能力提升", excerpt: "公司表示新版本在多项基准测试中表现更好。", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "CN" },
  { n: "ja-hw-1", src: "ja", title: "半導体メーカーが新しいAI向けチップを発表", excerpt: "データセンター向けの省電力設計を採用した。", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "JP" },
  { n: "ar-ai-1", src: "ar", title: "إطلاق مركز جديد لأبحاث الذكاء الاصطناعي في المنطقة", excerpt: "يهدف المركز إلى دعم الشركات الناشئة والبحث العلمي.", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "AE" },

  // --- news country differs from source country (P0-a section 3) ---
  { n: "pt-about-cn", src: "pt", title: "Startup chinesa lança chip de IA que desafia fabricantes americanos", excerpt: "A empresa de Xangai afirma ter reduzido o consumo de energia.", date: RECENT_ISO, expected: { stage: "admit" }, topic: "in", newsCountry: "CN", note: "source BR, news CN" },
  { n: "en-about-in", src: "en", title: "India approves national AI compute program", excerpt: "The government will fund shared GPU clusters for researchers.", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "IN", note: "source US, news IN" },
  { n: "de-about-ke", src: "de", title: "Kenia startet Pilotprojekt für KI in der Landwirtschaft", excerpt: "Bauern erhalten Wetterprognosen per Smartphone.", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "KE", note: "source DE, news KE" },

  // --- same event, different URLs/sources: both legitimate at discovery (clustering is downstream) ---
  { n: "en-evt-a", src: "en", title: "Lab releases open-weight model with 1M-token context", excerpt: "The release includes weights and an evaluation report.", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "US" },
  { n: "es-evt-a", src: "es", title: "Un laboratorio publica un modelo abierto con contexto de un millón de tokens", excerpt: "Incluye pesos e informe de evaluación.", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "US", note: "same event as en-evt-a" },

  // --- out of topic: discovery has no topic filter, measured as downstream noise ---
  { n: "es-out-sport", src: "es", title: "La selección gana el amistoso por la mínima", excerpt: "Crónica del partido de anoche.", date: RECENT, expected: { stage: "admit" }, topic: "out", newsCountry: "ES" },
  { n: "en-out-celeb", src: "en", title: "Celebrity couple announces engagement", excerpt: "Social media reacts.", date: RECENT, expected: { stage: "admit" }, topic: "out", newsCountry: "US" },
  { n: "fr-out-politics", src: "fr", title: "Le gouvernement présente son budget", excerpt: "Les principales mesures fiscales.", date: RECENT, expected: { stage: "admit" }, topic: "out", newsCountry: "FR" },

  // --- date problems ---
  { n: "en-no-date", src: "en", title: "Open-source toolkit simplifies model evaluation", excerpt: "Undated entry.", date: null, expected: { stage: "drop", reason: "no_reliable_date" }, topic: "in", newsCountry: "US" },
  { n: "en-bad-date", src: "en", title: "Robotics firm raises funding", excerpt: "Unparseable date.", date: "not a date", expected: { stage: "drop", reason: "no_reliable_date" }, topic: "in", newsCountry: "US" },
  { n: "en-future", src: "en", title: "Chip roadmap leaked ahead of launch", excerpt: "Date is ten days ahead.", date: FUTURE, expected: { stage: "drop", reason: "future_date" }, topic: "in", newsCountry: "US" },
  { n: "en-old", src: "en", title: "A look back at last month's AI model releases", excerpt: "Published eleven days ago.", date: OLD, expected: { stage: "drop", reason: "outside_window" }, topic: "in", newsCountry: "US" },
  // Legitimate and recent, but with a locale date string a strict parser can't read.
  { n: "zh-locale-date", src: "zh", title: "人工智能芯片公司完成新一轮融资", excerpt: "日期使用中文格式。", date: "2026年11月5日 09:00", expected: { stage: "admit" }, topic: "in", newsCountry: "CN", note: "recent, locale date format" },
  { n: "ar-locale-date", src: "ar", title: "شركة ناشئة تطلق نموذجا لغويا باللغة العربية", excerpt: "تاريخ بصيغة محلية.", date: "الخميس، 5 نوفمبر 2026", expected: { stage: "admit" }, topic: "in", newsCountry: "AE", note: "recent, Arabic locale date" },
  // No timezone: V8 interprets as server-local time.
  { n: "ja-no-tz", src: "ja", title: "ロボット企業が新型の産業用アームを公開", excerpt: "タイムゾーンなしの日付。", date: "2026-11-05 09:00:00", expected: { stage: "admit" }, topic: "in", newsCountry: "JP", note: "no timezone" },

  // --- structural problems ---
  { n: "es-no-link", src: "es", title: "Entrada sin enlace", excerpt: "No se puede atribuir a una fuente.", date: RECENT, link: "", expected: { stage: "drop", reason: "missing_url" }, topic: "in", newsCountry: "ES" },
  { n: "en-no-title", src: "en", title: "", excerpt: "Entry with no title.", date: RECENT, expected: { stage: "drop", reason: "missing_title" }, topic: "in", newsCountry: "US" },
  { n: "en-bad-url", src: "en", title: "Entry with invalid URL", excerpt: "Not http.", date: RECENT, link: "ftp://en.example/n/en-bad-url", expected: { stage: "drop", reason: "invalid_url" }, topic: "in", newsCountry: "US" },
  { n: "en-tracking", src: "en", title: "Same article reached with tracking parameters", excerpt: "Appears twice, once with utm.", date: RECENT, expected: { stage: "admit" }, topic: "in", newsCountry: "US" },
  { n: "en-tracking-dup", src: "en", title: "Same article reached with tracking parameters", excerpt: "Appears twice, once with utm.", date: RECENT, link: "https://en.example/n/en-tracking?utm_source=newsletter", expected: { stage: "drop", reason: "duplicate_url" }, topic: "in", newsCountry: "US" },
];

// Feeds served by the stubbed fetch, keyed by feedUrl. "quiet" is empty, "broken" fails.
export const brokenFeedUrl = "https://broken.example/feed.xml";
export const quietFeedUrl = "https://quiet.example/feed.xml";
