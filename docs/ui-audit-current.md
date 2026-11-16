# HorizAI current UI audit

**Phase:** UI-01 — observe, research, and plan\
**Observed:** 2026-10-09\
**Local target:** existing development server at localhost:3000\
**Scope:** rendered UI, source inspection, responsive observations, and public guidance research. No implementation proposal in this report has been applied.

## CURRENT STATE

### Product and route map

HorizAI is a Spanish-language global AI news and intelligence product. The homepage is the App Router route assembled in app/page.tsx: header, editorial hero, global map, featured stories, latest news, and footer. It reads up to 36 recently published records from the public published-articles view, filtered to the previous 30 days. The observed local dataset returned two articles, both published 2026-09-29.

An existing article was inspected at /noticias/mas-de-mil-fallecidos-tras-fallas-en-torres-de-vigilancia-fronteriza. It uses a lead title and summary, date and reading time, a “Por qué importa” section, article body, source link, and a return/navigation path. A related-stories area is conditional on matches; it did not appear for this article.

The map is a real interactive exploration surface, not only an illustration. GlobalIntelligenceMap and MapCanvas provide a MapLibre canvas, Nodes/Heat modes, filters, controls, and a story panel. The canvas loads lazily when close to the viewport. In the observed data it represented one location and two located stories.

The navigation includes the home route and product pages. Observed content routes include /sobre-nosotros, /metodologia, /fuentes, /contacto, /privacidad, /terminos, and /noticias/[slug]. The footer repeats product and legal navigation. Privacy and terms text explicitly identifies itself as provisional; contact identifies hola@horizai.es as a placeholder.

### Architecture and visual system

- Server-rendered route and content sections are composed from focused components. The client surface is concentrated in the map, selected story/filter controls, theme toggle, reading progress, and error handling.
- Tailwind CSS v4 is combined with semantic CSS custom properties and component styles in app/globals.css. Theme colors, spacing, radii, and motion tokens are centralized; some detailed component treatments remain local.
- Typography uses Inter for body text, Manrope for display headings, and JetBrains Mono for data labels. The hierarchy is clear; the font combination is competent but familiar across technology products.
- Dark mode uses navy and near-black surfaces with electric blue accents. Light mode has its own pale background and dark text rather than a simple color inversion.
- The hero uses a schematic globe and story callouts; the globe is decorative and callout positions are not a geospatial representation. The map lower on the page is the actual geographic tool.
- Story cards without an image URL intentionally render a dark category/region art fallback. This is a designed fallback, not a failed remote image.

### States observed or found in source

The homepage has a Suspense loading skeleton; the map reserves space with a fixed-size placeholder before its lazy canvas loads. The source also includes map empty/error messaging, article-level and global error handling, and a not-found route. The audit did not invoke editorial processing or mutate source data.

On the local render, “Lo más reciente” and the map reflected a sparse current set: two stories dated ten days before this observation, one mapped location, and no displayed last-refresh timestamp. This is evidence about the local data/render observed on 2026-10-09, not a claim about a deployed environment or the intended publishing cadence.

## SCREENSHOTS

Real browser captures were saved under artifacts/ui-audit/. Desktop captures target 1440×900 CSS pixels; mobile captures target 390×844. The browser was in the local development build, so the Next.js development indicator may be visible. Full-page captures are longer than one viewport. The files have JPEG image data and .jpg extensions.

| Capture | View |
| --- | --- |
| home-hero-desktop-dark.jpg | Homepage hero, desktop, dark |
| home-map-desktop-dark.jpg | Homepage map, desktop, dark |
| home-stories-desktop-dark.jpg | Featured story section, desktop, dark |
| home-latest-desktop-dark.jpg | Latest-news section, desktop, dark |
| home-full-desktop-dark.jpg | Homepage full page, desktop, dark |
| home-mobile-dark.jpg | Homepage top/hero, mobile, dark |
| home-map-mobile-dark.jpg | Map section, mobile, dark |
| article-desktop-dark.jpg | Existing article, desktop, dark |
| article-mobile-dark.jpg | Same article, mobile, dark |
| home-hero-desktop-light.jpg | Homepage hero, desktop, light |
| home-map-desktop-light.jpg | Homepage map, desktop, light |
| home-full-desktop-light.jpg | Homepage full page, desktop, light |
| article-desktop-light.jpg | Existing article, desktop, light |

Dark and light desktop equivalents were captured for the homepage and article where useful. No light-mode mobile screenshot was captured. All captures are local real renders; none are mockups.

## REFERENCE COMPARISON

The comparison reference is docs/references/hero-approved.png; it was inspected and left unchanged.

| Area | Current observation | Assessment |
| --- | --- | --- |
| Visual hierarchy | Current hero leads with a real article title and summary; the historical reference led with the fixed value proposition “Todo lo importante de la IA en tiempo real.” | The editorial lead is an intentional product evolution. On mobile, however, the article title can leave the product purpose implicit. |
| Brand continuity | Navy/near-black base, electric-blue signal color, globe, and global story callouts remain. | Strong continuity in color and global motif. |
| Hero proportions | Current desktop hero is large and gives the headline/globe room; mobile reorders content into a vertical stack. | The mobile layout is a purposeful composition, not a desktop squeeze. |
| Navigation | Current header is simplified and has no search or subscribe controls from the reference. | Intentional MVP simplification; no current evidence that those controls are required. |
| Spacing and contrast | The open hero has clear breathing room. Some data/eyebrow labels are very small and faint, particularly in light mode. | Hierarchy is largely intact; the faint micro-label token is measurable accessibility drift. |
| Map transition | Current page gives the map its own section below the hero, with interactive controls. | Consistent with the product principle that maps are tools. It is not forced into the hero. |
| Editorial feeling | The current homepage is led by a live story and compact latest list; its two featured items use fallback art. | More editorial than a dashboard, but sparse content and the fallback art weaken the magazine-quality impression. |
| Premium feeling | Dark/light themes, controlled blue accents, and restrained borders create a considered base. | Premium cues are present; repeated glows, mono labels, and small metadata need restraint. |

### Intentional differences

- HorizAI replaces the historical AINEXUS name/identity.
- The current lead story is editorial and data-backed instead of a fixed landing-page slogan.
- Search, subscription, legacy volume figures, and “120k visitors” are absent from the observed MVP.
- The map is a distinct interactive section rather than decorative hero scenery.
- The globe remains a brand illustration; its callouts must not be read as exact map coordinates.

### Likely implementation or product drift

- The current mobile first screen shows the logo and a story, but not an always-visible one-sentence product promise. The desktop header tagline is hidden below the wide breakpoint.
- Story-card fallback art fills a large 16:9 area with little actual visual content; the current two-card set also leaves the rail sparse.
- The observed “latest” set is ten days old and has no visible freshness marker. Verify the intended cadence and production feed before deciding whether this is a product defect or a local-data condition.
- Small low-contrast labels fall below normal-text contrast guidance in both themes.

## SKILL RESEARCH

Research was limited to official Anthropic/Claude Code guidance first, then one community skill for comparison. Third-party material was read as text only; nothing was installed or executed.

| Source / skill | What it teaches and useful principles | Patterns to avoid or adapt | Trust and HorizAI value |
| --- | --- | --- | --- |
| [Anthropic Claude Code frontend-design skill](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md) | Make a deliberate visual concept grounded in the subject; treat typography and the hero as identity; avoid generic generated-looking layouts; give hierarchy and line length attention. | Its preference for highly distinctive, bold visual moves can be over-applied. HorizAI should not inherit another product’s palette or add ornamental novelty where editorial clarity is stronger. | Official Anthropic repository. High value as a reminder to make the design subject-specific, with the product principles controlling restraint. |
| [Anthropic skills repository](https://github.com/anthropics/skills) and [skill-creator guidance](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md) | A useful skill has precise triggers, focused instructions, progressive disclosure, and realistic evaluation prompts. Keep reusable guidance concise and actionable. | Do not turn a skill into a broad design manifesto or repeat generic front-end documentation. | Official Anthropic repository. Useful structure for a future project-local horizai-ui skill. |
| [Claude Code skill-development guidance](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/skill-development/SKILL.md) | Use domain-specific examples, imperative instructions, and concise, reusable knowledge; keep examples close to actual tasks. | Avoid boilerplate, unnecessary abstractions, and rules that do not affect a decision. | Official Anthropic repository. Useful for making the proposed skill operational and project-specific. |
| [Claude Code skills documentation](https://code.claude.com/docs/en/skills) | Describes skill organization and invocation through names/descriptions, supporting clear scope and discoverability. | Claude-specific packaging should not be copied as a Codex installation recipe without adaptation. | Official product documentation. Useful context for skill structure, not a UI design authority. |
| [Impeccable](https://github.com/pbakaus/impeccable) and [its design skill](https://github.com/pbakaus/impeccable/blob/main/.agent/skills/impeccable/SKILL.md) | Community guidance emphasizes observe-first critique, design vocabulary, focused audits, and adapting a system to a product. | Its strict bans, “go all out” novelty pressure, and command flows that invoke package tooling are not universal rules. None were run. | Community project, not Anthropic official. Useful as a review checklist source, subordinate to HorizAI’s product principles. |

### Principles applied to this audit

- Distinctiveness should come from the product’s editorial point of view, Spanish-language voice, global scope, and truthful data—not decorative complexity.
- Typography should establish a reading order: product promise or lead story, summary, evidence/metadata, then actions. Keep mono for time, counts, and data labels.
- Keep editorial surfaces open. Use a card when it helps compare or select stories, not as a default wrapper around every section.
- A responsive page should re-prioritize narrative, controls, and map context for small screens. The observed mobile page already does this in several places.
- Interaction states need clear names and visible focus. Empty, stale, and error states should describe what the data means and what the reader can do.
- Motion should be subtle and respect reduced-motion preferences. The code includes a reduced-motion rule that suppresses animation/transition and makes reveal content visible.
- Do not imitate Anthropic’s visual style. Use its process lessons, while preserving HorizAI’s navy, blue signal, and editorial identity.

## GENERIC AI UI AUDIT

Statuses refer to observed implementation and screenshots, not a judgment that any single pattern is automatically wrong.

| Pattern | Status | Evidence and assessment |
| --- | --- | --- |
| Excessive rounded cards | PARTIAL | Featured .story-card, .map-frame, and map/story panels use rounded surfaces; the hero remains open. The rounded treatment is not applied to every section. See story and map captures. |
| Everything inside boxes | NOT PRESENT | Hero and article reading column are open; map and story cards are boxed only where their interactions/content benefit. |
| Uniform border radius | NOT PRESENT | Radius tokens vary by surface and control; pills are reserved for tags and filters. |
| Unnecessary gradients | PARTIAL | Hero/globe atmosphere and selected controls use gradients. They support depth and state, though should stay limited to key surfaces. |
| Glow everywhere | PARTIAL | Glow appears around the logo/primary action, globe, and selected pills. It is not spread across all cards, but the recurring motif is close to becoming generic. |
| Repetitive pills | PARTIAL | Filters, metadata, and action labels use pill-like forms. Functional filters are justified; article/card metadata can be more varied. |
| Generic SaaS dashboard | NOT PRESENT | The page is editorial and public-facing, with a lead story, news list, and exploration map rather than a dashboard grid. |
| Monospace without purpose | PARTIAL | JetBrains Mono is appropriate for dates and data, but also appears in section labels and eyebrow text where it contributes little. |
| Weak typography hierarchy | NOT PRESENT | Hero and article H1s are prominent, with clear H2 sections and scannable summaries. Font personality is generic rather than hierarchy being weak. |
| Too many small labels | PRESENT | Numerous uppercase labels around 0.6rem are visible on story/map surfaces. Several use the faint token with inadequate contrast. |
| Excessive eyebrow headings | PARTIAL | Numbered sections and repeated uppercase kickers give orientation but appear often enough to flatten their importance. |
| Decorative arrows everywhere | PARTIAL | Arrows indicate links and continuation; some repeated arrow treatments are more ornamental than necessary. |
| Identical card structures | PARTIAL | Featured stories share a consistent template. Consistency helps scanning, but the same media fallback makes the set feel repetitive. |
| Huge unused whitespace | PARTIAL | The open layout is intentional; two stories leave the feature rail sparse and the low-density map can read as empty. |
| Generic dark-mode neon aesthetic | PARTIAL | Navy, electric blue, and glow are common tech cues, but the editorial content, restrained paneling, and real map keep the product distinct. |

## HOMEPAGE AUDIT

### Visitor journey

| Step | Observation | Outcome |
| --- | --- | --- |
| Arrive and understand HorizAI in under five seconds | Desktop may show the “Inteligencia sin fronteras” tagline at a wide breakpoint. Mobile hides it and leads with an article headline. The logo alone does not explain the service. | Needs a concise, persistent product promise, especially on mobile. |
| See today’s important developments | Lead story and compact latest list create a clear editorial order. On the observed local data both available stories were ten days old. | Layout is strong; freshness is unclear and potentially misleading without cadence context. |
| Understand global scope | Brand globe, global language, and map provide global cues. | Strong visual signal, but actual coverage is sparse in this sample. |
| Understand why the map matters | CTA leads to a dedicated map tool with Nodes/Heat modes, filters, and story panel. A note says locations are included only when present in public data. | The map is discoverable and functional; sparse data needs clearer context. |
| Choose a story | Feature cards and a compact latest list offer two routes. | Clear, but only two items make the current selection feel small. |
| Read comfortably | Article has a narrow reading column and distinct “Por qué importa” summary. | Good continuation from homepage. |
| Understand credibility | Article source link and separate Sources/Methodology pages are available. | Traceability exists; visible evidence can be strengthened through consistent source naming and freshness. |
| Continue exploring | Header/footer navigation, map, and conditional related content offer paths. | Article continuation is weak when there are no related matches. |

### Strengths

- Strong first-level hierarchy: real lead story, summary, then map and story sections.
- Homepage does not present itself as a generic KPI dashboard.
- The hero CTA and dedicated map section make the map actionable and discoverable.
- Latest-news rows are compact and easier to scan than a long grid of large cards.
- Mobile gets its own stacked composition, with navigation access, readable headline, summary, and a contained map.

### Main weaknesses

- Product purpose is less explicit than the story on mobile and at narrower desktop widths.
- The current local dataset makes “latest” feel stale, and no last-updated label establishes freshness.
- Only two story items expose the fallback art and empty rail more strongly.
- The map shows one location for two located stories; its value and limits are not explained enough for sparse coverage.

## ARTICLE AUDIT

| Dimension | Finding |
| --- | --- |
| Headline and hierarchy | Large headline is dominant. Summary sits close to the title; date and reading time are secondary. |
| Why it matters | Clearly separated and easy to locate before the body. |
| Body readability | Comfortable centered column with paragraph rhythm; desktop line length is constrained, and mobile fits the viewport without horizontal overflow. |
| Sources and trust | The article links to MIT Technology Review, and the product has Methodology/Sources pages. Keep organization/source name and destination clear. |
| Context and metadata | Category/region/date and reading time help orient the reader. Avoid letting small metadata labels compete with the headline. |
| Related navigation | Conditional related block did not render for this article. A fallback path to latest stories or the relevant category would prevent a dead end. |
| Mobile | Title, summary, date/reading time, and “Por qué importa” form a legible opening. The reading column remains usable on 390px viewport. |
| Trust limits | A source link supports traceability, but this audit did not verify the linked article’s factual claims. |

## MAP AUDIT

- **Essential or decorative:** The lower homepage map is essential in implementation: MapLibre, modes, filters, and story selection make it a tool. The hero globe is decorative, with static callout placement; keep those roles visually distinct.
- **Prominence:** It has a dedicated homepage section and an explicit entry CTA. It does not take over the article hero.
- **Relationship to stories:** The map reports locations/stories and can surface a story panel. In this local data it reports one location and two located stories.
- **Information density:** Filters, mode control, and map controls are reasonably compact. The current sparse data makes the canvas dominate without enough signal.
- **Mobile:** Canvas remains within the page width; filters wrap, and the story panel stacks under the map. This preserves the map without a horizontal overflow.
- **Trust and interpretation:** The visible note “Solo ubicaciones incluidas en datos públicos” is useful but low contrast. It should remain clear that unlocated stories are not evidence of no activity in a region.
- **Recommendation:** Keep one global map with current Nodes/Heat concepts. For sparse coverage, add a calm coverage/freshness explanation or adjust emphasis based on actual data; never fabricate points or imply completeness.

## MOBILE AUDIT

The 390×844 capture shows a deliberate stacked homepage. The product mark/navigation sits above the lead headline and summary; globe and metrics follow. The map view keeps controls within the viewport and moves the story panel below the canvas. The article opening retains a readable title, summary, metadata, and “Por qué importa.”

Responsive widths were checked at 375×812, 390×844, 768×1024, 1024×768, 1280×800, 1366×768, 1440×900, and 1920×1080. The measured document did not have horizontal overflow at these sizes. The map width stayed constrained to the content column. At 1024px the map is narrower than on desktop, which is reasonable for the surrounding layout but worth watching as controls/data density grow.

Mobile improvements to prioritize are the persistent product promise, slightly larger tap targets for secondary chips, and clearer map context when only a few locations are available.

## ACCESSIBILITY

### Positive evidence

- Root layout includes a skip link and semantic page regions; heading order is generally clear.
- Buttons/links have focus-visible styling in the shared CSS. Map canvas has an accessible name/description; filter buttons expose pressed state.
- prefers-reduced-motion reduces transitions/animations and makes reveal content visible.
- No horizontal overflow was observed at the eight audited widths.
- Major titles, body text, and primary actions remain legible in both desktop themes.

### Issues and limits

- Contrast estimates using the current faint-label tokens and adjacent page backgrounds were about 4.08:1 in dark mode and 3.07:1 in light mode. These values appear on small uppercase labels, below the 4.5:1 WCAG AA target for normal text. Raise the faint token’s contrast or reserve it for larger text/non-text detail.
- Chip sizes are about 30–34px high; map controls are about 36px; primary hero CTAs are about 44px. The smaller controls exceed a 24px minimum but are less comfortable on touch. Increase key mobile targets where space allows.
- Source inspection shows keyboard focus styles and semantic buttons, but a complete keyboard-only journey and screen-reader pass were not performed. Treat those as unverified.
- The audit did not measure image alternative text for a populated real-image article set; the observed stories used intentional art fallbacks.

## PERFORMANCE

- Client code is concentrated in seven interactive areas/components, with the MapLibre canvas loaded lazily near the viewport. This keeps the map from being a mandatory immediate homepage download.
- The map worker is self-hosted under public/maplibre; the rendered map fetched public map style/tile assets. Those are map asset requests, not model-provider calls or remote writes.
- next/font/google defines Inter and Manrope with display swap; JetBrains Mono is used for data labels. No font-load or Core Web Vitals timings were collected.
- next/image is used when an article has an image URL, currently with unoptimized; the observed article set did not provide images, so the card fallback was rendered. Image sizing and loading behavior should be revisited when real image content is present.
- Homepage Suspense and fixed map placeholder reserve visual space. CLS was not measured, so this is source-level evidence rather than a measured guarantee.
- Tailwind v4 and shared CSS tokens coexist intentionally; some component-level CSS remains. No duplication or architecture fault severe enough to justify refactoring was observed.
- No performance benchmark or tests were run. npm run lint completed successfully. A production build was not run because the existing Next.js development server remained active and a build could conflict with its output directory. No executable code changed; browser rendering and responsive overflow inspection provide the UI evidence.

## THREE DIRECTIONS

### 1. Atlas Editorial

- **Concept:** A daily Spanish-language briefing with a global point of view. Editorial selection leads; the map and data explain the coverage.
- **Typographic direction:** Add a restrained humanist or editorial display face for major story moments, paired with a highly readable sans for body and interface. Keep mono for timestamps/counts only.
- **Color behavior:** Navy and near-black remain the dark foundation; warm paper is a purposeful light theme; electric blue marks links, selected map signals, and primary actions.
- **Layout philosophy:** Open editorial columns, a clear lead, compact regional/context index, and a limited number of justified cards.
- **Hero:** One-sentence product promise plus the strongest current story; globe supports global scale without competing with the H1.
- **News cards / story list:** One visually distinct lead, then a compact, scannable list. Use real editorial imagery when available and a deliberate typographic/abstract fallback when not.
- **Map treatment:** Story index and coverage tool with explicit data scope; it supports the briefing rather than dominating it.
- **Article page:** Comfortable reading column, visible “Por qué importa,” source trail, and a useful continuation link even without a related match.
- **Mobile character:** Narrative-first stack, visible product promise, compact controls, map introduced with a plain-language explanation.
- **What makes it distinctive:** Spanish editorial voice and the connection between global developments and where they happen.
- **Risks:** Can feel like a conventional newsroom if the visual language and regional perspective are not specific; strong imagery is helpful but should not be fabricated.

### 2. Signal Atlas

- **Concept:** An intelligence exploration product where stories are navigable signals across regions and time.
- **Typographic direction:** Precise, contemporary sans with a narrowly used mono for timestamps and map/data labels; strong distinctions between signal, context, and source.
- **Color behavior:** Primarily dark canvas, restrained electric-blue signals, low-noise heat palette; light mode uses a clean cartographic paper tone.
- **Layout philosophy:** Map and timeline form the main exploration workspace, with a linked story rail and contextual detail.
- **Hero:** Short proposition, current signal count with a date window, and a direct launch into map exploration. Counts must be real and scoped.
- **News cards / story list:** Compact ranked signals, each with location/topic and a clear source path.
- **Map treatment:** Main surface with linked selection, timeline, and filters; show sparse coverage plainly.
- **Article page:** Contextual story detail with regional links, source chain, and related signals.
- **Mobile character:** Map as a bounded interactive panel followed by a compact, filterable story stream; preserve a direct article-reading path.
- **What makes it distinctive:** Strong visual relationship between event, location, and time.
- **Risks:** Can drift into GIS/dashboard complexity and feel empty when data volume is low; needs clear data quality and coverage rules.

### 3. Global AI Review

- **Concept:** A premium long-form technology magazine that explains consequential AI developments through visual essays.
- **Typographic direction:** More pronounced editorial serif for display and pull quotes, paired with a quiet sans reading face; mono reserved for source/date details.
- **Color behavior:** Ink/near-black and warm paper do most of the work; electric blue is a precise annotation color.
- **Layout philosophy:** Fewer, deeper stories with generous reading rhythm and visual explainers between editorial sections.
- **Hero:** A visual feature with an explicit HorizAI proposition, summary, and restrained globe or evidence visualization.
- **News cards / story list:** Fewer, larger selections with commissioned/verified imagery and concise summaries.
- **Map treatment:** A chapter-like visual explainer attached to a story or coverage briefing rather than the first exploration surface.
- **Article page:** Long-form structure with pull quotes and annotations only when the source material supports them; prominent bibliography/source links.
- **Mobile character:** Reading-first pages with carefully sequenced imagery and compact story navigation.
- **What makes it distinctive:** A highly recognizable explanatory voice and deep context rather than breadth of headlines.
- **Risks:** Requires a steady supply of strong visual material and editorial depth; may reduce scan speed and freshness perception.

## RECOMMENDED DIRECTION

Recommend **Atlas Editorial**. It fits HorizAI’s stated purpose as a Spanish-language global intelligence/news product and aligns with “information first,” “global perspective,” “premium but readable,” and “maps are tools.” It keeps the map meaningful without turning the homepage into a GIS workspace, and it works with both a small and growing story set. It also scales to future data, pricing, or benchmark surfaces by preserving a clear editorial hierarchy rather than making every page a dashboard.

The first implementation question should be the product promise and freshness model, not a new component system. Keep the current navy/blue identity and the dedicated map; refine typography and fallback art only after the content cadence and image strategy are understood.

## P0/P1/P2 CHANGES

### P0 — before public launch (2)

| Current issue | Proposed change | User impact | Visual impact | Complexity | Affected component/file | Behavior or visual-only |
| --- | --- | --- | --- | --- | --- | --- |
| Observed local “latest” content had two stories dated ten days earlier, without a last-refresh label. Public cadence is not established by this render. | Agree a publishing cadence and stale threshold; expose last-updated/coverage context or a clear stale state when the feed falls outside that threshold. Verify against the production source before launch. | High: protects trust in what is presented as current. | Medium: changes freshness copy and possibly stale-state emphasis. | Medium to high; requires product/content-source agreement and UI state. | app/page.tsx, components/hero/hero.tsx, components/news/latest/latest-news-section.tsx, published-content source. | Behavior/content and UI. |
| Privacy/terms explicitly say provisional; contact email is explicitly a placeholder. | Complete the required legal review, publish approved terms/privacy content, and replace the contact placeholder with an operational channel or remove the contact action until one exists. | High trust and launch-readiness impact. | Low: mostly text/link changes. | Medium; requires approved content and operational contact. | components/content/content-page-data.ts and contact/legal content ownership. | Content/behavior, not styling. |

### P1 — strong improvement (5)

| Current issue | Proposed change | User impact | Visual impact | Complexity | Affected component/file | Behavior or visual-only |
| --- | --- | --- | --- | --- | --- | --- |
| Mobile and narrower desktop can show a lead story without a concise statement of what HorizAI is; the desktop tagline is breakpoint-limited. | Keep a short product promise visible in the hero at every width while preserving the lead story as the editorial focus. | High: visitor understands the service faster. | Medium: small hierarchy/composition change. | Low. | components/hero/hero.tsx, header/hero styles. | Content and visual. |
| Current sample has one location for two located stories and little explanation of what the map represents. | State coverage window and location limits; tune map emphasis for genuinely sparse data without inventing locations. | High: prevents false assumptions about global coverage. | Medium. | Medium; depends on actual coverage metadata. | components/map/global-intelligence-map.tsx, components/map/map-canvas.tsx, map data presentation. | Behavior/content and visual. |
| Two featured items expose a large 16:9 fallback area with only modest category/region detail, and leave the rail visibly sparse. | Design a purposeful no-image treatment or supply verified editorial images; tune the rail for low item counts. | Medium: improves story selection and perceived editorial quality. | High within the feature section. | Medium. | components/news/featured/*, story-card styles and image/fallback data. | Visual/content. |
| Faint label token is about 4.08:1 in dark and 3.07:1 in light mode on observed backgrounds, used on small text. | Raise token contrast or reserve the faint color for large/non-text details; recheck affected labels in both themes. | Medium: makes category, map, and source context easier to read. | Low to medium. | Low. | app/globals.css faint text tokens and components using them. | Visual-only accessibility fix. |
| Related stories are conditional; the observed article had no related block and no strong next-reading suggestion. | Add a compact fallback to latest stories, category, or map when no related match exists. | Medium: gives readers a continuation path. | Low. | Medium. | app/noticias/[slug]/page.tsx and article related-content component. | Behavior/content. |

### P2 — polish / later (4)

| Current issue | Proposed change | User impact | Visual impact | Complexity | Affected component/file | Behavior or visual-only |
| --- | --- | --- | --- | --- | --- | --- |
| Inter/Manrope communicate clearly but are familiar technology-product choices. | Explore a more editorial display voice in a direction study; preserve body readability and avoid introducing a font without a clear gain. | Low to medium: improves brand recall. | Medium. | Medium. | Global typography tokens in app/globals.css and root font setup. | Visual-only. |
| Uppercase mono kickers recur across sections and controls. | Reduce repeated eyebrow labels and use mono only when it communicates data/time. | Low: reduces visual noise. | Low to medium. | Low. | Hero, section headers, map labels, global styles. | Visual-only. |
| Secondary chips are 30–34px high, smaller than the 44px primary CTAs. | Increase high-use mobile filter/toggle targets where room allows, keeping the map canvas visible. | Low to medium: easier touch operation. | Low. | Low. | Filter chips and map controls. | Visual-only interaction/accessibility. |
| Glow and repeated arrow accents are useful around primary signals but recur in several locations. | Reserve glow and directional decoration for the strongest action or signal. | Low: makes emphasis more intentional. | Low. | Low. | Hero/globe, selected filters, link/button styles. | Visual-only. |

## HORIZAI-UI SKILL DRAFT

Draft only. Do not install globally or add a skill file until a later implementation phase.

    ---
    name: horizai-ui
    description: Use when auditing, planning, refining, or implementing HorizAI web UI routes, themes, content states, map experiences, and responsive layouts.
    ---

    # HorizAI UI

    ## Before changing code
    - Read docs/product-principles.md and identify the user journey and observed problem.
    - Inspect the real rendered route, including loading, empty, error, dark/light, and mobile states relevant to the change.
    - Read the installed Next.js guide under node_modules/next/dist/docs/ before changing Next APIs or conventions.
    - Follow OBSERVE → PLAN → EXECUTE → CRITIQUE → VERIFY. Keep scope to demonstrated CRITICAL or IMPORTANT findings; use POLISH only when clear and low risk.

    ## Product identity
    - HorizAI is premium Spanish-language global AI intelligence/news: editorial authority, technology, clarity, speed, and global perspective.
    - Keep navy/near-black as the dark foundation and use electric blue for meaningful signals, selected states, and key actions.
    - Design light mode intentionally with readable paper-like surfaces and clear separation.
    - Preserve the brand and architecture. Do not imitate another product’s visual style.
    - Write natural Spanish with correct accents and punctuation.

    ## Hierarchy and typography
    - Make the product promise or lead story immediately understandable; distinguish product identity from a changing news headline.
    - Order content as headline, summary, evidence/context, metadata, then action. Metadata stays secondary.
    - Use a display face for editorial hierarchy and a highly readable body face. Keep the type system small; use mono only for time/count/data.
    - Keep reading measure comfortable, headings distinct, and normal text at least 4.5:1 contrast.
    - Avoid piles of tiny uppercase labels, generic type pairings without a reason, and decorative type that hurts scanning.

    ## Composition and content
    - Prefer open editorial surfaces and hierarchy over a grid of containers.
    - Give every card, metric, label, and control a clear reader need.
    - Use compact featured stories and scannable latest rows. Adapt low-content rails to the actual item count.
    - Never invent volume, freshness, location, source, or activity statistics.
    - Use real imagery when verified and available. Make missing-image fallbacks deliberate and useful.

    ## Map
    - Keep one global interactive map as a tool, not a decorative background.
    - Preserve Nodes for connections/hubs and Heat for intensity/concentration.
    - Show only real coordinates. Explain coverage window, attribution, and sparse/unlocated data plainly.
    - Keep filters compact and accessible; do not let overlays hide useful canvas area.
    - The hero globe may communicate global scope but must not imply exact geolocation.

    ## Articles and trust
    - Give the headline, summary, “Por qué importa,” readable body, date, and reading time a stable hierarchy.
    - Keep the reading column comfortable and body copy sustained.
    - Name and link sources clearly. Do not claim fact-checking that is not supported by the content.
    - Provide a useful continuation path when there are no related-story matches.

    ## Responsive, interaction, and accessibility
    - Treat mobile as its own composition; check 1920×1080, 1440×900, 1366×768, 1280×800, 1024×768, 768×1024, 390×844, and 375×812.
    - Confirm there is no horizontal overflow; keep map, controls, cards, and article text within the viewport.
    - Use semantic landmarks, ordered headings, keyboard-operable controls, visible focus, meaningful accessible names, and useful alt text.
    - Prefer comfortable touch targets; respect prefers-reduced-motion.
    - Make loading, empty, stale, and error states explain what is happening and how to continue.

    ## Avoid
    - Generic SaaS card grids, dashboard overload, crypto styling, and corporate landing-page clichés.
    - Glow, gradient, blue surfaces, pills, eyebrow labels, mono text, arrows, or animation used as filler.
    - Fake metrics, unsupported map markers, and decorative globe callouts that look like exact location data.
    - Tiny low-contrast text, desktop layouts compressed onto mobile, and new controls without a reader need.

    ## Definition of done
    - The observed problem and scope are explicit; the smallest justified change is implemented.
    - Critique confirms the cause was addressed without degrading nearby content or behavior.
    - Verify affected routes, states, themes, keyboard/focus, responsive sizes, console, lint, and build; report any check that could not run.
    - Do not redesign unrelated areas. Keep the result aligned with docs/product-principles.md.

## RUN / CHANGE LOG

- The frontend was inspected in the existing local development server at localhost:3000; a new server process was not started because the repository server was already active.
- Browser interaction was read-only. The page made public content reads and loaded public map style/tile assets. No database writes were made.
- No editorial pipeline was invoked and no model/provider calls were made.
- No production UI, pipeline, database, Netlify, or deployment state was changed. The only new working-tree entries are this report, its JSON companion, and the screenshots listed above; pre-existing changes were left untouched, and nothing was staged or committed.
- npm run lint passed. A production build and tests were not run: the existing development server remained active and a build could conflict with its output directory. This phase made no executable-code changes. The local browser render and responsive overflow observations are the UI verification evidence.

## FINAL REPORT

- **Screenshots captured:** YES — 13 real browser captures.
- **Desktop:** 1440×900 CSS viewport; homepage hero, map, featured stories, latest news, full page, one real article, and selected light-mode equivalents.
- **Mobile:** 390×844 CSS viewport; homepage, map, and the same real article in dark mode.
- **Current UI strengths:** clear editorial hierarchy, purposeful global map, compact latest list, article reading width, intentional mobile stack, dark and light themes, and reduced-motion support.
- **Largest UI weaknesses:** unclear product promise on mobile, stale-looking local latest set with no freshness context, sparse map/card content, low-contrast micro-labels, and no related-story fallback for this article.
- **Implementation drift from approved hero:** the current lead is a story instead of a fixed promise; mobile loses the desktop tagline; card art and content freshness are weaker than the reference’s image-led editorial impression. Brand colors, globe, global motif, and dedicated map remain.
- **Generic AI UI patterns found:** partial recurring glow/gradients, pills, mono labels, eyebrows, arrows, repeated card structure, and sparse whitespace; no generic SaaS dashboard or all-box layout.
- **Official UI/frontend skills reviewed:** Anthropic/Claude Code frontend-design, official Anthropic skills and skill-creator, Claude Code skill-development, and Claude Code skills docs. Impeccable was reviewed as community guidance only.
- **Recommended visual direction:** Atlas Editorial.
- **P0 count:** 2.
- **P1 count:** 5.
- **P2 count:** 4.
- **Proposed horizai-ui skill:** YES — draft included above; not installed or added as a separate file.
- **Code changed:** NO.
- **Provider calls:** 0.
- **Remote writes:** 0.
- **NEXT:** WAIT FOR HUMAN VISUAL REVIEW.

**DETENERSE.**
