import { cn } from "@/components/ui/utils";
import type { PublicArticleSummary } from "@/lib/public-content-model";

const positions = [
  "hero-callout-left left-[3%] top-[16%]",
  "hero-callout-right right-[4%] top-[8%]",
  "hero-callout-right right-[-1%] top-[42%]",
  "hero-callout-left left-[5%] bottom-[10%]",
];

function shortHeadline(text: string, max = 52): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).replace(/[s,.;:–-]+$/, "")}…`;
}

function getCode(story: PublicArticleSummary): string {
  const value = story.regionCode ?? story.categories[0]?.slug ?? "IA";
  return value.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "IA";
}

function StoryCallout({ story, compact = false, positionClass = "" }: { story: PublicArticleSummary; compact?: boolean; positionClass?: string }) {
  return (
    <div className={compact ? "hero-callout-compact" : cn("hero-callout hero-callout-float", positionClass)}>
      <span className="hero-callout-code" aria-hidden="true">{getCode(story)}</span>
      <div className="min-w-0">
        <p className="hero-callout-region">{story.regionName ?? story.categories[0]?.name ?? "IA"}</p>
        <p className="hero-callout-detail line-clamp-2">{shortHeadline(story.headline)}</p>
      </div>
    </div>
  );
}

export function HeroCallouts({ stories, mobile = false }: { stories: readonly PublicArticleSummary[]; mobile?: boolean }) {
  if (stories.length === 0) return null;

  if (mobile) {
    return (
      <div className="hero-callouts-mobile relative z-20 -mx-4 mb-3 px-4 lg:hidden">
        <div className="scroll-x">
          <div className="hero-callout-rail w-max pr-4">
            {stories.map((story) => <StoryCallout compact key={story.slug} story={story} />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 hidden lg:block" aria-hidden="true">
      {stories.map((story, index) => <StoryCallout key={story.slug} story={story} positionClass={positions[index % positions.length]} />)}
    </div>
  );
}
