const POLL_INTERVAL_MS = 30 * 1000;
const REDDIT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12 * 1000;
const PLACE_SEARCH_MIN_INTERVAL_MS = 1_000;
const SCORE_UNITS_PER_PERCENT = 1_000_000_000;
const BASE_SCORE_UNITS = 8_420_000_000;
const MAX_SCORE_UNITS = 100 * SCORE_UNITS_PER_PERCENT;
const REPORT_BATCH_SIZE = 1_000;
const REPORTS_PER_REFERENCE_SHIFT = 100_000;
const REFERENCE_SHIFT_PERCENT = 0.01;
const SCORE_STORAGE_KEY = "world-unity-live-log-counter-v6";
const LEGACY_SCORE_KEYS = [
  "world-unity-feed-counter-v2",
  "world-unity-real-feed-counter-v3",
  "world-unity-tiered-counter-v4",
  "world-unity-weighted-counter-v5",
];
const SEEN_LIMIT = 5_000;
const DISPLAY_LIMIT = 80;
const ITEM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_COUNTRY_LABELS = 5;
const MAX_GLOBE_PIXEL_RATIO = 2;
const GLOBE_TEXTURE_URL =
  "https://unpkg.com/three-globe@2.41.12/example/img/earth-blue-marble.jpg";
const GLOBE_BUMP_TEXTURE_URL =
  "https://unpkg.com/three-globe@2.41.12/example/img/earth-topology.png";
const CONTINENTS = [
  { id: "americas", name: "Americas", lat: 39, lng: -98 },
  { id: "europe", name: "Europe", lat: 50, lng: 15 },
  { id: "africa", name: "Africa", lat: 2, lng: 20 },
  { id: "asia", name: "Asia", lat: 34, lng: 100 },
  { id: "oceania", name: "Oceania", lat: -25, lng: 134 },
];
const SIGNAL_CATEGORIES = new Set([
  "micro-good-deed",
  "major-news",
  "global-milestone",
]);
const REDDIT_FEEDS = [
  { id: "source-uplifting", subreddit: "UpliftingNews" },
  { id: "source-kindness", subreddit: "RandomActsOfKindness" },
  { id: "source-assistance", subreddit: "Assistance" },
];

const elements = {
  liveIndicator: document.querySelector("#live-indicator"),
  liveLabel: document.querySelector("#live-label"),
  scoreNumber: document.querySelector("#score-number"),
  progressTrack: document.querySelector("#progress-track"),
  progressFill: document.querySelector("#progress-fill"),
  tickerList: document.querySelector("#ticker-list"),
  pollStatus: document.querySelector("#poll-status"),
  connectionMap: document.querySelector("#connection-map"),
  pauseMap: document.querySelector("#pause-map"),
  placeSearchForm: document.querySelector("#place-search-form"),
  placeSearchInput: document.querySelector("#place-search"),
  placeSearchStatus: document.querySelector("#place-search-status"),
  placeSearchResults: document.querySelector("#place-search-results"),
  scoreChange: document.querySelector("#score-change"),
  accordCount: document.querySelector("#accord-count"),
  accordNote: document.querySelector("#accord-note"),
  peaceScore: document.querySelector("#peace-score"),
  lastUpdated: document.querySelector("#last-updated"),
};

function readCounter() {
  try {
    for (const key of LEGACY_SCORE_KEYS) localStorage.removeItem(key);
    const saved = localStorage.getItem(SCORE_STORAGE_KEY);
    if (!saved) {
      return {
        units: BASE_SCORE_UNITS,
        volumeUnits: 0,
        seen: new Set(),
        recentItems: [],
        lastSuccessfulPollAt: Date.now(),
        warning: null,
      };
    }

    const parsed = JSON.parse(saved);
    if (
      !Number.isSafeInteger(parsed.units) ||
      parsed.units < BASE_SCORE_UNITS ||
      parsed.units > MAX_SCORE_UNITS ||
      !Number.isSafeInteger(parsed.volumeUnits) ||
      parsed.volumeUnits < 0 ||
      parsed.units !== scoreUnitsForVolume(parsed.volumeUnits) ||
      !Array.isArray(parsed.seen) ||
      (parsed.recentItems !== undefined &&
        !Array.isArray(parsed.recentItems)) ||
      !Number.isFinite(parsed.lastSuccessfulPollAt) ||
      parsed.lastSuccessfulPollAt > Date.now()
    ) {
      throw new Error("Saved tally has an unexpected format");
    }

    return {
      ...parsed,
      units: parsed.units,
      seen: new Set(
        parsed.seen
          .filter((key) => typeof key === "string")
          .slice(-SEEN_LIMIT),
      ),
      recentItems: [],
      warning: null,
    };
  } catch (error) {
    return {
      units: BASE_SCORE_UNITS,
      volumeUnits: 0,
      seen: new Set(),
      recentItems: [],
      lastSuccessfulPollAt: Date.now(),
      warning: `Saved tally could not be read: ${error.message}`,
    };
  }
}

const counter = readCounter();
let refreshing = false;
let displayedUnits = counter.units;
let streamItems = new Map(
  counter.recentItems.map((item) => [item.key, item]),
);
let mapPaused = false;
let mapEvents = [];
let globe = null;
let globeControls = null;
let globeResizeObserver = null;
let globeIdleTimer = 0;
let globeLoadTimer = 0;
let globePinElements = new Map();
let selectedGlobePinId = null;
let pendingPlace = null;
let placeSearchController = null;
let placeSearchSequence = 0;
let lastPlaceSearchAt = 0;
let lastRedditPollAt = 0;
const cachedRedditResults = new Map();
let baselinePreviewItems = [];
const signalVisibility = new Map([
  ["micro-good-deed", 1],
  ["major-news", 1],
  ["global-milestone", 1],
]);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function parseTimestamp(value) {
  if (typeof value !== "string") return new Date(value);
  return new Date(
    /(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})$/i.test(value)
      ? value
      : `${value}Z`,
  );
}

function isWithinCurrentCycle(value, now = Date.now()) {
  const publishedAt = parseTimestamp(value).getTime();
  const age = now - publishedAt;
  return Number.isFinite(publishedAt) && age >= 0 && age <= ITEM_MAX_AGE_MS;
}

function scoreText(units) {
  return (units / SCORE_UNITS_PER_PERCENT).toFixed(4);
}

function preciseScoreText(units) {
  return (units / SCORE_UNITS_PER_PERCENT).toFixed(9);
}

function roundedVolume(volumeUnits) {
  return Math.floor(volumeUnits / REPORT_BATCH_SIZE) * REPORT_BATCH_SIZE;
}

function scoreUnitsForVolume(volumeUnits) {
  const accumulatedVolume = roundedVolume(volumeUnits);
  const increasePercent =
    REFERENCE_SHIFT_PERCENT *
    Math.log1p(accumulatedVolume / REPORTS_PER_REFERENCE_SHIFT) /
    Math.LN2;
  return Math.min(
    MAX_SCORE_UNITS,
    BASE_SCORE_UNITS +
      Math.round(increasePercent * SCORE_UNITS_PER_PERCENT),
  );
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const GEO_LOCATIONS = [
  { name: "United States", region: "americas", lat: 38.9, lng: -77, terms: ["united states", "usa", "american", "new york", "washington dc", "los angeles", "california", "texas"] },
  { name: "Canada", region: "americas", lat: 45.4, lng: -75.7, terms: ["canada", "canadian", "toronto", "ottawa", "montreal", "vancouver"] },
  { name: "Mexico", region: "americas", lat: 19.4, lng: -99.1, terms: ["mexico", "mexican"] },
  { name: "Brazil", region: "americas", lat: -15.8, lng: -47.9, terms: ["brazil", "brazilian", "sao paulo", "brasilia"] },
  { name: "Argentina", region: "americas", lat: -34.6, lng: -58.4, terms: ["argentina", "argentine", "buenos aires"] },
  { name: "United Kingdom", region: "europe", lat: 51.5, lng: -0.1, terms: ["united kingdom", "britain", "british", "england", "london"] },
  { name: "France", region: "europe", lat: 48.9, lng: 2.3, terms: ["france", "french", "paris"] },
  { name: "Germany", region: "europe", lat: 52.5, lng: 13.4, terms: ["germany", "german", "berlin"] },
  { name: "Italy", region: "europe", lat: 41.9, lng: 12.5, terms: ["italy", "italian", "rome"] },
  { name: "Spain", region: "europe", lat: 40.4, lng: -3.7, terms: ["spain", "spanish", "madrid"] },
  { name: "Ukraine", region: "europe", lat: 50.5, lng: 30.5, terms: ["ukraine", "ukrainian", "kyiv"] },
  { name: "Poland", region: "europe", lat: 52.2, lng: 21, terms: ["poland", "polish", "warsaw"] },
  { name: "Sweden", region: "europe", lat: 59.3, lng: 18.1, terms: ["sweden", "swedish", "stockholm"] },
  { name: "Norway", region: "europe", lat: 59.9, lng: 10.8, terms: ["norway", "norwegian", "oslo"] },
  { name: "Russia", region: "europe", lat: 55.8, lng: 37.6, terms: ["russia", "russian", "moscow"] },
  { name: "Turkey", region: "europe", lat: 39.9, lng: 32.9, terms: ["turkey", "turkish", "ankara"] },
  { name: "Israel", region: "asia", lat: 31.8, lng: 35.2, terms: ["israel", "israeli", "tel aviv"] },
  { name: "Palestine", region: "asia", lat: 31.9, lng: 35.2, terms: ["palestine", "palestinian", "gaza", "west bank"] },
  { name: "Egypt", region: "africa", lat: 30, lng: 31.2, terms: ["egypt", "egyptian", "cairo"] },
  { name: "Nigeria", region: "africa", lat: 9.1, lng: 7.5, terms: ["nigeria", "nigerian", "lagos"] },
  { name: "Kenya", region: "africa", lat: -1.3, lng: 36.8, terms: ["kenya", "kenyan", "nairobi"] },
  { name: "Ethiopia", region: "africa", lat: 9, lng: 38.7, terms: ["ethiopia", "ethiopian", "addis ababa"] },
  { name: "Ghana", region: "africa", lat: 5.6, lng: -0.2, terms: ["ghana", "ghanaian", "accra"] },
  { name: "South Africa", region: "africa", lat: -25.7, lng: 28.2, terms: ["south africa", "south african", "johannesburg", "cape town"] },
  { name: "Morocco", region: "africa", lat: 34, lng: -6.8, terms: ["morocco", "moroccan", "rabat"] },
  { name: "China", region: "asia", lat: 39.9, lng: 116.4, terms: ["china", "chinese", "beijing", "shanghai"] },
  { name: "India", region: "asia", lat: 28.6, lng: 77.2, terms: ["india", "indian", "new delhi", "mumbai"] },
  { name: "Japan", region: "asia", lat: 35.7, lng: 139.7, terms: ["japan", "japanese", "tokyo"] },
  { name: "South Korea", region: "asia", lat: 37.6, lng: 127, terms: ["south korea", "south korean", "seoul"] },
  { name: "North Korea", region: "asia", lat: 39, lng: 125.8, terms: ["north korea", "north korean", "pyongyang"] },
  { name: "Pakistan", region: "asia", lat: 33.7, lng: 73.1, terms: ["pakistan", "pakistani", "islamabad"] },
  { name: "Bangladesh", region: "asia", lat: 23.8, lng: 90.4, terms: ["bangladesh", "bangladeshi", "dhaka"] },
  { name: "Indonesia", region: "asia", lat: -6.2, lng: 106.8, terms: ["indonesia", "indonesian", "jakarta"] },
  { name: "Philippines", region: "asia", lat: 14.6, lng: 121, terms: ["philippines", "filipino", "manila"] },
  { name: "Vietnam", region: "asia", lat: 21, lng: 105.8, terms: ["vietnam", "vietnamese", "hanoi"] },
  { name: "Thailand", region: "asia", lat: 13.8, lng: 100.5, terms: ["thailand", "thai", "bangkok"] },
  { name: "Taiwan", region: "asia", lat: 25, lng: 121.6, terms: ["taiwan", "taiwanese", "taipei"] },
  { name: "Nepal", region: "asia", lat: 27.7, lng: 85.3, terms: ["nepal", "nepalese", "kathmandu"] },
  { name: "Saudi Arabia", region: "asia", lat: 24.7, lng: 46.7, terms: ["saudi arabia", "saudi", "riyadh"] },
  { name: "Iran", region: "asia", lat: 35.7, lng: 51.4, terms: ["iran", "iranian", "tehran"] },
  { name: "Iraq", region: "asia", lat: 33.3, lng: 44.4, terms: ["iraq", "iraqi", "baghdad"] },
  { name: "United Arab Emirates", region: "asia", lat: 24.5, lng: 54.4, terms: ["united arab emirates", "uae", "dubai", "abu dhabi"] },
  { name: "Australia", region: "oceania", lat: -35.3, lng: 149.1, terms: ["australia", "australian", "sydney", "melbourne", "canberra"] },
  { name: "New Zealand", region: "oceania", lat: -41.3, lng: 174.8, terms: ["new zealand", "auckland", "wellington"] },
  { name: "Fiji", region: "oceania", lat: -18.1, lng: 178.4, terms: ["fiji", "fijian", "suva"] },
].map((location, index) => ({ ...location, id: `location-${index}` }));

function inferLocations(item) {
  const text = `${item.title} ${item.text ?? ""}`.toLowerCase();
  return GEO_LOCATIONS
    .map((location) => {
      const firstMention = Math.min(
        ...location.terms.map((term) => {
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const match = new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`).exec(text);
          return match ? match.index : Number.POSITIVE_INFINITY;
        }),
      );
      return { location, firstMention };
    })
    .filter(({ firstMention }) => Number.isFinite(firstMention))
    .sort((a, b) => a.firstMention - b.firstMention)
    .map(({ location }) => location);
}

function routeForItem(item) {
  const namedLocations = inferLocations(item);
  if (namedLocations.length >= 2) {
    return { from: namedLocations[0], to: namedLocations[1], inferred: false };
  }

  const hash = hashText(item.key);
  const origin = namedLocations[0] ?? CONTINENTS[hash % CONTINENTS.length];
  const alternatives = CONTINENTS.filter(
    (continent) => continent.id !== origin.region && continent.id !== origin.id,
  );
  const destination = alternatives[(hash >>> 8) % alternatives.length];
  return { from: origin, to: destination, inferred: true };
}

function arcForEvent(event) {
  return {
    startLat: event.route.from.lat,
    startLng: event.route.from.lng,
    endLat: event.route.to.lat,
    endLng: event.route.to.lng,
  };
}

function isGlobePinVisible(pin, view) {
  const pinLatitude = pin.lat * Math.PI / 180;
  const pinLongitude = pin.lng * Math.PI / 180;
  const viewLatitude = view.lat * Math.PI / 180;
  const viewLongitude = view.lng * Math.PI / 180;
  const facingDot =
    Math.sin(pinLatitude) * Math.sin(viewLatitude) +
    Math.cos(pinLatitude) * Math.cos(viewLatitude) *
      Math.cos(pinLongitude - viewLongitude);
  const horizonDot = 1 / (1 + view.altitude);
  return facingDot > horizonDot + 0.015;
}

function updateGlobePinOcclusion() {
  if (!globe || globePinElements.size === 0) return;
  const view = globe.pointOfView();
  if (!view) return;

  for (const [id, pin] of globePinElements) {
    const visible = isGlobePinVisible(pin.dataset, view);
    const occluded = !visible;
    if (pin.classList.contains("is-occluded") !== occluded) {
      pin.classList.toggle("is-occluded", occluded);
    }
    if (pin.tabIndex !== (visible ? 0 : -1)) pin.tabIndex = visible ? 0 : -1;
    if (pin.getAttribute("aria-hidden") !== String(occluded)) {
      pin.setAttribute("aria-hidden", String(occluded));
    }
    if (!visible && selectedGlobePinId === id) selectedGlobePinId = null;
    const selected = selectedGlobePinId === id;
    if (pin.classList.contains("is-selected") !== selected) {
      pin.classList.toggle("is-selected", selected);
    }
  }
}

function selectGlobePin(label) {
  selectedGlobePinId =
    selectedGlobePinId === label.id ? null : label.id;
  for (const [id, pin] of globePinElements) {
    pin.classList.toggle("is-selected", selectedGlobePinId === id);
  }

  if (label.type === "region") {
    selectRegion(label.id);
  } else if (selectedGlobePinId) {
    globe.pointOfView(
      { lat: label.lat, lng: label.lng, altitude: 1.25 },
      reduceMotion ? 0 : 850,
    );
  }
}

function createGlobePin(label) {
  const pin = document.createElement("button");
  pin.className = "globe-pin";
  pin.type = "button";
  pin.dataset.globePinId = label.id;
  pin.dataset.lat = String(label.lat);
  pin.dataset.lng = String(label.lng);
  pin.setAttribute(
    "aria-label",
    `${label.name}, ${label.reports} qualifying ${label.reports === 1 ? "report" : "reports"} in the last 24 hours; report totals do not directly change the index`,
  );
  pin.classList.toggle("is-selected", selectedGlobePinId === label.id);

  const dot = document.createElement("span");
  dot.className = "globe-pin-dot";
  dot.setAttribute("aria-hidden", "true");
  pin.append(dot);
  pin.addEventListener("click", (event) => {
    event.stopPropagation();
    selectGlobePin(label);
  });
  pin.addEventListener("pointerenter", () => {
    if (!selectedGlobePinId || selectedGlobePinId === label.id) return;
    selectedGlobePinId = null;
    for (const otherPin of globePinElements.values()) {
      otherPin.classList.remove("is-selected");
    }
  });

  globePinElements.set(label.id, pin);
  return pin;
}

function updateGlobePins() {
  if (!globe) return;

  const regionTallies = new Map(
    CONTINENTS.map((continent) => [
      continent.id,
      { creditUnits: 0, reports: 0 },
    ]),
  );
  const countryTallies = new Map();
  const now = Date.now();

  for (const item of streamItems.values()) {
    const age = now - parseTimestamp(item.time).getTime();
    if (
      item.volumeUnits <= 0 ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > ITEM_MAX_AGE_MS
    ) {
      continue;
    }

    const location = inferLocations(item)[0];
    if (!location) continue;

    const regionTally = regionTallies.get(location.region);
    if (regionTally) {
      regionTally.creditUnits += item.volumeUnits;
      regionTally.reports += 1;
    }

    const countryTally = countryTallies.get(location.id) ?? {
      location,
      creditUnits: 0,
      reports: 0,
    };
    countryTally.creditUnits += item.volumeUnits;
    countryTally.reports += 1;
    countryTallies.set(location.id, countryTally);
  }

  const regionPins = CONTINENTS.map((continent) => ({
    ...continent,
    ...regionTallies.get(continent.id),
    type: "region",
  }));
  const countryPins = Array.from(countryTallies.values())
    .sort((a, b) => b.creditUnits - a.creditUnits || b.reports - a.reports)
    .slice(0, MAX_COUNTRY_LABELS)
    .map(({ location, creditUnits, reports }) => ({
      id: `country-${location.id}`,
      name: location.name,
      lat: location.lat,
      lng: location.lng,
      creditUnits,
      reports,
      type: "country",
    }));

  globePinElements.clear();
  globe.htmlElementsData([...regionPins, ...countryPins]);
  requestAnimationFrame(updateGlobePinOcclusion);
}

function updateGlobeData() {
  if (!globe) return;
  const visibleEvents = mapEvents.filter(
    (event) => (signalVisibility.get(event.category) ?? 1) > 0,
  );
  globe.arcsData(visibleEvents.map(arcForEvent));
}

function setGlobeStatus(message, hidden = false) {
  const status = document.querySelector("#map-load-status");
  status.textContent = message;
  status.hidden = hidden;
}

function scheduleGlobeRotation() {
  if (!globeControls || mapPaused || reduceMotion) return;
  globeControls.autoRotate = false;
  clearTimeout(globeIdleTimer);
  globeIdleTimer = window.setTimeout(() => {
    if (!mapPaused && globeControls) globeControls.autoRotate = true;
  }, 2_000);
}

function addMapEvent(item) {
  mapEvents.push({
    route: routeForItem(item),
    category: item.category,
  });
  if (mapEvents.length > 36) mapEvents.shift();
  updateGlobeData();
}

function selectRegion(regionId) {
  const continent = CONTINENTS.find((candidate) => candidate.id === regionId);
  if (!continent || !globe) return;
  globe.pointOfView(
    { lat: continent.lat, lng: continent.lng, altitude: 1.8 },
    reduceMotion ? 0 : 1_000,
  );
  if (elements.pollStatus) {
    elements.pollStatus.textContent = `REGION · ${continent.name.toUpperCase()}`;
  }
  for (const button of document.querySelectorAll(".map-legend [data-region]")) {
    button.setAttribute("aria-pressed", String(button.dataset.region === regionId));
  }
}

function flyToPlace(place) {
  const location = {
    lat: Number(place.lat),
    lng: Number(place.lon),
  };
  if (
    !Number.isFinite(location.lat) ||
    !Number.isFinite(location.lng) ||
    location.lat < -90 ||
    location.lat > 90 ||
    location.lng < -180 ||
    location.lng > 180
  ) {
    throw new Error("The selected place has invalid coordinates.");
  }

  pendingPlace = location;
  if (globe) {
    globe.pointOfView(
      { ...location, altitude: 0.62 },
      reduceMotion ? 0 : 1_000,
    );
    pendingPlace = null;
  }
  elements.placeSearchInput.value = place.display_name;
  elements.placeSearchResults.replaceChildren();
  elements.placeSearchStatus.textContent = `Centered on ${place.display_name}`;
  scheduleGlobeRotation();
}

async function searchPlaces(query) {
  if (placeSearchController) placeSearchController.abort();
  const controller = new AbortController();
  placeSearchController = controller;
  const sequence = ++placeSearchSequence;
  elements.placeSearchResults.replaceChildren();
  elements.placeSearchStatus.textContent = "Searching places…";

  const wait = Math.max(
    0,
    lastPlaceSearchAt + PLACE_SEARCH_MIN_INTERVAL_MS - Date.now(),
  );
  if (wait > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, wait));
  }
  if (controller.signal.aborted || sequence !== placeSearchSequence) return;
  lastPlaceSearchAt = Date.now();

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({
    format: "jsonv2",
    limit: "5",
    q: query,
  });
  const timeout = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Place search returned HTTP ${response.status}`);
    }
    const results = await response.json();
    if (!Array.isArray(results)) {
      throw new Error("Place search returned an unexpected response.");
    }
    if (sequence !== placeSearchSequence) return;

    const places = results.filter(
      (place) =>
        typeof place.display_name === "string" &&
        Number.isFinite(Number(place.lat)) &&
        Number.isFinite(Number(place.lon)),
    );
    if (places.length === 0) {
      elements.placeSearchStatus.textContent = "No matching places found.";
      return;
    }

    elements.placeSearchStatus.textContent =
      `${places.length} matching ${places.length === 1 ? "place" : "places"} · select one to center the globe`;
    for (const place of places) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = place.display_name;
      button.addEventListener("click", () => {
        try {
          flyToPlace(place);
        } catch (error) {
          elements.placeSearchStatus.textContent = error.message;
        }
      });
      item.append(button);
      elements.placeSearchResults.append(item);
    }
  } catch (error) {
    if (sequence !== placeSearchSequence) return;
    elements.placeSearchStatus.textContent =
      error.name === "AbortError"
        ? "Place search timed out. Please try again."
        : `Place search failed: ${error.message}`;
  } finally {
    clearTimeout(timeout);
    if (placeSearchController === controller) placeSearchController = null;
  }
}

elements.placeSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = elements.placeSearchInput.value.trim();
  if (!query) {
    elements.placeSearchStatus.textContent = "Enter a place or address to search.";
    elements.placeSearchInput.focus();
    return;
  }
  void searchPlaces(query);
});

function initializeGlobe() {
  if (typeof window.Globe !== "function") {
    setGlobeStatus("3D globe unavailable. Check your connection and reload.");
    return;
  }
  if (!window.WebGLRenderingContext) {
    setGlobeStatus("This browser does not support the 3D globe.");
    return;
  }

  setGlobeStatus("Loading satellite imagery…");
  const initialGlobeWidth = elements.connectionMap.clientWidth;
  const initialGlobeHeight = elements.connectionMap.clientHeight;
  clearTimeout(globeLoadTimer);
  globeLoadTimer = window.setTimeout(() => {
    setGlobeStatus("Satellite imagery is taking longer to load. Check your connection.");
  }, 15_000);
  globe = window.Globe()(elements.connectionMap, {
    rendererConfig: { antialias: true, alpha: true },
  })
    .width(initialGlobeWidth)
    .height(initialGlobeHeight)
    .globeImageUrl(GLOBE_TEXTURE_URL)
    .bumpImageUrl(GLOBE_BUMP_TEXTURE_URL)
    .backgroundColor("rgba(0, 0, 0, 0)")
    .showAtmosphere(true)
    .atmosphereColor("#a8a8a8")
    .atmosphereAltitude(0.06)
    .arcsData([])
    .arcStartLat((arc) => arc.startLat)
    .arcStartLng((arc) => arc.startLng)
    .arcEndLat((arc) => arc.endLat)
    .arcEndLng((arc) => arc.endLng)
    .arcColor(() => "#b8b8b8")
    .arcAltitude(0.035)
    .arcStroke(0.28)
    .arcDashLength(1)
    .arcDashGap(0)
    .arcDashInitialGap(0)
    .arcDashAnimateTime(0)
    .arcsTransitionDuration(0)
    .pointsData([])
    .pointLat((point) => point.lat)
    .pointLng((point) => point.lng)
    .pointColor((point) => point.color)
    .pointRadius((point) => point.type === "region" ? 0.28 : 0.72)
    .pointAltitude((point) =>
      point.type === "region" ? 0.008 : 0.02 + 0.12 * Math.sin(Math.PI * point.progress),
    )
    .pointLabel((point) => point.label)
    .pointsTransitionDuration(0)
    .htmlElementsData([])
    .htmlLat((pin) => pin.lat)
    .htmlLng((pin) => pin.lng)
    .htmlAltitude(0.012)
    .htmlElement(createGlobePin)
    .onGlobeReady(() => {
      clearTimeout(globeLoadTimer);
      setGlobeStatus("", true);
      globe.globeMaterial().bumpScale = 0.035;
      updateGlobePins();
      updateGlobeData();
      if (pendingPlace) {
        globe.pointOfView({ ...pendingPlace, altitude: 0.62 }, 0);
        pendingPlace = null;
      }
    });

  globe.renderer().setPixelRatio(
    Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_GLOBE_PIXEL_RATIO)),
  );
  globeControls = globe.controls();
  globeControls.enableDamping = true;
  globeControls.dampingFactor = 0.08;
  globeControls.autoRotate = false;
  globeControls.autoRotateSpeed = 0.18;
  globeControls.addEventListener("change", updateGlobePinOcclusion);
  globeControls.minDistance = 145;
  globeControls.maxDistance = 420;
  globe.pointOfView({ lat: 15, lng: -25, altitude: 1.75 }, 0);
  elements.connectionMap.addEventListener("pointerenter", () => {
    clearTimeout(globeIdleTimer);
    globeControls.autoRotate = false;
  });
  elements.connectionMap.addEventListener("pointerleave", scheduleGlobeRotation);
  elements.connectionMap.addEventListener("pointerdown", scheduleGlobeRotation);
  elements.connectionMap.addEventListener("wheel", scheduleGlobeRotation, { passive: true });
  window.addEventListener("pointerup", (event) => {
    if (event.target instanceof Element && event.target.closest(".globe-pin")) return;
    scheduleGlobeRotation();
  });
  window.addEventListener("touchend", scheduleGlobeRotation, { passive: true });
  scheduleGlobeRotation();

  for (const button of document.querySelectorAll(".map-legend [data-region]")) {
    button.addEventListener("click", () => selectRegion(button.dataset.region));
  }
  for (const input of document.querySelectorAll(".signal-control input[type='range']")) {
    const output = input.parentElement.querySelector("output");
    const updateVisibility = () => {
      signalVisibility.set(input.dataset.signalLayer, Number(input.value) / 100);
      output.value = `${input.value}%`;
      output.textContent = `${input.value}%`;
      updateGlobeData();
    };
    input.addEventListener("input", updateVisibility);
    updateVisibility();
  }

  const recentMapItems = counter.recentItems
    .filter(
      (item) =>
        item.volumeUnits > 0 && SIGNAL_CATEGORIES.has(item.category),
    )
    .slice(0, 12);
  for (const item of recentMapItems) addMapEvent(item, 0, true);

  if ("ResizeObserver" in window) {
    const resizeGlobe = () => {
      globe
        .width(elements.connectionMap.clientWidth)
        .height(elements.connectionMap.clientHeight);
      globe.renderer().setPixelRatio(
        Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_GLOBE_PIXEL_RATIO)),
      );
    };
    globeResizeObserver = new ResizeObserver(() => {
      resizeGlobe();
    });
    globeResizeObserver.observe(elements.connectionMap);
  } else {
    window.addEventListener("resize", () => {
      globe
        .width(elements.connectionMap.clientWidth)
        .height(elements.connectionMap.clientHeight);
      globe.renderer().setPixelRatio(
        Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_GLOBE_PIXEL_RATIO)),
      );
    });
  }
}

function updateMetrics(scoreUnits) {
  const now = Date.now();
  const recentAccordReports = Array.from(streamItems.values()).filter(
    (item) =>
      item.category === "global-milestone" &&
      now - parseTimestamp(item.time).getTime() <= ITEM_MAX_AGE_MS,
  );
  elements.accordCount.textContent = String(recentAccordReports.length);
  elements.accordNote.textContent =
    "Keyword-matched feed reports · not verified accords";
  elements.peaceScore.textContent = `${scoreText(scoreUnits)}%`;
}

function setScore(units) {
  const target = Math.min(
    MAX_SCORE_UNITS,
    Math.max(BASE_SCORE_UNITS, units),
  );
  const start = displayedUnits;
  if (target === start) {
    elements.scoreNumber.textContent = scoreText(target);
    elements.progressFill.style.width =
      `${target / SCORE_UNITS_PER_PERCENT}%`;
    elements.progressTrack.setAttribute(
      "aria-valuenow",
      preciseScoreText(target),
    );
    elements.progressTrack.setAttribute(
      "aria-valuetext",
      `${preciseScoreText(target)} percent`,
    );
    updateMetrics(target);
    return;
  }
  const startedAt = performance.now();
  const duration = 2500;

  function frame(now) {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = progress * progress * (3 - 2 * progress);
    const current = Math.round(start + (target - start) * eased);
    const percent = current / SCORE_UNITS_PER_PERCENT;
    elements.scoreNumber.textContent = scoreText(current);
    elements.progressFill.style.width = `${percent}%`;
    elements.progressTrack.setAttribute(
      "aria-valuenow",
      preciseScoreText(current),
    );
    elements.progressTrack.setAttribute(
      "aria-valuetext",
      `${preciseScoreText(current)} percent`,
    );
    elements.peaceScore.textContent = `${scoreText(current)}%`;
    if (progress < 1) {
      requestAnimationFrame(frame);
    } else {
      displayedUnits = target;
      updateMetrics(target);
    }
  }

  requestAnimationFrame(frame);
}

async function fetchJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(path, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 180);
      throw new Error(
        `HTTP ${response.status}${detail ? ` · ${detail}` : ""}`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function settleFeed(path) {
  try {
    const payload = await fetchJson(path);
    if (!Array.isArray(payload.items)) {
      throw new Error("Feed returned an unexpected response");
    }
    return {
      items: payload.items,
      mode: payload.mode ?? "live",
      cacheStatus: payload.cacheStatus ?? null,
      warning: payload.warning ?? null,
      error: null,
    };
  } catch (error) {
    return {
      items: [],
      mode: "unavailable",
      cacheStatus: null,
      warning: null,
      error:
        error.name === "AbortError"
          ? "request timed out"
          : error.message,
    };
  }
}

function setSourceStatus(id, result) {
  const chip = document.querySelector(`#${id}`);
  chip.dataset.state = result.error ? "error" : "live";
  const status = chip.querySelector(".source-state");
  status.textContent = result.error
    ? `RETRY · ${result.error.slice(0, 26)}`
    : result.mode === "waiting"
      ? "CHECKS EVERY 5 MIN"
    : result.mode === "news-cache-fallback"
      ? `NEWS CACHE · ${result.items.length}`
    : result.mode === "reliefweb-fallback"
      ? `LIVE · RELIEFWEB · ${result.items.length}`
      : result.cacheStatus === "stale" || result.mode === "client-cache"
        ? `CACHED · ${result.items.length}`
        : result.mode === "rss-fallback" || result.mode === "fallback"
          ? `LIVE · FALLBACK · ${result.items.length}`
          : `LIVE · ${result.items.length}`;
  chip.title = result.error ?? result.warning ?? `${result.items.length} recent items`;
}

function normalizeItems(items, source, kind) {
  const now = Date.now();
  return items.flatMap((item) => {
    if (
      !item ||
      typeof item.title !== "string" ||
      typeof item.url !== "string" ||
      typeof item.id !== "string"
    ) {
      return [];
    }

    let url;
    try {
      url = new URL(item.url);
    } catch {
      return [];
    }
    if (url.protocol !== "https:" || url.username || url.password) return [];

    const date = parseTimestamp(item.time);
    if (Number.isNaN(date.getTime()) || !isWithinCurrentCycle(date.toISOString(), now)) {
      return [];
    }

    url.hash = "";
    const normalizedItem = {
      key: item.id || url.href,
      title: item.title.trim(),
      text: typeof item.text === "string" ? item.text.trim() : "",
      url: url.href,
      time: date.toISOString(),
      source:
        source.startsWith("Google News") && item.source
          ? `${item.source} · Google News`
          : item.source || source,
      kind,
    };
    return contributionFor(normalizedItem) ? [normalizedItem] : [];
  });
}

function contributionFor(item) {
  const text = `${item.title} ${item.text ?? ""}`;
  if (
    /(?:\b(?:billionaires?|millionaires?)\b.{0,60}\b(?:make|making|earn|earning|profit\w*|gain\w*|wealth|fortune|net worth)\b|\b(?:make|making|earn|earning|profit\w*|gain\w*|accumulat\w*|build\w*|grow\w*).{0,60}\b(?:billionaires?|millionaires?|wealth|fortune|net worth)\b|\b(?:stock(?:s| market)?|share prices?|shares? (?:rise|fall|surge|drop|climb|gain|slide|dip)|market cap|earnings|quarterly results|investors?|net worth|personal wealth|personal achievement|career milestone|self-made|company profits|corporate revenue|initial public offering|ipo|individual wealth|won (?:an? )?(?:award|prize|competition)|sets? (?:a )?record)\b)/i.test(
      text,
    )
    || /\b(?:fail(?:s|ed|ure)?|reject(?:s|ed|ing)?|withdraw(?:s|n|al|ing)?|suspend(?:s|ed|ing)?|collapse(?:s|d|ing)?|halt(?:s|ed|ing)?|block(?:s|ed|ing)?|ban(?:s|ned|ning)?|attack(?:s|ed|ing)?|violence|war|killed|sanction(?:s|ed|ing)?|accus(?:e|es|ed|ing)|condemn(?:s|ed|ing)?|break(?:s|ing)? down)\b/i.test(text)
  ) {
    return null;
  }

  if (
    /\b(?:treat(?:y|ies)|pact|accord|convention)\b/i.test(text) &&
    /\b(?:international|global|cross-border|bilateral|multilateral|between (?:two or more )?(?:countries|nations|states)|countries|nations|sovereign|ratified|signed|peace)\b/i.test(text)
  ) {
    return { volumeUnits: 100, kind: "global-milestone" };
  }
  if (
    /\b(?:scientific|science|research|medical|vaccine|space station|iss|climate|disaster response|university|universities|institution|agency|laborator(?:y|ies)|public health)\b/i.test(text) &&
    /\b(?:international|global|cross-border|bilateral|multilateral|between (?:two or more )?(?:countries|nations|states)|countries|nations)\b/i.test(text) &&
    /\b(?:joint|collaborat\w*|partner(?:ship|ed|ing)?|shared|between|cooperat\w*|multinational|multi-national|together|team(?:work)?)\b/i.test(text)
  ) {
    return { volumeUnits: 10, kind: "major-news" };
  }
  if (
    /\b(?:community|communities|volunteers?|volunteering|mutual aid|donat\w*|food bank|shelter|disaster relief|humanitarian|charit(?:y|ies)|fundrais\w*|school meals|rescue|neighbors?|neighbours?|families|students|residents|patients|refugees|public service|local aid|aid workers?)\b/i.test(text) &&
    /\b(?:help(?:s|ed|ing)?|support(?:s|ed|ing)?|serv(?:e|es|ed|ing)|deliver(?:s|ed|ing)?|provid(?:e|es|ed|ing)|team(?:s|ed|ing)?|together|collect(?:ive|ively)?|rais(?:e|es|ed|ing)|donat\w*|aid|care|rescu(?:e|es|ed|ing)|protect(?:s|ed|ing)?|feed(?:s|ing)?|treat(?:s|ed|ing)?|vaccinat\w*|teach(?:es|ing)?|build(?:s|ing)?|distribut\w*)\b/i.test(text)
  ) {
    return { volumeUnits: 1, kind: "micro-good-deed" };
  }
  return null;
}

function persistCounter() {
  try {
    const seen = Array.from(counter.seen).slice(-SEEN_LIMIT);
    counter.seen = new Set(seen);
    localStorage.setItem(
      SCORE_STORAGE_KEY,
      JSON.stringify({
        units: counter.units,
        volumeUnits: counter.volumeUnits,
        lastSuccessfulPollAt: counter.lastSuccessfulPollAt,
        seen,
      }),
    );
    counter.warning = null;
  } catch (error) {
    counter.warning = `Tally is not saved in this browser: ${error.message}`;
  }
}

function ingest(items, pollStartedAt, advancePollCutoff) {
  let newReportCount = 0;
  const addedItems = [];

  for (const item of items) {
    const contribution = contributionFor(item);
    if (!contribution) continue;
    const publishedAt = parseTimestamp(item.time).getTime();
    if (
      !isWithinCurrentCycle(item.time) ||
      publishedAt < counter.lastSuccessfulPollAt
    ) {
      continue;
    }
    if (counter.seen.has(item.key)) {
      continue;
    }
    counter.seen.add(item.key);
    counter.volumeUnits += contribution.volumeUnits;
    newReportCount += 1;
    const report = {
      ...item,
      volumeUnits: contribution.volumeUnits,
      scoreDeltaUnits: 0,
      category: contribution.kind,
    };
    streamItems.set(item.key, report);
    addedItems.push(report);
  }

  while (counter.seen.size > SEEN_LIMIT) {
    counter.seen.delete(counter.seen.values().next().value);
  }

  const previousUnits = counter.units;
  counter.units = scoreUnitsForVolume(counter.volumeUnits);
  const scoreDeltaUnits = counter.units - previousUnits;
  if (scoreDeltaUnits > 0 && addedItems.length > 0) {
    const batchReport = addedItems[addedItems.length - 1];
    batchReport.scoreDeltaUnits = scoreDeltaUnits;
    batchReport.batchVolumeUnits =
      roundedVolume(counter.volumeUnits) -
      roundedVolume(counter.volumeUnits - addedItems.reduce(
        (sum, item) => sum + item.volumeUnits,
        0,
      ));
    streamItems.set(batchReport.key, batchReport);
  }

  if (advancePollCutoff) {
    counter.lastSuccessfulPollAt = Math.max(
      counter.lastSuccessfulPollAt,
      pollStartedAt,
    );
  }
  const orderedItems = Array.from(streamItems.values())
    .filter((item) => isWithinCurrentCycle(item.time))
    .sort((a, b) => parseTimestamp(b.time) - parseTimestamp(a.time))
    .slice(0, DISPLAY_LIMIT);
  streamItems = new Map(orderedItems.map((item) => [item.key, item]));

  persistCounter();
  return { newReportCount, scoreDeltaUnits, items: orderedItems, addedItems };
}

function tickerTime(value) {
  const date = parseTimestamp(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `[${part("month")} ${part("day")}, ${part("year")} • ${part("hour")}:${part("minute")}:${part("second")} UTC]`;
}

function baselinePreviewFor(items) {
  const cutoff = counter.lastSuccessfulPollAt;
  return items.flatMap((item) => {
    const publishedAt = parseTimestamp(item.time).getTime();
    if (
      !Number.isFinite(publishedAt) ||
      publishedAt >= cutoff ||
      !isWithinCurrentCycle(item.time) ||
      streamItems.has(item.key)
    ) {
      return [];
    }
    const contribution = contributionFor(item);
    if (!contribution) return [];
    return [{
      ...item,
      volumeUnits: contribution.volumeUnits,
      scoreDeltaUnits: 0,
      category: contribution.kind,
      baselinePreview: true,
    }];
  });
}

function renderStream(items) {
  elements.tickerList.replaceChildren();
  const currentItems = Array.from(
    new Map(
      [...baselinePreviewItems, ...items]
        .filter(
          (item) =>
            item.volumeUnits > 0 && isWithinCurrentCycle(item.time),
        )
        .map((item) => [item.key, item]),
    ).values(),
  ).sort((a, b) => parseTimestamp(b.time) - parseTimestamp(a.time));
  if (currentItems.length === 0) {
    const empty = document.createElement("li");
    empty.className = "ticker-empty";
    empty.textContent =
      "No eligible reports published in the current 24-hour window. Feed errors and rate limits are shown above.";
    elements.tickerList.append(empty);
    return;
  }

  for (const item of currentItems.slice(0, 20)) {
    const route = routeForItem(item);
    const { from, to } = route;
    const row = document.createElement("li");
    row.className = "ticker-item";

    const dot = document.createElement("span");
    dot.className = "ticker-dot";
    dot.setAttribute("aria-hidden", "true");

    const time = document.createElement("time");
    time.className = "ticker-time";
    time.dateTime = item.time;
    time.textContent = tickerTime(item.time);

    const source = document.createElement("span");
    source.className = "ticker-source";
    source.textContent = item.source || "Public feed";

    const routeLabel = document.createElement("span");
    routeLabel.className = "ticker-route";
    routeLabel.textContent = `${from.name} ↔ ${to.name}${route.inferred ? " · estimated" : ""}`;
    routeLabel.title = route.inferred
      ? "The public text did not identify two locations; this connection is illustrative."
      : "Both locations were inferred from place names in the public item text.";

    const link = document.createElement("a");
    link.className = "ticker-link";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.title;
    link.title =
      `${item.title} · HTTPS source URL supplied by ${item.source}; content not independently authenticated`;

    const credit = document.createElement("span");
    credit.className = "ticker-credit";
    credit.classList.toggle("ticker-buffered", item.scoreDeltaUnits <= 0);
    credit.classList.toggle("ticker-volume-step", item.scoreDeltaUnits > 0);
    credit.textContent = item.baselinePreview
      ? "NOT NEW · NO SCORE ADDED"
      : item.scoreDeltaUnits > 0
        ? `VOLUME STEP +${preciseScoreText(item.scoreDeltaUnits)}%`
        : "BUFFERED";
    credit.title = item.baselinePreview
      ? `Current report shown for context; it predates this browser's live tally cutoff and added no score units. Source: ${item.source}`
      : item.scoreDeltaUnits > 0
        ? `The index changed after an aggregate report-volume threshold; this story did not cause the change by itself. Source: ${item.source}`
        : `Eligible source report held in the aggregate volume buffer; no individual report directly changes the index. Source: ${item.source}`;

    row.append(dot, time, source, link, routeLabel, credit);
    elements.tickerList.append(row);
  }
}

function updateSourceStatuses(results) {
  setSourceStatus("source-news", results.news);
  for (const { id, subreddit } of REDDIT_FEEDS) {
    setSourceStatus(id, results.reddit.get(subreddit));
  }
}

function applyRefreshResult(result, feeds, totalNewReports, totalScoreDelta) {
  updateGlobePins();
  result.addedItems.forEach(addMapEvent);
  setScore(counter.units);
  elements.scoreChange.textContent =
    `+${preciseScoreText(totalScoreDelta)}%`;
  elements.scoreChange.title =
    `${totalNewReports} new eligible reports; the index only moves when aggregate volume crosses a 1,000-unit batch.`;

  const checkedAt = tickerTime(new Date().toISOString());
  elements.lastUpdated.textContent = `Last feed check · ${checkedAt}`;
  if (elements.pollStatus) {
    elements.pollStatus.textContent =
      `UPDATED · ${totalNewReports} NEW · ${checkedAt}`;
  }

  const availableFeeds = feeds.filter(
    (feed) => !feed.error && feed.mode !== "waiting",
  ).length;
  const failedFeeds = feeds.filter(
    (feed) => feed.error || feed.mode === "waiting",
  ).length;
  elements.liveIndicator.dataset.state =
    availableFeeds === 0 ? "error" : failedFeeds > 0 ? "partial" : "live";
  elements.liveLabel.textContent =
    availableFeeds === 0
      ? "PUBLIC FEEDS UNAVAILABLE"
      : failedFeeds > 0
        ? `LIVE · ${availableFeeds}/${feeds.length} FEEDS`
        : "LIVE · ALL FEEDS";
  if (counter.warning) elements.liveIndicator.dataset.state = "partial";
  renderStream(result.items);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const pollStartedAt = Date.now();
  elements.liveIndicator.dataset.state = "loading";
  elements.liveLabel.textContent = "POLLING PUBLIC FEEDS";
  if (elements.pollStatus) elements.pollStatus.textContent = "CHECKING";

  try {
    const shouldPollReddit =
      Date.now() - lastRedditPollAt >= REDDIT_POLL_INTERVAL_MS;
    const newsPromise = settleFeed("/api/news");
    let redditPromise;
    if (shouldPollReddit) {
      lastRedditPollAt = Date.now();
      redditPromise = Promise.all(
        REDDIT_FEEDS.map(async ({ subreddit }) => {
          const result = await settleFeed(
            `/api/reddit/${encodeURIComponent(subreddit)}`,
          );
          if (!result.error) {
            cachedRedditResults.set(subreddit, result);
            return result;
          }

          const cached = cachedRedditResults.get(subreddit);
          return cached
            ? {
                ...cached,
                mode: "client-cache",
                cacheStatus: "stale",
                warning: `Using last successful local feed response; refresh failed: ${result.error}`,
              }
            : result;
        }),
      );
    } else {
      redditPromise = Promise.resolve(
        REDDIT_FEEDS.map(({ subreddit }) =>
          cachedRedditResults.get(subreddit) ?? {
            items: [],
            mode: "waiting",
            cacheStatus: null,
            warning: "Reddit fallback check is scheduled every five minutes.",
            error: null,
          },
        ),
      );
    }
    const news = await newsPromise;
    const waitingReddit = new Map(
      REDDIT_FEEDS.map(({ subreddit }) => [
        subreddit,
        cachedRedditResults.get(subreddit) ?? {
          items: [],
          mode: "waiting",
          cacheStatus: null,
          warning: "Reddit check runs every five minutes.",
          error: null,
        },
      ]),
    );
    updateSourceStatuses({ news, reddit: waitingReddit });

    const initialScore = counter.units;
    const newsItems = normalizeItems(
      news.items,
      news.source || "Google News RSS",
      "news",
    );
    baselinePreviewItems = baselinePreviewFor(newsItems);
    const newsResult = ingest(newsItems, pollStartedAt, false);
    const interimFeeds = [news, ...waitingReddit.values()];
    applyRefreshResult(
      newsResult,
      interimFeeds,
      newsResult.newReportCount,
      counter.units - initialScore,
    );

    const redditResults = await redditPromise;
    const reddit = new Map(
      REDDIT_FEEDS.map(({ subreddit }, index) => [
        subreddit,
        redditResults[index],
      ]),
    );
    const fetchedItems = REDDIT_FEEDS.flatMap(({ subreddit }) =>
      normalizeItems(
        reddit.get(subreddit).items,
        `r/${subreddit} · Reddit`,
        "deed",
      ),
    );
    baselinePreviewItems = baselinePreviewFor([...newsItems, ...fetchedItems]);

    updateSourceStatuses({ news, reddit });
    const feeds = [news, ...reddit.values()];
    const allFeedsSucceeded = feeds.every(
      (feed) => !feed.error && feed.mode !== "waiting",
    );
    const redditResult = ingest(
      fetchedItems,
      pollStartedAt,
      allFeedsSucceeded,
    );
    const result = {
      ...redditResult,
      newReportCount:
        newsResult.newReportCount + redditResult.newReportCount,
      scoreDeltaUnits: counter.units - initialScore,
    };
    applyRefreshResult(
      result,
      feeds,
      result.newReportCount,
      result.scoreDeltaUnits,
    );
  } catch (error) {
    elements.liveIndicator.dataset.state = "error";
    elements.liveLabel.textContent = `UPDATE FAILED · ${error.message}`;
    if (elements.pollStatus) elements.pollStatus.textContent = "UPDATE FAILED";
  } finally {
    refreshing = false;
  }
}

elements.scoreNumber.textContent = scoreText(counter.units);
elements.progressFill.style.width =
  `${counter.units / SCORE_UNITS_PER_PERCENT}%`;
elements.progressTrack.setAttribute(
  "aria-valuenow",
  preciseScoreText(counter.units),
);
elements.progressTrack.setAttribute(
  "aria-valuetext",
  `${preciseScoreText(counter.units)} percent`,
);
if (counter.recentItems.length > 0) renderStream(counter.recentItems);
if (counter.warning) elements.liveIndicator.title = counter.warning;
updateMetrics(counter.units);
initializeGlobe();
elements.pauseMap.addEventListener("click", () => {
  mapPaused = !mapPaused;
  elements.pauseMap.setAttribute("aria-pressed", String(mapPaused));
  elements.pauseMap.setAttribute(
    "aria-label",
    mapPaused ? "Resume globe rotation" : "Pause globe rotation",
  );
  elements.pauseMap.querySelector("span").textContent = mapPaused ? "▶" : "Ⅱ";
  if (mapPaused) {
    clearTimeout(globeIdleTimer);
    if (globeControls) globeControls.autoRotate = false;
  } else {
    scheduleGlobeRotation();
    updateGlobeData();
  }
});

function scheduleRefresh() {
  setTimeout(() => {
    void refresh().finally(scheduleRefresh);
  }, POLL_INTERVAL_MS);
}

void refresh().finally(scheduleRefresh);
