import assert from "node:assert/strict";

import {
  createMapArticleHref,
  getMapReturnHref,
  mergeMapUrlState,
  parseMapUrlState,
  serializeMapUrlState,
  shouldShowHeatIntensityLegend,
} from "../components/maps/global-intelligence-map/map-url-state.ts";

const available = {
  regions: [{ code: "global" }, { code: "europe" }],
  categories: [{ slug: "robotics" }, { slug: "investigacion" }],
};
const defaults = {
  mode: "nodes",
  filters: { timeRange: "30d", region: null, category: null },
};

assert.deepEqual(parseMapUrlState(new URLSearchParams(), available), defaults, "missing values use defaults");
assert.deepEqual(parseMapUrlState(new URLSearchParams("map=heat"), available), {
  ...defaults,
  mode: "heat",
}, "Heat can be restored independently");

const filtered = {
  mode: "heat",
  filters: { timeRange: "7d", region: "global", category: "robotics" },
};
const serialized = serializeMapUrlState(filtered);
assert.equal(serialized.toString(), "map=heat&period=7d&region=global&topic=robotics");
assert.deepEqual(parseMapUrlState(serialized, available), filtered, "all supported map fields round-trip");

assert.deepEqual(parseMapUrlState(new URLSearchParams("map=globe&period=2h&region=unknown&topic=unknown"), available), defaults, "invalid values safely fall back");
assert.deepEqual(parseMapUrlState(new URLSearchParams("map=heat&region=europe"), available), {
  mode: "heat",
  filters: { timeRange: "30d", region: "europe", category: null },
}, "partial valid state is retained");

const merged = mergeMapUrlState(new URLSearchParams("utm_source=qa&map=nodes&period=bogus&topic=old"), filtered);
assert.equal(merged.toString(), "utm_source=qa&map=heat&period=7d&region=global&topic=robotics", "map updates preserve unrelated query parameters and replace map keys");

const articleHref = createMapArticleHref("/noticias/story", filtered);
assert.equal(articleHref, "/noticias/story?fromMap=1&map=heat&period=7d&region=global&topic=robotics", "map article links carry compact return context");
assert.equal(getMapReturnHref({ fromMap: "1", map: "heat", period: "7d", region: "global", topic: "robotics" }), "/?map=heat&period=7d&region=global&topic=robotics#mapa-global");
assert.equal(getMapReturnHref({ fromMap: "1", map: "unknown", period: "bad", region: "https://elsewhere.test", topic: ["robotics"] }), "/#mapa-global", "article return context is allow-listed and malformed values are ignored");
assert.equal(getMapReturnHref({}), null, "non-map article navigation remains unchanged");

assert.equal(shouldShowHeatIntensityLegend("heat", "ready", 1), true);
assert.equal(shouldShowHeatIntensityLegend("nodes", "ready", 1), false, "Nodes never shows the Heat scale");
assert.equal(shouldShowHeatIntensityLegend("heat", "error", 1), false, "Heat scale is hidden on map errors");
assert.equal(shouldShowHeatIntensityLegend("heat", "ready", 0), false, "Heat scale is hidden without mapped locations");

process.stdout.write("MAP_URL_STATE PASS defaults, validation, round-trip, article return, legend gating\n");
