import assert from "node:assert/strict";

import { getFeaturedStoriesGridConfig } from "../components/news/featured/featured-stories-layout.ts";

for (const count of [0, 1, 2, 3, 5, 12]) {
  const stories = Array.from({ length: count }, (_, index) => ({
    imageUrl: index === 0 ? "/qa/lead.jpg" : null,
  }));
  const config = getFeaturedStoriesGridConfig(stories);

  assert.equal(config.count, count, `count ${count} remains available to the grid`);
  assert.equal(config.leadHasImage, count > 0, `lead image state is represented for count ${count}`);
  assert.equal(config.tailRemainder, count >= 4 ? (count - 2) % 3 : 0, `final row is balanced for count ${count}`);
}

assert.equal(getFeaturedStoriesGridConfig([{ imageUrl: null }]).leadHasImage, false, "text-only lead is identified");
assert.equal(getFeaturedStoriesGridConfig([{ imageUrl: "/qa/lead.jpg" }]).leadHasImage, true, "image lead is identified");

process.stdout.write("FEATURED_STORIES_LAYOUT PASS counts=0,1,2,3,5,12 lead-image=true,false\n");
