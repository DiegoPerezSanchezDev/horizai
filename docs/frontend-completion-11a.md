# HorizAI Frontend Completion — Phase 11A

**Date:** 2026-09-27  
**Closure:** 11A READY YES  
**Workflow:** OBSERVE → PLAN → EXECUTE → CRITIQUE → VERIFY

## INITIAL AUDIT

The initial frontend already had a header, approved editorial hero direction, map surface, story sections, article route, theme toggle, and footer. Several sections still displayed fixture content or depended on mock data; the public article view was not connected to the landing/article path. Empty, failure, and unpublished-slug behavior was incomplete. Light mode and smaller viewport layouts needed review, and metadata/accessibility coverage was partial.

| Area | Initial status | Initial finding |
|---|---|---|
| Header | PARTIAL | Existing navigation and theme control; dead actions remained. |
| Hero | PARTIAL | Approved visual base existed, but content was not consistently tied to a public story. |
| Map | PARTIAL | Existing MapLibre surface used mock map data. |
| Featured stories | PARTIAL | Section existed with fixture content. |
| Latest stories | PARTIAL | Section existed with fixture content. |
| Article cards | PARTIAL | Card UI existed, but public data and truthful missing-image behavior were incomplete. |
| Article page | PARTIAL | UI and fixture slugs existed; public slug lookup and safe not-found behavior were incomplete. |
| Sources block | PARTIAL | Presentation existed but did not consistently use the public article contract. |
| Context block | PARTIAL | Presentation existed but did not consistently use actual article context. |
| Footer | PARTIAL | Some controls/claims had no working destination or verified basis. |
| Mobile | PARTIAL | Existing responsive styling; needed full-width and interaction review. |
| Tablet | PARTIAL | Existing responsive styling; needed breakpoint review. |
| Desktop | PARTIAL | Overall product structure existed; data and states were incomplete. |
| Dark mode | PARTIAL | Theme support existed; map/theme behavior needed verification. |
| Light mode | PARTIAL | Theme support existed; map style did not reliably follow it. |
| Loading states | MISSING | No complete public-content loading treatment. |
| Empty states | MISSING | Zero published rows did not have a consistent truthful presentation. |
| Error states | MISSING | Public-read failures lacked a consistent safe presentation. |
| SEO | PARTIAL | Baseline metadata existed; public article-specific metadata/not-found coverage was incomplete. |
| Real data connection | MISSING | Landing, map, and article path were not connected to the public published-article view. |

## IMPLEMENTED CHANGES

- Connected server-rendered landing and article reads to `public.public_published_articles`, using only the Supabase URL and publishable/anonymous key.
- Added field mapping and validation for published articles, safe source URLs, categories, entities, article body blocks, dates, and usable coordinates.
- Replaced production-path fixture stories and map points with the public view data. Removed the old public-facing fixture modules and dead controls/claims.
- Added explicit ready, loading, empty, read-error, and not-found presentations. Invalid or unpublished slugs call `notFound()`.
- Kept MapLibre client-only and data-driven. Map markers represent actual mapped public articles; duplicate coordinates are grouped. Filters and related stories use actual available article data.
- Added and ran focused public-content unit checks.
- No model/provider calls, migrations, schema changes, production writes, scheduler/pipeline/publisher changes, Cloudflare route activation, cron, or deployment were performed.

## HOME

The home page keeps the established HorizAI hierarchy and the approved hero artwork at `docs/references/hero-approved.png`. A published article is used when available; with no public rows, the hero and story sections show a clear empty state instead of invented news, metrics, or recency claims. The home query selects card/map fields only, orders by publication time, limits results to 36, and presents the recent 30-day window without changing archive visibility.

The production-mode `GET /` returned HTTP 200 and the correct empty-content state during verification.

## MAP

The map receives only public published article summaries with valid coordinates. It clusters marker features, groups duplicate locations, provides region/category/date filtering, and offers a heat view based on those same records. The selected-location panel links to real articles. No data-derived markers or connections are fabricated.

The public view contained zero rows during verification, so the production map correctly displayed its no-data state. A temporary, isolated browser QA fixture was used to review marker/layout styling, map filters, the heat view, and dark/light map styles; that route is absent from the final app tree. Filter and view interactions were observed. A map-marker click was not conclusively exercised in browser QA.

## ARTICLE

`/noticias/[slug]` loads an exact published slug from the same public view. It renders actual headline, summary, body, publication date, context, safe original source links, and related articles where the public record supplies them. Body text is rendered as text and supported headings, lists, and safe HTTP(S) links; absent context, sources, or images are not invented.

The production-mode request for an unknown slug returned HTTP 404 and a branded, `noindex` not-found page. Article errors have a separate safe message. A temporary browser fixture confirmed the content layout on desktop and mobile, then was removed.

## REAL DATA

The frontend reads `public.public_published_articles`, whose public/RLS contract exposes published rows. The public query was verified with the publishable key and returned **0 rows**. Therefore `realDataConnected` is true, while current production content is empty. There is no fake-story fallback in the production home, article, or map path. Historical articles remain queryable by exact slug; the homepage window does not delete or unpublish archive records.

The frontend does not import the elevated server client. A search of generated browser assets found no `SUPABASE_SECRET_KEY` or `SUPABASE_SECRET` references. The existing server-only backend client remains outside this phase's public frontend reads.

## THEME

Dark and light appearances passed browser review. The map's dark/light style now follows the selected theme, including after theme changes. The approved dark navy/electric-blue identity remains intact.

## RESPONSIVE

Browser review found no horizontal overflow at **375px, 768px, 1024px, or 1440px**. Home shell, navigation, hero, map section, and article layout were reviewed at mobile and desktop sizes; tablet widths were checked for overflow and section fit.

## LOADING/EMPTY/ERROR

- **Loading:** the home route has a local Suspense skeleton; the lazy MapLibre client has a loading fallback.
- **Empty:** home story areas and the map describe the absence of published public content.
- **Read error:** home/map and article paths show non-technical safe states.
- **Not found:** an unknown/unpublished slug produces an HTTP 404 with `noindex`.

The article route intentionally has no route-level streaming loading boundary: in the installed Next.js version, streaming a not-found response can return HTTP 200. Keeping this route unstreamed preserves the verified HTTP 404 behavior.

One build-time homepage public-read failure was logged during static collection, but the build completed successfully and a later production-mode request returned the expected empty state. The safe read-error state remains in place if the public service is unavailable.

## SEO

The home page has Spanish title, description, Open Graph metadata, and a canonical URL when a valid `NEXT_PUBLIC_SITE_URL` is configured. Article metadata uses the actual headline, summary, publication time, and slug. Unknown articles have noindex not-found behavior. No author, publication date, or image is fabricated.

## ACCESSIBILITY

The public shell includes a skip link, semantic landmarks/headings, keyboard-visible focus, accessible theme and map controls, and a keyboard-usable article list/panel. The map retains attribution and a linked story-panel path for users who do not use the map canvas.

## PERFORMANCE

Page data loads on the server. Homepage selection is bounded and avoids full article bodies; the full article query runs only on its route. MapLibre stays isolated as client code, marker data is bounded by the homepage query, and React request caching avoids duplicate reads in a render. Public responses use no-store fetch behavior rather than adding a new cache layer.

## REMAINING VISUAL ASSETS

The public view has no article-image field. Cards therefore use a restrained category treatment rather than a fake story thumbnail. The approved globe remains brand artwork and is not presented as article/map data. If a public image field is added through a separately approved schema phase, real article imagery can be connected then.

## LIMITATIONS

- No public articles were available at verification time, so a real published article body, source block, and production map marker could not be visually compared against live content. Their rendering was reviewed using an isolated temporary QA fixture and model/unit checks.
- Browser QA did not conclusively click a map marker, although the selection behavior is implemented in the map source.
- One transient public-read failure appeared in the successful build log, as recorded above.
- No deployment or production routing change was made.

## NEXT STEP

**Stop for human visual/product review.** If approved, a later explicit decision can cover Netlify deployment or scheduler activation. Neither is part of 11A.
