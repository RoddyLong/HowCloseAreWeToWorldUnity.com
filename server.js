const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8765);
const REQUEST_TIMEOUT_MS = 12_000;
const REDDIT_REQUEST_JITTER_MS = 500;
const REDDIT_REQUEST_SPACING_MS = 350;
const REDDIT_USER_AGENT =
  "HowCloseAreWeToWorldUnity/1.0.0 (public read-only feed; contact: howclosearewetoworldunity.com)";
const NEWS_QUERY =
  "unites OR cooperation OR alliance OR humanitarian OR treaty";
const NEWS_FALLBACK_QUERY =
  "world humanitarian aid cooperation international treaty";
const AP_WORLD_RSS_URL = "https://apnews.com/hub/world-news?output=rss";
const RELIEFWEB_APP_NAME = process.env.RELIEFWEB_APP_NAME || "worldunity";
const REDDIT_LIMIT = 25;
const NEWS_CACHE_TTL_MS = 20_000;
const FEED_CACHE_TTL_MS = 5 * 60_000;
const STALE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_SUBREDDITS = new Set([
  "UpliftingNews",
  "RandomActsOfKindness",
  "Assistance",
]);
const EXCLUDED_STORY_TERMS =
  /(?:\b(?:billionaires?|millionaires?)\b.{0,60}\b(?:make|making|earn|earning|profit\w*|gain\w*|wealth|fortune|net worth)\b|\b(?:make|making|earn|earning|profit\w*|gain\w*|accumulat\w*|build\w*|grow\w*).{0,60}\b(?:billionaires?|millionaires?|wealth|fortune|net worth)\b|\b(?:stock(?:s| market)?|share prices?|shares? (?:rise|fall|surge|drop|climb|gain|slide|dip)|market cap|earnings|quarterly results|investors?|net worth|personal wealth|personal achievement|career milestone|self-made|company profits|corporate revenue|initial public offering|ipo|individual wealth|won (?:an? )?(?:award|prize|competition)|sets? (?:a )?record)\b)/i;
const NEGATIVE_COLLABORATION_TERMS =
  /\b(?:fail(?:s|ed|ure)?|reject(?:s|ed|ing)?|withdraw(?:s|n|al|ing)?|suspend(?:s|ed|ing)?|collapse(?:s|d|ing)?|halt(?:s|ed|ing)?|block(?:s|ed|ing)?|ban(?:s|ned|ning)?|attack(?:s|ed|ing)?|violence|war|killed|sanction(?:s|ed|ing)?|accus(?:e|es|ed|ing)|condemn(?:s|ed|ing)?|break(?:s|ing)? down)\b/i;
const GLOBAL_AGREEMENT_TERMS =
  /\b(?:treat(?:y|ies)|pact|accord|convention)\b/i;
const GLOBAL_COOPERATION_TERMS =
  /\b(?:international|global|cross-border|bilateral|multilateral|between (?:two or more )?(?:countries|nations|states)|countries|nations|sovereign|ratified|signed|peace)\b/i;
const INSTITUTIONAL_WORK_TERMS =
  /\b(?:scientific|science|research|medical|vaccine|space station|iss|climate|disaster response|university|universities|institution|agency|laborator(?:y|ies)|public health)\b/i;
const COLLABORATION_TERMS =
  /\b(?:international|global|cross-border|joint|collaborat\w*|partner(?:ship|ed|ing)?|shared|between|cooperat\w*|multinational|multi-national|together|team(?:work)?)\b/i;
const COMMUNITY_WORK_TERMS =
  /\b(?:community|communities|volunteers?|volunteering|mutual aid|donat\w*|food bank|shelter|disaster relief|humanitarian|charit(?:y|ies)|fundrais\w*|school meals|rescue|neighbors?|neighbours?|families|students|residents|patients|refugees|public service|local aid|aid workers?)\b/i;
const PUBLIC_BENEFIT_TERMS =
  /\b(?:help(?:s|ed|ing)?|support(?:s|ed|ing)?|serv(?:e|es|ed|ing)|deliver(?:s|ed|ing)?|provid(?:e|es|ed|ing)|team(?:s|ed|ing)?|together|collect(?:ive|ively)?|rais(?:e|es|ed|ing)|donat\w*|aid|care|rescu(?:e|es|ed|ing)|protect(?:s|ed|ing)?|feed(?:s|ing)?|treat(?:s|ed|ing)?|vaccinat\w*|teach(?:es|ing)?|build(?:s|ing)?|distribut\w*)\b/i;
const ITEM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const redditModes = new Map();
const feedCooldowns = new Map();
const feedCache = new Map();
const feedRequests = new Map();
let redditRequestQueue = Promise.resolve();
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/script.js", ["script.js", "text/javascript; charset=utf-8"]],
]);

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

function isCurrentCycleItem(item, now = Date.now()) {
  const publishedAt = Date.parse(item.time);
  const age = now - publishedAt;
  return Number.isFinite(publishedAt) && age >= 0 && age <= ITEM_MAX_AGE_MS;
}

function contributionTier(item) {
  const text = `${item.title} ${item.text ?? ""}`;
  if (
    EXCLUDED_STORY_TERMS.test(text) ||
    NEGATIVE_COLLABORATION_TERMS.test(text)
  ) {
    return null;
  }

  if (
    GLOBAL_AGREEMENT_TERMS.test(text) &&
    GLOBAL_COOPERATION_TERMS.test(text)
  ) {
    return "historic-global-pact";
  }
  if (
    INSTITUTIONAL_WORK_TERMS.test(text) &&
    GLOBAL_COOPERATION_TERMS.test(text) &&
    COLLABORATION_TERMS.test(text)
  ) {
    return "institutional-cooperation";
  }
  if (
    COMMUNITY_WORK_TERMS.test(text) &&
    PUBLIC_BENEFIT_TERMS.test(text)
  ) {
    return "community-public-good";
  }
  return null;
}

function eligibleItems(items) {
  const now = Date.now();
  return items
    .filter(
      (item) =>
        contributionTier(item) !== null && isCurrentCycleItem(item, now),
    )
    .slice(0, REDDIT_LIMIT);
}

function parseNewsRss(xml, defaultSource = "Google News") {
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
    return [
      {
        id,
        title,
        text: xmlTag(block, "description").slice(0, 2_000),
        url,
        time,
        source,
      },
    ];
  });
}

function parseReliefWeb(payload) {
  if (!Array.isArray(payload?.data)) {
    throw new Error("ReliefWeb returned an unexpected response");
  }

  return payload.data.flatMap((entry) => {
    const fields = entry?.fields;
    const title = typeof fields?.title === "string" ? fields.title.trim() : "";
    const url = validHttpUrl(fields?.url);
    const time = fields?.date?.created;
    if (!title || !url || typeof time !== "string") return [];

    const sourceList = Array.isArray(fields.source)
      ? fields.source
      : fields.source && typeof fields.source === "object"
        ? [fields.source]
        : [];
    const sourceName = sourceList
      .map((source) => source?.name)
      .filter((name) => typeof name === "string" && name.trim())
      .join(", ");
    const primaryCountries =
      fields.primary_country && typeof fields.primary_country === "object"
        ? Array.isArray(fields.primary_country)
          ? fields.primary_country
          : [fields.primary_country]
        : [];
    const countriesFromFields =
      fields.country && typeof fields.country === "object"
        ? Array.isArray(fields.country)
          ? fields.country
          : [fields.country]
        : [];
    const countryList = [...primaryCountries, ...countriesFromFields];
    const countries = Array.from(
      new Set(
        countryList
          .map((country) => country?.name)
          .filter((name) => typeof name === "string" && name.trim()),
      ),
    );

    return [{
      id: `reliefweb:${entry.id ?? url}`,
      title,
      text: [
        typeof fields.body === "string"
          ? fields.body.replace(/<[^>]*>/g, " ").slice(0, 4_000)
          : "",
        countries.join(" "),
      ].filter(Boolean).join(" "),
      url,
      time,
      source: sourceName ? `${sourceName} · ReliefWeb` : "ReliefWeb",
    }];
  });
}

function parseRedditJson(payload, subreddit) {
  const posts = payload?.data?.children;
  if (!Array.isArray(posts)) {
    throw new Error("Reddit JSON returned an unexpected response");
  }

  return posts.flatMap(({ data }) => {
    if (
      typeof data?.id !== "string" ||
      typeof data.title !== "string" ||
      typeof data.created_utc !== "number"
    ) {
      return [];
    }
    const url = validHttpUrl(
      data.permalink
        ? `https://www.reddit.com${data.permalink}`
        : data.url,
    );
    if (!url) return [];
    return [
      {
        id: data.name || `${subreddit}:${data.id}`,
        title: data.title,
        text: typeof data.selftext === "string" ? data.selftext.slice(0, 2_000) : "",
        url,
        time: new Date(data.created_utc * 1000).toISOString(),
        source: `r/${subreddit}`,
      },
    ];
  });
}

function parseRedditAtom(xml, subreddit) {
  const blocks = xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry\s*>/gi) ?? [];
  return blocks.flatMap((block) => {
    const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
    const alternate = links.find((match) =>
      /\brel=["']alternate["']/i.test(match[1]),
    );
    const link = alternate ?? links[0];
    const href = /\bhref=["']([^"']+)["']/i.exec(link?.[1] ?? "")?.[1];
    const url = validHttpUrl(href ?? xmlTag(block, "id"));
    const title = xmlTag(block, "title");
    const time = xmlTag(block, "published");
    const id = xmlTag(block, "id") || url;
    if (!title || !url || !time || !id) return [];
    return [
      {
        id,
        title,
        text: xmlTag(block, "content").slice(0, 2_000),
        url,
        time,
        source: `r/${subreddit}`,
      },
    ];
  });
}

async function fetchUpstream(url, headers, options = {}) {
  return fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function cachedFeed(key, ttl, loader) {
  const now = Date.now();
  const cached = feedCache.get(key);
  if (cached && now - cached.fetchedAt < ttl) {
    return {
      ...cached.result,
      cacheStatus: "fresh",
      fetchedAt: cached.fetchedAt,
    };
  }

  let request = feedRequests.get(key);
  if (!request) {
    request = loader()
      .then((result) => {
        const entry = { result, fetchedAt: Date.now() };
        feedCache.set(key, entry);
        return entry;
      })
      .finally(() => feedRequests.delete(key));
    feedRequests.set(key, request);
  }

  try {
    const entry = await request;
    return {
      ...entry.result,
      cacheStatus: "live",
      fetchedAt: entry.fetchedAt,
    };
  } catch (error) {
    const stale = feedCache.get(key);
    if (stale && now - stale.fetchedAt <= STALE_CACHE_MAX_AGE_MS) {
      return {
        ...stale.result,
        cacheStatus: "stale",
        fetchedAt: stale.fetchedAt,
        warning: `Live refresh failed; showing cached data (${error.message}).`,
      };
    }
    throw error;
  }
}

function fetchRedditUpstream(url, headers) {
  const request = redditRequestQueue.then(async () => {
    const jitter = Math.floor(Math.random() * (REDDIT_REQUEST_JITTER_MS + 1));
    await new Promise((resolve) =>
      setTimeout(resolve, REDDIT_REQUEST_SPACING_MS + jitter),
    );
    return fetchUpstream(url, headers);
  });
  redditRequestQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

async function loadGoogleNews(query) {
  const url = new URL("https://news.google.com/rss/search");
  url.search = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  const response = await fetchUpstream(url, {
    Accept: "application/rss+xml, application/xml, text/xml",
    "User-Agent": "HowCloseAreWeToWorldUnity/1.0 (public RSS reader)",
  });
  if (!response.ok) {
    throw new Error(`Google News RSS returned HTTP ${response.status}`);
  }
  return eligibleItems(parseNewsRss(await response.text()));
}

async function loadAPWorldNews() {
  const response = await fetchUpstream(AP_WORLD_RSS_URL, {
    Accept: "application/rss+xml, application/xml, text/xml",
    "User-Agent": "HowCloseAreWeToWorldUnity/1.0 (public RSS reader)",
  });
  if (!response.ok) {
    throw new Error(`AP World News RSS returned HTTP ${response.status}`);
  }
  return eligibleItems(parseNewsRss(await response.text(), "AP News"));
}

async function loadNews() {
  const attempts = [
    ["Google News RSS", () => loadGoogleNews(NEWS_QUERY)],
    ["Google News RSS fallback", () => loadGoogleNews(NEWS_FALLBACK_QUERY)],
    ["AP World News RSS", loadAPWorldNews],
  ];
  const errors = [];

  for (const [source, load] of attempts) {
    try {
      const items = await load();
      return {
        items,
        mode: source === "Google News RSS" ? "rss" : "fallback",
        source,
        warning: errors.length
          ? `Using ${source} after a primary feed error: ${errors.join("; ")}`
          : null,
      };
    } catch (error) {
      errors.push(`${source}: ${error.message}`);
    }
  }
  throw new Error(`All news feeds failed: ${errors.join("; ")}`);
}

async function loadReliefWeb() {
  const url = new URL("https://api.reliefweb.int/v2/reports");
  url.searchParams.set("appname", RELIEFWEB_APP_NAME);
  const response = await fetchUpstream(
    url,
    {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "HowCloseAreWeToWorldUnity/1.0 (public humanitarian reports)",
    },
    {
      method: "POST",
      body: JSON.stringify({
        limit: REDDIT_LIMIT,
        profile: "list",
        fields: {
          include: [
            "title",
            "date.created",
            "url",
            "source.name",
            "primary_country.name",
            "country.name",
            "body",
          ],
        },
        sort: ["date.created:desc"],
        filter: {
          operator: "AND",
          conditions: [{
            field: "date.created",
            value: { from: "now-24h", to: "now" },
          }],
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`ReliefWeb reports returned HTTP ${response.status}`);
  }
  const items = eligibleItems(parseReliefWeb(await response.json()));
  return { items, mode: "reliefweb-fallback", source: "ReliefWeb" };
}

async function loadRedditJson(subreddit) {
  const url = new URL(
    `https://www.reddit.com/r/${subreddit}/new.json`,
  );
  url.searchParams.set("limit", String(REDDIT_LIMIT));
  const response = await fetchRedditUpstream(url, {
    Accept: "application/json",
    "User-Agent": REDDIT_USER_AGENT,
  });
  if (!response.ok) {
    throw new Error(`Reddit JSON returned HTTP ${response.status}`);
  }
  return parseRedditJson(await response.json(), subreddit);
}

async function loadRedditRss(subreddit) {
  const url = new URL(`https://www.reddit.com/r/${subreddit}/.rss`);
  url.searchParams.set("limit", String(REDDIT_LIMIT));
  const response = await fetchRedditUpstream(url, {
    Accept: "application/atom+xml, application/rss+xml, application/xml",
    "User-Agent": REDDIT_USER_AGENT,
  });
  if (!response.ok) {
    throw new Error(`Reddit RSS returned HTTP ${response.status}`);
  }
  return parseRedditAtom(await response.text(), subreddit);
}

async function loadReddit(subreddit) {
  try {
    const items = await loadRedditJson(subreddit);
    redditModes.set(subreddit, "json");
    return { items: eligibleItems(items), mode: "json" };
  } catch (jsonError) {
    redditModes.set(subreddit, "rss");
    try {
      const items = eligibleItems(await loadRedditRss(subreddit));
      return {
        items,
        mode: "rss-fallback",
        warning: `Reddit JSON unavailable (${jsonError.message}); using its public RSS feed.`,
      };
    } catch (rssError) {
      try {
        const relief = await cachedFeed(
          "reliefweb",
          FEED_CACHE_TTL_MS,
          loadReliefWeb,
        );
        return {
          ...relief,
          mode: "reliefweb-fallback",
          warning:
            `Reddit unavailable (${jsonError.message}; ${rssError.message}); using ReliefWeb public reports.`,
        };
      } catch (reliefError) {
        let newsFallback;
        let newsFallbackError = null;
        try {
          newsFallback = await cachedFeed(
            "news",
            NEWS_CACHE_TTL_MS,
            () => withFeedCooldown("news", loadNews),
          );
        } catch (error) {
          newsFallbackError = error.message;
        }
        if (newsFallback?.items?.length) {
          return {
            ...newsFallback,
            mode: "news-cache-fallback",
            cacheStatus: "stale",
            warning:
              `Reddit unavailable (${jsonError.message}; ${rssError.message}); ReliefWeb unavailable (${reliefError.message}); showing cached public news.`,
          };
        }
        throw new Error(
          `Reddit JSON failed: ${jsonError.message}; RSS failed: ${rssError.message}; ReliefWeb v2 failed: ${reliefError.message}; cached news fallback${newsFallbackError ? ` failed: ${newsFallbackError}` : " had no current items"}`,
        );
      }
    }
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}

async function handleApi(response, handler) {
  try {
    sendJson(response, 200, await handler());
  } catch (error) {
    console.warn(`Feed request failed: ${error.message}`);
    const status =
      error.name === "TimeoutError"
        ? 504
        : /HTTP 429/.test(error.message)
          ? 429
          : 502;
    sendJson(response, status, { error: error.message });
  }
}

async function withFeedCooldown(key, handler) {
  const cooldown = feedCooldowns.get(key);
  if (cooldown && cooldown.until > Date.now()) {
    const minutes = Math.ceil((cooldown.until - Date.now()) / 60_000);
    throw new Error(`${cooldown.message}; retrying in about ${minutes} min`);
  }
  feedCooldowns.delete(key);

  try {
    const result = await handler();
    feedCooldowns.delete(key);
    return result;
  } catch (error) {
    if (/HTTP (?:403|429)/.test(error.message)) {
      feedCooldowns.set(key, {
        until: Date.now() + 5 * 60_000,
        message: error.message,
      });
    }
    throw error;
  }
}

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

  if (request.method === "GET" && url.pathname === "/api/news") {
    await handleApi(response, () =>
      cachedFeed("news", NEWS_CACHE_TTL_MS, () =>
        withFeedCooldown("news", loadNews),
      ),
    );
    return;
  }

  const redditMatch = /^\/api\/reddit\/([A-Za-z]+)$/.exec(url.pathname);
  if (request.method === "GET" && redditMatch) {
    const subreddit = redditMatch[1];
    if (!ALLOWED_SUBREDDITS.has(subreddit)) {
      sendJson(response, 404, { error: "Feed not configured" });
      return;
    }
    await handleApi(response, () =>
      cachedFeed(`reddit:${subreddit}`, FEED_CACHE_TTL_MS, () =>
        withFeedCooldown(`reddit:${subreddit}`, () => loadReddit(subreddit)),
      ),
    );
    return;
  }

  const file = STATIC_FILES.get(url.pathname);
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  serveStaticFile(request, response, ...file);
});

server.listen(PORT, HOST, () => {
  console.log(`World Unity dashboard running at http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  console.error(`Could not start the local server: ${error.message}`);
  process.exitCode = 1;
});
