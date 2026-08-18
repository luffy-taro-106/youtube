// The 20 competitors. We resolve each `handle` to a channelId at runtime
// (cheap: 1 quota unit each), so you never have to hand-copy channel IDs.
//
// If a handle ever fails to resolve (channel renamed its @handle), run
// `npm run resolve` to see which ones broke, then fix the handle here
// or paste a hard channelId into `channelId` to override.
//
// tier: 1 = direct competitor, 2 = adjacent, 3 = pillar specialist,
//       4 = faceless-format reference.

export const COMPETITORS = [
  // ── Tier 1: direct competitors ──────────────────────────────
  { name: "Bald Guy Money",               handle: "@baldguymoneyofficial",     tier: 1, pillars: ["tax", "investing", "foundations"] },
  { name: "Mark J. Kohler",               handle: "@MarkJKohler",              tier: 1, pillars: ["tax", "real_estate", "foundations"] },
  { name: "Karlton Dennis",               handle: "@karltondennis",            tier: 1, pillars: ["tax", "foundations"] },
  { name: "Toby Mathis Esq",              handle: "@TobyMathis",               tier: 1, pillars: ["tax", "real_estate", "insurance"] },
  { name: "Navi Maraj, CPA",              handle: "@NaviMarajCPA",             tier: 1, pillars: ["tax", "foundations"] }, // ~82k — slightly under bar but tight niche fit

  // ── Tier 2: adjacent competitors ────────────────────────────
  { name: "Humphrey Yang",                handle: "@humphrey",                 tier: 2, pillars: ["investing", "foundations"] },
  { name: "Rob Berger",                   handle: "@rob_berger",               tier: 2, pillars: ["investing", "foundations"] },
  { name: "Holy Schmidt!",                handle: "@HolySchmidt",              tier: 2, pillars: ["foundations", "tax"] },
  { name: "James Conole, CFP",            channelId: "UCBNdQfS-fzODmYb8Hkr4egA", tier: 2, pillars: ["tax", "investing", "foundations"] }, // Root Financial — retirement+tax, 209k
  { name: "Peak Retirement (Joe Schmitz)",channelId: "UCN58BT7NSxQ-O2s3SQ9_gRg", tier: 2, pillars: ["investing", "tax", "foundations"] }, // 253k
  { name: "WhiteBoard Finance",           handle: "@WhiteBoardFinance",        tier: 2, pillars: ["investing", "real_estate"] },
  { name: "Minority Mindset",             handle: "@MinorityMindset",          tier: 2, pillars: ["investing", "foundations"] },

  // ── Tier 3: pillar specialists ──────────────────────────────
  { name: "BiggerPockets",                handle: "@biggerpockets",            tier: 3, pillars: ["real_estate"] },
  { name: "Dividend Bull",                handle: "@DividendBull",             tier: 3, pillars: ["investing"] },
  { name: "Jarrad Morrow",                handle: "@JarradMorrow",             tier: 3, pillars: ["investing", "foundations"] }, // 182k — ETF/index
  { name: "Graham Stephan",               handle: "@GrahamStephan",            tier: 3, pillars: ["investing", "real_estate"] },
  { name: "ClearValue Tax",               channelId: "UCigUBIf-zt_DA6xyOQtq2WA", tier: 3, pillars: ["tax", "investing", "foundations"] }, // 2.9M — tax/economy

  // ── Tier 4: faceless / format references ────────────────────
  { name: "The Money Guy Show",           handle: "@MoneyGuyShow",             tier: 4, pillars: ["tax", "investing", "foundations"] }, // 676k
  { name: "How Money Works",              handle: "@HowMoneyWorks",            tier: 4, pillars: ["investing", "foundations"] },
  { name: "Chris Invests",                channelId: "UCVoyMclXwlpNwn4S9XMhQrw", tier: 4, pillars: ["investing", "foundations"] }, // 166k — faceless whiteboard
];
