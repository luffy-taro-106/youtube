// The 6 content pillars. Each defines the terms that must appear in an
// article's HEADLINE (NewsAPI qInTitle) for it to even be considered —
// this is the single biggest lever for cutting noise. We then score and
// rank client-side (see src/news.js).
//
// titleTerms : topic words that must appear in the title (precision gate)
// boost      : impact/action words that, when present, rank an item higher
//
// Phrases with spaces are auto-quoted before being sent to the API.

export const PILLARS = [
  {
    id: "tax",
    name: "Tax Strategy",
    titleTerms: [
      "tax", "IRS", "deduction", "write-off", "capital gains",
      "tax bracket", "estate tax", "tax refund", "tax credit", "S-corp",
    ],
    boost: ["change", "new", "rule", "2026", "save", "owe", "rate", "law", "cut", "increase"],
    trendSeeds: ["taxes"],
  },
  {
    id: "insurance",
    name: "Insurance",
    titleTerms: [
      "insurance", "premium", "long-term care", "Medicare", "annuity",
      "deductible", "life insurance", "health coverage", "Medicaid",
    ],
    boost: ["cost", "rate", "increase", "rise", "change", "rule", "coverage", "benefit"],
    trendSeeds: ["medicare"],
  },
  {
    id: "investing",
    name: "Investing & Markets",
    titleTerms: [
      "gold", "silver", "stock market", "S&P 500", "Nasdaq", "dividend",
      "ETF", "bond", "Treasury yield", "Federal Reserve", "interest rate",
      "recession", "inflation", "bull market", "bear market",
    ],
    boost: ["surge", "fall", "record", "cut", "hike", "forecast", "crash", "rally", "high", "low"],
    trendSeeds: ["gold price", "stock market"],
  },
  {
    id: "real_estate",
    name: "Real Estate",
    titleTerms: [
      "mortgage", "housing market", "home price", "real estate",
      "property tax", "rent", "REIT", "home sales", "housing",
    ],
    boost: ["rate", "rise", "drop", "forecast", "record", "change", "fall", "surge"],
    trendSeeds: ["mortgage rates"],
  },
  {
    id: "tech_ai",
    name: "Business Tech & AI",
    // Reframed for the audience: the impactful, newsy angle here is AI-driven
    // SCAMS/FRAUD targeting people with money, plus AI money tools — not
    // fintech stock tickers.
    titleTerms: [
      "scam", "fraud", "deepfake", "phishing", "identity theft",
      "robo-advisor", "ChatGPT", "AI tool", "budgeting app", "fintech app",
    ],
    boost: ["money", "bank", "retire", "senior", "savings", "protect", "warning", "tax", "AI"],
    trendSeeds: ["scams"],
  },
  {
    id: "foundations",
    name: "Money Foundations",
    titleTerms: [
      "Social Security", "retirement", "401(k)", "401k", "Roth IRA",
      "pension", "savings rate", "cost of living", "retire", "nest egg",
    ],
    boost: ["change", "new", "increase", "cut", "2026", "rule", "benefit", "COLA"],
    trendSeeds: ["social security"],
  },
];

// Reputable, high-signal finance sources. NewsAPI restricts /everything to
// these so we avoid content-farm noise.
export const NEWS_DOMAINS = [
  "reuters.com",
  "cnbc.com",
  "marketwatch.com",
  "kiplinger.com",
  "fool.com",
  "investopedia.com",
  "forbes.com",
  "barrons.com",
  "bloomberg.com",
  "wsj.com",
  "businessinsider.com",
  "yahoo.com",
  "apnews.com",
].join(",");

// Hard noise filter — if any of these hit the TITLE, the article is dropped
// regardless of score. Kills political, geopolitical, and personal-essay
// content that slips through topic matching.
export const NOISE_PATTERNS = [
  /\b(trump|biden|harris|maga|republican|democrat|congress|senate|election|rioter|impeach|white house)\b/i,
  /\b(iran|gaza|ukraine|israel|russia|china war|north korea)\b/i,
  /\bmy (mom|dad|mother|father|husband|wife|son|daughter|family|kid|kids)\b/i,
  /^(i|we)[\s'’]/i,                     // first-person essays: "I'm…", "I've…", "We…"
  /\b(dating|peptide|birthday|chateau|serena|celebrity|kardashian)\b/i,

  // Low-value-as-video-fodder — dropped outright so pillars stay clean:
  /^stock market today/i,                                              // daily index recaps
  /\bfutures? (rise|fall|slip|slide|waver|little changed|jump|climb|drop|edge)/i,
  /chatgpt (says|stock|portfolio)/i,                                    // AI stock-pick clickbait
  /\bbuy this\b.*\b(stock|etf)\b/i,
  /shareholders who lost money|securities fraud investigation|law offices|class action/i, // legal notices
  /\b(earnings call|q[1-4] earnings|sec filing|insider sell|director sells)\b/i,
];
