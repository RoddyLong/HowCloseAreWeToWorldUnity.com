/**
 * World Unity Dashboard - Reliable Public RSS Pipeline
 * Bypasses Reddit 429 blocks with stable, open RSS feeds
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// Configuration
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8765);
const REQUEST_TIMEOUT_MS = 12_000;
const RELIEFWEB_APP_NAME = process.env.RELIEFWEB_APP_NAME || "worldunity";
const POOL_SIZE = 500;
const ITEM_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days for deep fallback
const LIVE_FETCH_INTERVAL_MS = 30_000; // 30 seconds

// Strict deduplication ledger - tracks headlines/URLs for 72 hours
const seenHeadlines = new Map(); // Map: headline -> timestamp
const seenUrls = new Map(); // Map: URL -> timestamp

// Global memory reservoir
let globalEventsPool = [];
let poolLastUpdated = 0;

// Live breaking news queue
let liveBreakingNews = [];

// Static file routes
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/script.js", ["script.js", "text/javascript; charset=utf-8"]],
]);

/**
 * ============================================================================
 * SERVER-SIDE DEDUPLICATION (DISABLED - Frontend handles permanent localStorage)
 * ============================================================================
 */

// Server-side deduplication functions retained for reference but not used
// Frontend localStorage provides permanent cross-session deduplication

function cleanupDeduplicationLedger() {
  // Not used - frontend handles permanent ledger
}

function isDuplicate(item) {
  // Not used - frontend handles permanent ledger
  return false;
}

function addToLedger(item) {
  // Not used - frontend handles permanent ledger
}

/**
 * ============================================================================
 * COGNITIVE AI FILTER LAYER - Enhanced with Hardcoded Blocks
 * ============================================================================
 */

function evaluateWithSemanticRules(headline) {
  const text = headline.toLowerCase();

  // HARDCODED BLOCKS - Specific negative terms
  const hardcodedBlocks = [
    /\bshortfalls?\b/i,
    /\bimpossible\b/i,
    /\bfunding crisis\b/i,
    /\bslashed\b.{0,20}\b(?:aid|funding|budget|support)\b/i,
    /\basked to do the impossible\b/i,
    /\bdrastric funding\b/i,
    /\baid organizations\b.{0,30}\b(?:impossible|shortfall|crisis)\b/i,
  ];

  for (const pattern of hardcodedBlocks) {
    if (pattern.test(text)) {
      return { approved: false, confidence: 0.99, reason: "Hardcoded negative term block" };
    }
  }

  // REJECT: Negative systemic indicators
  const negativePatterns = [
    /\b(?:crisis|crisis's|starving|starvation|refuses?|refused|denied|denies?|reject(?:s|ed|ing)?|protest|protests?|protesting|failed|failure|collapse(?:s|d|ing)?|bankrupt|bankruptcy)\b/i,
    /\b(?:cut|cuts?|reduction|reductions?|terminate(?:s|d|ing)?|suspend(?:s|ed|ing)?|halt(?:s|ed|ing)?|block(?:s|ed|ing)?|ban(?:s|ned|ning)?)\b.{0,30}\b(?:aid|funding|support|assistance|help|relief|budget)\b/i,
    /\b(?:running out|depleted|exhausted|empty|insufficient|lack(?:ing|s)?|missing)\b.{0,30}\b(?:fund|money|resource|supply|food|water|medicine)\b/i,
  ];

  for (const pattern of negativePatterns) {
    if (pattern.test(text)) {
      return { approved: false, confidence: 0.95, reason: "Negative systemic indicator" };
    }
  }

  // REJECT: Pure financial gain only
  const pureWealthPatterns = [
    /\b(?:billionaires?|millionaires?)\b.{0,60}\b(?:make|making|earn|earning|profit|gain|wealth|fortune|net worth)\b/i,
    /\b(?:stock(?:s| market)?|share prices?|shares? (?:rise|fall|surge|drop|climb|gain|slide|dip)|market cap|earnings|quarterly results|investors?)\b/i,
    /\b(?:ipo|initial public offering|company profits|corporate revenue)\b/i,
  ];

  for (const pattern of pureWealthPatterns) {
    if (pattern.test(text)) {
      return { approved: false, confidence: 0.92, reason: "Pure financial gain content" };
    }
  }

  // REJECT: Sports game scores (unless charity)
  const sportsScorePatterns = [
    /\b(?:game|match|tournament|championship|final)\b.{0,30}\b(?:score|wins|won|beat|defeated)\b.{0,20}\b(?!(?:charity|donation|fundraiser|good cause))/i,
  ];

  for (const pattern of sportsScorePatterns) {
    if (pattern.test(text)) {
      return { approved: false, confidence: 0.88, reason: "Sports game scores" };
    }
  }

  // REJECT: Crimes without good deed context
  const crimePatterns = [
    /\b(?:arrested|charged|indicted|convicted|sentenced)\b.{0,40}\b(?!(?:helping|saving|rescuing|protecting))/i,
    /\b(?:shooting|stabbing|assault|robbery|burglary)\b.{0,40}\b(?!(?:stopped|prevented|helping|rescuing))/i,
  ];

  for (const pattern of crimePatterns) {
    if (pattern.test(text)) {
      return { approved: false, confidence: 0.90, reason: "Crime without good deed context" };
    }
  }

  // APPROVE: Individual good deeds and kindness (HIGH PRIORITY)
  const kindnessPatterns = [
    /\b(?:stranger|neighbor|person|man|woman|teen|kid|child|student|teacher|doctor|nurse)\b.{0,30}\b(?:helps?|helped|saves?|saved|rescues?|rescued|gifted|donated|gave|provided|built|created|made|started|launched)\b.{0,30}\b(?:stranger|family|child|person|community|charity|cause|shelter|food|home|money|life|hope)\b/i,
    /\b(?:donates?|donated|gives?|gave|gifts?|gifted|fundraiser|fundraising|charity|charitable)\b.{0,30}\b(?:to|for|toward)\b.{0,30}\b(?:stranger|family|child|community|shelter|hospital|school|cause|hope|future)\b/i,
    /\b(?:random act of kindness|pay it forward|good samaritan|good deed)\b/i,
    /\b(?:mrbeast|jimmy|creator|youtuber|streamer)\b.{0,30}\b(?:helps?|gives?|donates?|builds?|creates?|funds?|saves?|rescues?|gifts?)\b/i,
  ];

  for (const pattern of kindnessPatterns) {
    if (pattern.test(text)) {
      return { approved: true, confidence: 0.95, reason: "Individual good deed/kindness" };
    }
  }

  // APPROVE: Charitable and humanitarian acts
  const charityPatterns = [
    /\b(?:charity|charitable|nonprofit|non-profit|ngo|foundation)\b.{0,30}\b(?:launch|start|begin|announce|provide|deliver|donate|fund|support|help|aid|relief)\b/i,
    /\b(?:donation|donations|fundraiser|fundraising|crowdfunding|gofundme)\b.{0,30}\b(?:reaches?|hits?|raises?|collects?|provides?|delivers?|helps?|saves?|rescues?|builds?|creates?)\b/i,
    /\b(?:shelter|food bank|soup kitchen|homeless shelter)\b.{0,30}\b(?:provides?|helps?|serves?|feeds?|houses?|supports?|builds?|opens?|launches?)\b/i,
  ];

  for (const pattern of charityPatterns) {
    if (pattern.test(text)) {
      return { approved: true, confidence: 0.93, reason: "Charitable/humanitarian act" };
    }
  }

  // APPROVE: Medical breakthroughs and healthcare
  const medicalPatterns = [
    /\b(?:medical|healthcare|doctor|nurse|hospital|clinic)\b.{0,30}\b(?:breakthrough|discovery|cure|treatment|helps?|saves?|treats?|heals?|provides?|delivers?|offers?|launches?)\b/i,
    /\b(?:vaccine|vaccination|immunization)\b.{0,30}\b(?:launch|deliver|provide|help|save|protect|distribute)\b/i,
    /\b(?:organ donation|blood donation|bone marrow)\b.{0,30}\b(?:saves?|helps?|rescues?|gives?|provides?)\b/i,
  ];

  for (const pattern of medicalPatterns) {
    if (pattern.test(text)) {
      return { approved: true, confidence: 0.91, reason: "Medical/healthcare advancement" };
    }
  }

  // APPROVE: Community support and local good deeds
  const communityPatterns = [
    /\b(?:community|neighbors?|volunteers?|local|town|city)\b.{0,30}\b(?:comes? together|unites?|helps?|supports?|rallies?|builds?|creates?|provides?|delivers?|raises?|collects?)\b.{0,30}\b(?:for|to|toward)\b/i,
    /\b(?:food drive|clothing drive|toy drive|school supply drive)\b.{0,30}\b(?:collects?|raises?|provides?|delivers?|helps?|supports?)\b/i,
    /\b(?:neighbors?|community|volunteers?)\b.{0,30}\b(?:help|support|rebuild|recover|clean|fix|repair|restore)\b.{0,30}\b(?:after|following)\b.{0,20}\b(?:disaster|storm|flood|fire|tragedy)\b/i,
  ];

  for (const pattern of communityPatterns) {
    if (pattern.test(text)) {
      return { approved: true, confidence: 0.89, reason: "Community support/local good deed" };
    }
  }

  // HIGH-CONFIDENCE OVERRIDE: Global organizations as primary actors
  const globalOrgPatterns = [
    /\b(?:UN|United Nations|WHO|World Health Organization|UNICEF|IFRC|International Federation of Red Cross|Red Cross|G20|G7|EU|European Union|NATO|ASEAN|AU|African Union)\b.{0,20}\b(?:announce|launch|sign|adopt|agree|partner|cooperate|collaborate|aid|relief|fund|support)\b/i,
    /\b(?:G20|G7|EU-Asia|EU-Africa|bilateral|multilateral)\b.{0,30}\b(?:summit|meeting|agreement|treaty|accord|pact)\b/i,
  ];

  for (const pattern of globalOrgPatterns) {
    if (pattern.test(text)) {
      return { approved: true, confidence: 0.95, reason: "Global organization primary actor" };
    }
  }

  // APPROVE: Positive "vs/versus/kill/end" patterns targeting systemic threats
  const positiveThreatPatterns = [
    /\b(?:alliance|alliances|coalition|partners|countries|nations|states)\b.{0,20}\b(?:unite|united|join|gather)\b.{0,15}\b(?:vs|versus)\b.{0,20}\b(?:climate change|poverty|hunger|disease|pandemic|inequality|corruption)\b/i,
    /\b(?:accord|agreement|treaty|pact|summit)\b.{0,20}\b(?:aims?|seek|plan|intend)\b.{0,15}\b(?:to\s+)?(?:kill|end|eliminate|stop|combat|fight)\b.{0,20}\b(?:trade barriers|poverty|hunger|disease|climate|pollution)\b/i,
    /\b(?:countries|nations|states)\b.{0,20}\b(?:sign|adopt|agree)\b.{0,15}\b(?:treaty|accord|agreement|pact)\b.{0,30}\b(?:for|to)\b.{0,20}\b(?:maritime|trade|climate|health|disaster)\b/i,
  ];

  for (const pattern of positiveThreatPatterns) {
    if (pattern.test(text)) {
      return { approved: true, confidence: 0.88, reason: "Positive action against systemic threat" };
    }
  }

  // APPROVE: Cross-border cooperation patterns
  const cooperationPatterns = [
    /\b(?:cross-border|international|global|multinational|multi-national|joint)\b.{0,30}\b(?:cooperation|collaboration|partnership|alliance|effort|initiative|mission|project|operation)\b/i,
    /\b(?:countries|nations|states)\b.{0,20}\b(?:cooperate|collaborate|partner|unite|join|work together)\b.{0,30}\b(?:on|for|to)\b.{0,20}\b(?:disaster|aid|relief|health|climate|science|research|space)\b/i,
  ];

  for (const pattern of cooperationPatterns) {
    if (pattern.test(text)) {
      return { approved: true, confidence: 0.82, reason: "Cross-border cooperation detected" };
    }
  }

  // APPROVE: Humanitarian/aid patterns
  const humanitarianPatterns = [
    /\b(?:humanitarian|aid|relief|emergency|disaster)\b.{0,30}\b(?:response|assistance|support|help|funding|supplies|deployment)\b.{0,20}\b(?:international|global|cross-border|multinational)\b/i,
    /\b(?:WHO|UN|UNICEF|Red Cross)\b.{0,20}\b(?:deploy|send|provide|deliver|launch)\b.{0,20}\b(?:aid|relief|medical|supplies|vaccines)\b/i,
  ];

  for (const pattern of humanitarianPatterns) {
    if (pattern.test(text)) {
      return { approved: true, confidence: 0.85, reason: "Humanitarian/aid cooperation" };
    }
  }

  // APPROVE: Scientific/space collaboration
  const sciencePatterns = [
    /\b(?:international|global|joint)\b.{0,20}\b(?:space|scientific|research|medical|climate)\b.{0,30}\b(?:mission|project|collaboration|cooperation|partnership)\b/i,
    /\b(?:ISS|International Space Station)\b.{0,30}\b(?:crew|astronaut|mission|experiment)\b/i,
  ];

  for (const pattern of sciencePatterns) {
    if (pattern.test(text)) {
      return { approved: true, confidence: 0.84, reason: "Scientific/space collaboration" };
    }
  }

  // APPROVE: Sports charity and sportsmanship
  const sportsCharityPatterns = [
    /\b(?:charity|fundraiser|donation|good cause)\b.{0,30}\b(?:game|match|tournament|race|marathon|athletes?|players?|team)\b/i,
    /\b(?:sportsmanship|fair play|respect|kindness)\b.{0,30}\b(?:game|match|sport|athlete|player)\b/i,
  ];

  for (const pattern of sportsCharityPatterns) {
    if (pattern.test(text)) {
      return { approved: true, confidence: 0.86, reason: "Sports charity/sportsmanship" };
    }
  }

  // Default: For positive news sources, be more permissive
  // Accept items that seem generally positive or constructive
  const positiveWords = [
    "help", "save", "rescue", "support", "protect", "care", "love", "kind", "kindness",
    "generous", "hope", "inspire", "brave", "hero", "triumph", "success", "victory",
    "breakthrough", "discovery", "innovation", "progress", "improve", "solution", "heal",
    "recover", "rebuild", "unite", "together", "community", "friendship", "peace",
    "harmony", "cooperation", "collaboration", "partnership", "alliance", "agreement",
    "treaty", "accord", "pact", "donate", "donation", "charity", "fund", "fundraiser",
    "volunteer", "kind", "good", "positive", "happy", "joy", "celebrate", "celebration",
    "achievement", "accomplish", "win", "winner", "champion", "improve", "better",
    "best", "great", "wonderful", "amazing", "beautiful", "inspiring", "inspirational",
  ];

  for (const word of positiveWords) {
    if (text.includes(word)) {
      return { approved: true, confidence: 0.70, reason: `Positive keyword: ${word}` };
    }
  }

  return { approved: false, confidence: 0.5, reason: "Insufficient cooperative/goodness context" };
}

/**
 * ============================================================================
 * DATA SOURCE INTEGRATION - STABLE RSS FEEDS
 * ============================================================================
 */

// RSS Feed Sources
const RSS_SOURCES = [
  {
    name: "Good News Network",
    url: "https://www.goodnewsnetwork.org/feed/",
    limit: 100,
  },
  {
    name: "Positive News UK",
    url: "https://www.positive.news/feed/",
    limit: 100,
  },
  {
    name: "Optimist Daily",
    url: "https://www.optimistdaily.com/feed/",
    limit: 100,
  },
  {
    name: "UN News",
    url: "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
    limit: 100,
  },
  {
    name: "Google News",
    url: "https://news.google.com/rss/search?q=humanitarian+OR+cooperation+OR+treaty+OR+alliance&hl=en-US&gl=US&ceid=US:en",
    limit: 100,
  },
  {
    name: "ReliefWeb",
    url: "https://reliefweb.int/updates?format=rss",
    limit: 100,
  },
  {
    name: "BBC News World",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    limit: 100,
  },
  {
    name: "AP News World",
    url: "https://feeds.a.ap.org/xml/AP_TopStories.xml",
    limit: 100,
  },
];

async function loadRSSFeed(source) {
  const response = await fetchUpstream(source.url, {
    Accept: "application/rss+xml, application/xml, text/xml",
    "User-Agent": "HowCloseAreWeToWorldUnity/1.0 (public RSS reader)",
  });

  if (!response.ok) {
    throw new Error(`${source.name} returned HTTP ${response.status}`);
  }

  const rawItems = parseNewsRss(await response.text(), source.name);

  // For positive news sources, use more permissive filtering
  const isPositiveNewsSource = [
    "Good News Network",
    "Positive News UK",
    "Optimist Daily",
  ].includes(source.name);

  const items = rawItems.filter(item => {
    const evaluation = evaluateWithSemanticRules(item.title);
    // For positive news sources, accept if confidence > 0.5
    if (isPositiveNewsSource) {
      return evaluation.confidence > 0.5;
    }
    return evaluation.approved;
  });

  return items;
}

function parseNewsRss(xml, defaultSource = "RSS Feed") {
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item\s*>/gi) ?? [];
  return blocks.flatMap((block) => {
    const rawTitle = xmlTag(block, "title");
    const source = xmlTag(block, "source") || defaultSource;
    const publisherSuffix = ` - ${source}`;
    const title = rawTitle.endsWith(publisherSuffix)
      ? rawTitle.slice(0, -publisherSuffix.length)
      : rawTitle;
    const url = validHttpUrl(xmlTag(block, "link"));
    const time = xmlTag(block, "pubDate");
    const id = xmlTag(block, "guid") || url;

    if (!title || !url || !id || !time) return [];

    // Clean title from RSS artifacts
    const cleanedTitle = title
      .replace(/\s*\|\s*[\s\S]*$/g, '')
      .replace(/\s+-\s*[\s\S]*$/g, '')
      .replace(/\s*by\s+[\s\S]*$/gi, '')
      .replace(/\s*\(\s*[\s\S]*?\s*\)\s*$/g, '')
      .replace(/\[\s*[\s\S]*?\s*\]/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return [{
      id,
      title: cleanedTitle,
      text: xmlTag(block, "description").slice(0, 2_000),
      url,
      time,
      source,
    }];
  });
}

/**
 * ============================================================================
 * UTILITY FUNCTIONS
 * ============================================================================
 */

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, number) =>
      String.fromCodePoint(Number.parseInt(number, 10)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlTag(block, name) {
  const match = new RegExp(
    `<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`,
    "i",
  ).exec(block);
  return match ? decodeXml(match[1]).replace(/<[^>]*>/g, "").trim() : "";
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

async function fetchUpstream(url, headers, options = {}) {
  return fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * ============================================================================
 * POOL MANAGEMENT
 * ============================================================================
 */

async function updateGlobalPool() {
  console.log(`[POOL] Updating global events pool from ${RSS_SOURCES.length} sources...`);
  const allItems = [];

  // Fetch from all RSS sources simultaneously
  const fetchPromises = RSS_SOURCES.map(source =>
    loadRSSFeed(source)
      .then(items => {
        console.log(`[POOL] ${source.name}: ${items.length} items`);
        return items;
      })
      .catch(error => {
        console.warn(`[POOL] ${source.name} failed: ${error.message}`);
        return [];
      })
  );

  const results = await Promise.all(fetchPromises);
  results.forEach(items => allItems.push(...items));

  // Filter by age only (no server-side deduplication)
  // Frontend permanent localStorage handles deduplication
  const now = Date.now();
  const uniqueItems = [];

  for (const item of allItems) {
    const age = now - new Date(item.time).getTime();
    if (age < 0 || age > ITEM_MAX_AGE_MS) continue;

    uniqueItems.push(item);
  }

  // Sort by time (newest first) and limit to POOL_SIZE
  uniqueItems.sort((a, b) => new Date(b.time) - new Date(a.time));
  globalEventsPool = uniqueItems.slice(0, POOL_SIZE);

  // Keep chronological order (newest first) for live priority
  // Frontend will handle chronological playback and permanent deduplication

  poolLastUpdated = now;
  console.log(`[POOL] Pool updated: ${globalEventsPool.length} items (14d chronicle, deduplication handled by frontend)`);
}

/**
 * ============================================================================
 * LIVE BREAKING NEWS FETCH (30-second cycle)
 * ============================================================================
 */

async function fetchLiveBreakingNews() {
  console.log(`[LIVE] Fetching breaking news...`);
  const newItems = [];

  try {
    // Quick fetch from Google News for latest
    const newsSource = RSS_SOURCES.find(s => s.name === "Google News");
    if (newsSource) {
      const newsItems = await loadRSSFeed(newsSource);
      for (const item of newsItems.slice(0, 10)) {
        if (!isDuplicate(item)) {
          addToLedger(item);
          item.isLive = true;
          newItems.push(item);
        }
      }
    }

    if (newItems.length > 0) {
      // Add to front of pool and re-sort chronologically
      globalEventsPool = [...newItems, ...globalEventsPool];
      globalEventsPool.sort((a, b) => new Date(b.time) - new Date(a.time));
      globalEventsPool = globalEventsPool.slice(0, POOL_SIZE);
      console.log(`[LIVE] Added ${newItems.length} breaking news items`);
    } else {
      console.log(`[LIVE] No new breaking news`);
    }
  } catch (error) {
    console.error(`[LIVE] Fetch failed: ${error.message}`);
  }
}

/**
 * ============================================================================
 * HTTP SERVER
 * ============================================================================
 */

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, {
      Allow: "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Method not allowed");
    return;
  }

  // Pool API endpoint
  if (request.method === "GET" && (url.pathname === "/api/pool" || url.pathname === "/api/news")) {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    const responseData = {
      items: globalEventsPool,
      lastUpdated: poolLastUpdated,
      count: globalEventsPool.length,
      currentTime: Date.now(),
    };
    console.log(`[API] Sending ${globalEventsPool.length} items to client`);
    response.end(JSON.stringify(responseData));
    return;
  }

  // Static files
  const file = STATIC_FILES.get(url.pathname);
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  serveStaticFile(request, response, ...file);
});

function serveStaticFile(request, response, fileName, contentType) {
  fs.readFile(path.join(__dirname, fileName), (error, contents) => {
    if (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Could not read ${fileName}: ${error.message}`);
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  });
}

// Initialize pool on startup
updateGlobalPool().then(() => {
  // Update pool every 2 minutes (more frequent for deep archive)
  setInterval(updateGlobalPool, 2 * 60 * 1000);

  // Fetch live breaking news every 30 seconds
  setInterval(fetchLiveBreakingNews, LIVE_FETCH_INTERVAL_MS);

  server.listen(PORT, HOST, () => {
    console.log(`World Unity dashboard running at http://${HOST}:${PORT}`);
    console.log(`Reliable public RSS pipeline active`);
    console.log(`Global events pool: ${globalEventsPool.length} unique items`);
    console.log(`Live breaking news cycle: ${LIVE_FETCH_INTERVAL_MS}ms`);
  });
}).catch(error => {
  console.error(`Failed to initialize pool: ${error.message}`);
  process.exitCode = 1;
});

server.on("error", (error) => {
  console.error(`Could not start the local server: ${error.message}`);
  process.exitCode = 1;
});
