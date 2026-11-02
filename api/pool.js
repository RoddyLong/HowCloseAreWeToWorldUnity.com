/**
 * Vercel Serverless Function for Pool API
 * Fetches RSS feeds and returns news items
 */

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
];

const ITEM_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function evaluateWithSemanticRules(headline) {
  const text = headline.toLowerCase();

  // HARDCODED BLOCKS
  const hardcodedBlocks = [
    /\bshortfalls?\b/i,
    /\bimpossible\b/i,
    /\bfunding crisis\b/i,
    /\bslashed\b.{0,20}\b(?:aid|funding|budget|support)\b/i,
  ];

  for (const pattern of hardcodedBlocks) {
    if (pattern.test(text)) {
      return { approved: false, confidence: 0.99 };
    }
  }

  // REJECT: Negative systemic indicators
  const negativePatterns = [
    /\b(?:crisis|crisis's|starving|starvation|refuses?|refused|denied|denies?|reject(?:s|ed|ing)?|protest|protests?|protesting|failed|failure|collapse(?:s|d|ing)?|bankrupt|bankruptcy)\b/i,
    /\b(?:cut|cuts?|reduction|reductions?|terminate(?:s|d|ing)?|suspend(?:s|ed|ing)?|halt(?:s|ed|ing)?|block(?:s|ed|ing)?|ban(?:s|ned|ning)?)\b.{0,30}\b(?:aid|funding|support|assistance|help|relief|budget)\b/i,
  ];

  for (const pattern of negativePatterns) {
    if (pattern.test(text)) {
      return { approved: false, confidence: 0.95 };
    }
  }

  // For positive news sources, be more permissive
  const isPositiveNewsSource = [
    "Good News Network",
    "Positive News UK",
    "Optimist Daily",
  ].includes(headline);

  const positiveWords = [
    "help", "save", "rescue", "support", "protect", "care", "love", "kind", "kindness",
    "generous", "hope", "inspire", "brave", "hero", "triumph", "success", "victory",
    "breakthrough", "discovery", "innovation", "progress", "improve", "solution", "heal",
    "recover", "rebuild", "unite", "together", "community", "friendship", "peace",
    "harmony", "cooperation", "collaboration", "partnership", "alliance", "agreement",
    "treaty", "accord", "pact", "donate", "donation", "charity", "fund", "fundraiser",
    "volunteer", "kind", "good", "positive", "happy", "joy", "celebrate", "celebration",
  ];

  for (const word of positiveWords) {
    if (text.includes(word)) {
      return { approved: true, confidence: 0.70 };
    }
  }

  return { approved: false, confidence: 0.5 };
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

async function loadRSSFeed(source) {
  const response = await fetch(source.url, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml",
      "User-Agent": "HowCloseAreWeToWorldUnity/1.0 (public RSS reader)",
    },
  });

  if (!response.ok) {
    throw new Error(`${source.name} returned HTTP ${response.status}`);
  }

  const rawItems = parseNewsRss(await response.text(), source.name);

  const isPositiveNewsSource = [
    "Good News Network",
    "Positive News UK",
    "Optimist Daily",
  ].includes(source.name);

  const items = rawItems.filter(item => {
    const evaluation = evaluateWithSemanticRules(item.title);
    if (isPositiveNewsSource) {
      return evaluation.confidence > 0.5;
    }
    return evaluation.approved;
  });

  return items;
}

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const allItems = [];

    // Fetch from all RSS sources with timeout
    const fetchPromises = RSS_SOURCES.map(source =>
      Promise.race([
        loadRSSFeed(source),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 15000)
        )
      ])
      .then(items => {
        console.log(`[API] ${source.name}: ${items.length} items`);
        return items;
      })
      .catch(error => {
        console.warn(`[API] ${source.name} failed: ${error.message}`);
        return [];
      })
    );

    const results = await Promise.all(fetchPromises);
    results.forEach(items => allItems.push(...items));

    // Filter by age
    const now = Date.now();
    const uniqueItems = [];

    for (const item of allItems) {
      const age = now - new Date(item.time).getTime();
      if (age < 0 || age > ITEM_MAX_AGE_MS) continue;
      uniqueItems.push(item);
    }

    // Sort by time (newest first) and limit
    uniqueItems.sort((a, b) => new Date(b.time) - new Date(a.time));
    const poolItems = uniqueItems.slice(0, 500);

    console.log(`[API] Sending ${poolItems.length} items to client`);

    return res.status(200).json({
      items: poolItems,
      lastUpdated: now,
      count: poolItems.length,
      currentTime: now,
    });
  } catch (error) {
    console.error(`[API] Error: ${error.message}`);
    return res.status(500).json({ error: 'Failed to fetch news' });
  }
}
