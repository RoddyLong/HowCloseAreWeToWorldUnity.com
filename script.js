/**
 * World Unity Dashboard - Frontend Queue Player
 * Simple, clean 3-second interval with session deduplication
 */

const SCORE_UNITS_PER_PERCENT = 1_000_000_000;
const BASE_SCORE_UNITS = 8_420_000_000;
const UPDATE_INTERVAL_MS = 3000; // 3 seconds
const CHRONICLE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const PERMANENT_SEEN_KEY = 'worldUnityPermanentSeen';
const PERSISTENT_SCORE_KEY = 'worldUnityPersistentScore';

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
  deltaNumber: document.querySelector("#delta-number"),
  accordCount: document.querySelector("#accord-count"),
  accordNote: document.querySelector("#accord-note"),
  peaceScore: document.querySelector("#peace-score"),
  lastUpdated: document.querySelector("#last-updated"),
};

// Permanent historical ledger - persists across sessions
let permanentSeenRegistry = JSON.parse(localStorage.getItem(PERMANENT_SEEN_KEY)) || [];
let seenSet = new Set(permanentSeenRegistry);

// Auto-clear ledger if it's too large (prevents empty pool)
if (permanentSeenRegistry.length > 500) {
  console.log("[INIT] Clearing oversized permanent ledger (>500 items)");
  permanentSeenRegistry = [];
  seenSet.clear();
  localStorage.setItem(PERMANENT_SEEN_KEY, JSON.stringify(permanentSeenRegistry));
}

let poolItems = [];
let currentIndex = 0;
let currentScore = BASE_SCORE_UNITS;
let updateInterval = null;

// Load persistent score from localStorage
const savedScore = localStorage.getItem(PERSISTENT_SCORE_KEY);
if (savedScore) {
  const parsedScore = parseFloat(savedScore);
  if (!isNaN(parsedScore)) {
    currentScore = parsedScore * SCORE_UNITS_PER_PERCENT;
    console.log(`[INIT] Loaded persistent score: ${parsedScore.toFixed(6)}%`);
  }
}

// Geo locations for globe
const GEO_LOCATIONS = [
  { name: "United States", region: "americas", lat: 38.9, lng: -77, terms: ["united states", "usa", "american", "us"] },
  { name: "Canada", region: "americas", lat: 45.4, lng: -75.7, terms: ["canada", "canadian"] },
  { name: "Mexico", region: "americas", lat: 19.4, lng: -99.1, terms: ["mexico", "mexican"] },
  { name: "Brazil", region: "americas", lat: -15.8, lng: -47.9, terms: ["brazil", "brazilian"] },
  { name: "United Kingdom", region: "europe", lat: 51.5, lng: -0.1, terms: ["united kingdom", "britain", "british", "uk"] },
  { name: "France", region: "europe", lat: 48.9, lng: 2.3, terms: ["france", "french"] },
  { name: "Germany", region: "europe", lat: 52.5, lng: 13.4, terms: ["germany", "german"] },
  { name: "China", region: "asia", lat: 39.9, lng: 116.4, terms: ["china", "chinese"] },
  { name: "India", region: "asia", lat: 28.6, lng: 77.2, terms: ["india", "indian"] },
  { name: "Japan", region: "asia", lat: 35.7, lng: 139.7, terms: ["japan", "japanese"] },
  { name: "Australia", region: "oceania", lat: -35.3, lng: 149.1, terms: ["australia", "australian"] },
  { name: "South Africa", region: "africa", lat: -25.7, lng: 28.2, terms: ["south africa", "african"] },
];

/**
 * Clean title text from RSS artifacts
 */
function cleanTitle(title) {
  return title
    .replace(/\s*\|\s*[\s\S]*$/g, '') // Remove pipe-separated suffixes
    .replace(/\s+-\s*[\s\S]*$/g, '') // Remove dash-separated suffixes
    .replace(/\s*by\s+[\s\S]*$/gi, '') // Remove "by author" suffixes
    .replace(/\s*\(\s*[\s\S]*?\s*\)\s*$/g, '') // Remove parenthetical suffixes
    .replace(/\[\s*[\s\S]*?\s*\]/g, '') // Remove bracketed content
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get source badge for item
 */
function getSourceBadge(item) {
  const source = item.source || "Public feed";
  const lowerSource = source.toLowerCase();

  if (item.isLive) {
    return "🔴 NEW ALERT • LIVE WIRE";
  }

  if (lowerSource.includes("reliefweb") || lowerSource.includes("un")) {
    return "[ LIVE WIRE • UN RELIEFWEB ]";
  }
  if (lowerSource.includes("reddit") || lowerSource.includes("r/")) {
    return "[ INDIVIDUAL DEED • SOCIAL FEED ]";
  }
  if (lowerSource.includes("google news") || lowerSource.includes("ap news") || lowerSource.includes("reuters")) {
    return "[ GLOBAL NEWS • POLITICAL WIRE ]";
  }
  if (lowerSource.includes("who") || lowerSource.includes("world health")) {
    return "[ HEALTH WIRE • WHO ]";
  }
  if (lowerSource.includes("good news network") || lowerSource.includes("positive news") || lowerSource.includes("optimist")) {
    return "[ POSITIVE NEWS • GLOBAL GOOD ]";
  }
  return "[ LIVE FEED • GLOBAL GOOD ]";
}

/**
 * Format timestamp
 */
function formatTimestamp(isoString) {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "--:--";

  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).formatToParts(date);

  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `[${part("month")} ${part("day")}, ${part("year")} • ${part("hour")}:${part("minute")}]`;
}

/**
 * Infer location from text
 */
function inferLocation(text) {
  const lowerText = text.toLowerCase();
  for (const location of GEO_LOCATIONS) {
    for (const term of location.terms || [location.name.toLowerCase()]) {
      if (lowerText.includes(term.toLowerCase())) {
        return location;
      }
    }
  }
  return GEO_LOCATIONS[Math.floor(Math.random() * GEO_LOCATIONS.length)];
}

/**
 * Add location data to items
 */
function addLocationData(items) {
  return items.map(item => ({
    ...item,
    location: inferLocation(`${item.title} ${item.text || ""}`),
  }));
}

/**
 * Display an item in the ticker
 */
function displayItem(item) {
  if (!item) return;

  const normalizedTitle = item.title.toLowerCase().trim();
  const normalizedUrl = item.url.toLowerCase().trim();

  // Check permanent ledger - NEVER display if already seen
  if (seenSet.has(normalizedTitle) || seenSet.has(normalizedUrl)) {
    console.log(`[SKIP] Already in permanent ledger: ${item.title.substring(0, 50)}...`);
    return;
  }

  // Add to permanent ledger
  seenSet.add(normalizedTitle);
  seenSet.add(normalizedUrl);
  permanentSeenRegistry = [...seenSet];
  localStorage.setItem(PERMANENT_SEEN_KEY, JSON.stringify(permanentSeenRegistry));

  const row = document.createElement("li");
  row.className = "ticker-item ticker-new-item";

  // Add live alert class if breaking news
  if (item.isLive) {
    row.classList.add("ticker-live-alert");
  }

  const dot = document.createElement("span");
  dot.className = "ticker-dot";
  dot.setAttribute("aria-hidden", "true");

  const time = document.createElement("time");
  time.className = "ticker-time";
  time.dateTime = item.time;
  time.textContent = formatTimestamp(item.time);

  const source = document.createElement("span");
  source.className = "ticker-source";
  source.textContent = item.source || "Public feed";

  const routeLabel = document.createElement("span");
  routeLabel.className = "ticker-route";
  const location = item.location || GEO_LOCATIONS[0];
  routeLabel.textContent = `${location.name} • GLOBAL`;

  const link = document.createElement("a");
  link.className = "ticker-link";
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = cleanTitle(item.title);
  link.title = `${item.title} • Source: ${item.source}`;

  const credit = document.createElement("span");
  credit.className = "ticker-credit";
  credit.textContent = getSourceBadge(item);
  credit.title = `Source: ${item.source}`;

  row.append(dot, time, source, link, routeLabel, credit);

  // Prepend to list
  elements.tickerList.insertBefore(row, elements.tickerList.firstChild);

  // Remove animation class after animation
  setTimeout(() => {
    row.classList.remove("ticker-new-item");
  }, 500);

  // Keep only most recent 80 items
  while (elements.tickerList.children.length > 80) {
    elements.tickerList.removeChild(elements.tickerList.lastChild);
  }

  // Apply micro-increment based on item type
  const microIncrement = calculateMicroIncrement(item);
  const microIncrementUnits = microIncrement * SCORE_UNITS_PER_PERCENT;
  currentScore += microIncrementUnits;
  // Sync with window global score
  window.currentGlobalScore = currentScore / SCORE_UNITS_PER_PERCENT;
  updateScore(microIncrement);

  console.log(`[DISPLAY] ${item.title.substring(0, 60)}... (+${microIncrement.toFixed(6)}%) [PERMANENT LOGGED]`);
}

/**
 * Calculate micro-increment based on item type
 */
function calculateMicroIncrement(item) {
  const source = item.source?.toLowerCase() || "";
  const title = item.title?.toLowerCase() || "";

  // Sovereign treaties / international agreements
  if (source.includes("un") || source.includes("treaty") || source.includes("accord") ||
      title.includes("treaty") || title.includes("accord") || title.includes("alliance") ||
      title.includes("agreement") || title.includes("cooperation")) {
    return 0.000015; // Higher weight for sovereign actions
  }

  // Community deeds / kindness
  if (source.includes("reddit") || source.includes("good news") || source.includes("positive") ||
      title.includes("donate") || title.includes("charity") || title.includes("help") ||
      title.includes("save") || title.includes("rescue") || title.includes("support")) {
    return 0.000002; // Standard weight for community deeds
  }

  // Medical / scientific breakthroughs
  if (source.includes("who") || source.includes("medical") || source.includes("health") ||
      title.includes("breakthrough") || title.includes("cure") || title.includes("vaccine") ||
      title.includes("medical") || title.includes("healthcare")) {
    return 0.000010; // High weight for medical advances
  }

  // Default micro-increment
  return 0.000001;
}

/**
 * Update score display
 */
function updateScore(currentIncrement = 0) {
  // FORCE REAL-TIME 6-DECIMAL CALCULATIONS
  const scoreElement = document.getElementById("score-number");
  const deltaElement = document.getElementById("delta-number");

  if (!window.currentGlobalScore) {
    window.currentGlobalScore = 8.420000;
  }

  // Process micro-increment weights directly
  if (currentIncrement > 0) {
    window.currentGlobalScore += parseFloat(currentIncrement);
  }

  // Hard force 6-decimal values onto the screen
  if (scoreElement) {
    scoreElement.innerText = window.currentGlobalScore.toFixed(6);
  }

  if (deltaElement && currentIncrement > 0) {
    deltaElement.innerText = "+" + parseFloat(currentIncrement).toFixed(6) + "%";
    deltaElement.style.color = "#4eee94"; // Brief flash green for visual feedback
  }

  // Update progress bar for consistency
  const percent = window.currentGlobalScore.toFixed(6);
  if (elements.peaceScore) {
    elements.peaceScore.textContent = `${percent}%`;
  }
  elements.progressFill.style.width = `${percent}%`;
  elements.progressTrack.setAttribute("aria-valuenow", percent);
  elements.progressTrack.setAttribute("aria-valuetext", `${percent} percent`);

  // Save score to persistent localStorage vault
  localStorage.setItem(PERSISTENT_SCORE_KEY, window.currentGlobalScore.toString());
}

/**
 * Fetch pool from server
 */
async function fetchPool() {
  try {
    const response = await fetch('/api/pool');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    poolItems = data.items || [];

    // Filter to 14-day chronicle window
    const now = Date.now();
    poolItems = poolItems.filter(item => {
      const age = now - new Date(item.time).getTime();
      return age >= 0 && age <= CHRONICLE_WINDOW_MS;
    });

    // ABSOLUTE FRONTEND FILTERING GATEKEEPER
    // Filter out items already in permanent ledger BEFORE rendering
    const beforeFilter = poolItems.length;
    poolItems = poolItems.filter(item => {
      const normalizedTitle = item.title.toLowerCase().trim();
      const normalizedUrl = item.url.toLowerCase().trim();
      return !seenSet.has(normalizedTitle) && !seenSet.has(normalizedUrl);
    });

    console.log(`[FETCH] Pool size: ${poolItems.length} items (14d chronicle, ${beforeFilter - poolItems.length} filtered by permanent ledger)`);

    // EMERGENCY CLEAR: If pool is empty after filtering, clear the ledger
    if (poolItems.length === 0 && beforeFilter > 0) {
      console.log("[FETCH] Pool empty after filtering - clearing permanent ledger");
      permanentSeenRegistry = [];
      seenSet.clear();
      localStorage.setItem(PERMANENT_SEEN_KEY, JSON.stringify(permanentSeenRegistry));
      // Refetch without filtering
      return fetchPool();
    }

    updatePoolStatus();
  } catch (error) {
    console.error(`[FETCH] Error: ${error.message}`);
    elements.liveIndicator.dataset.state = "error";
    elements.liveLabel.textContent = "FETCH ERROR";
  }
}

/**
 * Update pool status in UI
 */
function updatePoolStatus() {
  if (poolItems.length === 0) {
    elements.liveIndicator.dataset.state = "error";
    elements.liveLabel.textContent = "NO ITEMS";
    if (elements.pollStatus) {
      elements.pollStatus.textContent = "EMPTY POOL";
    }
  } else {
    elements.liveIndicator.dataset.state = "live";
    elements.liveLabel.textContent = "LIVE STREAM";
    if (elements.pollStatus) {
      elements.pollStatus.textContent = `${poolItems.length} ITEMS • 3s CYCLE`;
    }
  }
}

/**
 * Main update loop - runs every 3 seconds
 */
function updateLiveFeedTicker() {
  if (poolItems.length === 0) {
    console.log("[TICKER] No items in pool");
    return;
  }

  // Sort pool by time (newest first) to prioritize live items
  const sortedPool = [...poolItems].sort((a, b) => new Date(b.time) - new Date(a.time));

  // Check for live items first (isLive flag)
  const liveItem = sortedPool.find(item => item.isLive);
  if (liveItem) {
    console.log("[TICKER] Priority: Live breaking news");
    displayItem(liveItem);
    // Remove from pool after displaying
    poolItems = poolItems.filter(item => item !== liveItem);
    return;
  }

  // Get current item from chronological pool
  const item = sortedPool[currentIndex];

  // Try to display it
  displayItem(item);

  // Remove item from pool after successful display (prevents repeats)
  poolItems = poolItems.filter(poolItem => poolItem !== item);

  // Reset index since pool is now smaller
  currentIndex = 0;

  // If pool is empty, refresh to get more unseen items
  if (poolItems.length === 0) {
    console.log("[TICKER] Pool exhausted, refreshing for unseen items");
    fetchPool();
  }
}

/**
 * Initialize the application
 */
async function initialize() {
  console.log("[INIT] World Unity Dashboard initializing...");

  // Initialize window global score
  window.currentGlobalScore = currentScore / SCORE_UNITS_PER_PERCENT;

  // Initialize score display
  updateScore();

  // Fetch initial pool
  await fetchPool();

  // Add location data to pool items
  poolItems = addLocationData(poolItems);

  // Update status
  if (poolItems.length > 0) {
    elements.lastUpdated.textContent = "Live stream active";
  } else {
    elements.lastUpdated.textContent = "Fetching items...";
  }

  // Start the 3-second update loop
  updateInterval = setInterval(updateLiveFeedTicker, UPDATE_INTERVAL_MS);
  console.log(`[INIT] Ticker interval started (${UPDATE_INTERVAL_MS}ms)`);

  // Refresh pool every 60 seconds
  setInterval(async () => {
    console.log("[INIT] Refreshing pool...");
    await fetchPool();
    poolItems = addLocationData(poolItems);
    updatePoolStatus();
  }, 60000);

  // Ensure the container exists before rendering
  const mapElement = document.getElementById("connection-map");
  if (mapElement) {
    // Clear out any broken artifacts inside the container first
    mapElement.innerHTML = '';

    // Initialize the official Globe.gl instance
    const world = Globe()(mapElement)
      .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
      .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
      .backgroundImageUrl(null) // Keep background transparent to black canvas;

    // Enable auto-rotation and controls
    world.controls().autoRotate = true;
    world.controls().autoRotateSpeed = 1.5;
    world.controls().enableZoom = true;

    // Auto-adjust size to match full screen boundaries perfectly
    world.width(window.innerWidth);
    world.height(window.innerHeight);

    window.addEventListener('resize', () => {
      world.width(window.innerWidth);
      world.height(window.innerHeight);
    });
  }

  console.log("[INIT] Initialization complete");
}

// Start initialization
initialize();
