<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# HorizAI product workflow

Before changing any code, read and follow [`docs/product-principles.md`](docs/product-principles.md). It is the project's source of truth for product intent, visual and UX constraints, responsive coverage, acceptance criteria, and the required **OBSERVE → PLAN → EXECUTE → CRITIQUE → VERIFY** workflow.

Do not make visual changes by default. Keep every intervention within the requested scope, preserve working architecture, and make only changes justified by observed product problems and the severity rules in that guide.
