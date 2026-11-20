/**
 * Recorded fixture markets for the stub Delphi adapter, in the real
 * Delphi Market shape (see `types.ts`).
 *
 * These are obviously fake: every id is a near-zero contract address
 * (0x0000...0001 and friends), every question is about a fictional
 * near-future event (invented countries, companies, teams, and
 * tokens), every URL points at example.invalid (a host that can never
 * resolve), and no real personal data appears anywhere. They stand in
 * for the real market list until the official Delphi API is published
 * on 23 November 2026 (ticket 08 replaces the stub with the live
 * client).
 *
 * The competition extension (odds, reward pot, evidence cutoff) is
 * present on the open markets; the market awaiting settlement carries
 * none, because its odds, pot, and cutoff are no longer live.
 */

import type { Market } from "./types.js";

export const fixtureMarkets: Market[] = [
  {
    appMarketId: "00000000-0000-4000-8000-000000000001",
    category: "politics",
    competition: {
      evidenceCutoff: "2026-12-30T00:00:00.000Z",
      oddsNo: 0.38,
      oddsYes: 0.62,
      rewardPot: 250,
    },
    createdAt: "2026-11-18T09:00:00.000Z",
    dataSources: ["https://example.invalid/sources/zanara-election-commission"],
    deployer: "0x00000000000000000000000000000000000000d1",
    error: null,
    fetchedAt: "2026-11-20T00:00:00.000Z",
    fetchResponseStatus: "200",
    id: "0x0000000000000000000000000000000000000001",
    implementation: "0x00000000000000000000000000000000000000a1",
    marketUrl:
      "https://example.invalid/markets/0x0000000000000000000000000000000000000001",
    metadata: {
      category: "politics",
      description:
        "Resolves Yes if the Republic of Zanara holds a general election on or before 31 December 2026.",
      endDate: "2026-12-31T00:00:00.000Z",
      outcomes: ["Yes", "No"],
      question:
        "Will the Republic of Zanara hold a general election before 31 December 2026?",
      resolutionCriteria:
        "The Zanara Election Commission announces a general election date on or before 31 December 2026.",
      title: "Zanara general election before 31 December 2026",
    },
    metadataUri: "https://example.invalid/metadata/zanara-election.json",
    metadataUriContentHash:
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    proof: null,
    resolvesAt: null,
    settledAt: null,
    settlesAt: "2027-01-07T00:00:00.000Z",
    status: "open",
    tradingFee: "0.02",
    verifiable: true,
    winningOutcomeIdx: null,
  },
  {
    appMarketId: "00000000-0000-4000-8000-000000000002",
    category: "economics",
    competition: {
      evidenceCutoff: "2027-02-28T00:00:00.000Z",
      oddsNo: 0.71,
      oddsYes: 0.29,
      rewardPot: 180,
    },
    createdAt: "2026-11-19T12:30:00.000Z",
    dataSources: ["https://example.invalid/sources/meridian-central-bank"],
    deployer: "0x00000000000000000000000000000000000000d2",
    error: null,
    fetchedAt: "2026-11-20T00:00:00.000Z",
    fetchResponseStatus: "200",
    id: "0x0000000000000000000000000000000000000002",
    implementation: "0x00000000000000000000000000000000000000a2",
    marketUrl:
      "https://example.invalid/markets/0x0000000000000000000000000000000000000002",
    metadata: {
      category: "economics",
      description:
        "Resolves Yes if the Meridian Central Bank raises its policy rate above 5% on or before 1 March 2027.",
      endDate: "2027-03-01T00:00:00.000Z",
      outcomes: ["Yes", "No"],
      question:
        "Will the Meridian Central Bank raise its policy rate above 5% before 1 March 2027?",
      resolutionCriteria:
        "The Meridian Central Bank publishes a policy rate above 5% on or before 1 March 2027.",
      title: "Meridian policy rate above 5% before 1 March 2027",
    },
    metadataUri: "https://example.invalid/metadata/meridian-rate.json",
    metadataUriContentHash:
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    proof: null,
    resolvesAt: null,
    settledAt: null,
    settlesAt: "2027-03-08T00:00:00.000Z",
    status: "open",
    tradingFee: "0.02",
    verifiable: true,
    winningOutcomeIdx: null,
  },
  {
    appMarketId: "00000000-0000-4000-8000-000000000003",
    category: "sports",
    createdAt: "2026-11-10T08:00:00.000Z",
    dataSources: ["https://example.invalid/sources/aurora-cup-results"],
    deployer: "0x00000000000000000000000000000000000000d3",
    error: null,
    fetchedAt: "2026-11-20T00:00:00.000Z",
    fetchResponseStatus: "200",
    id: "0x0000000000000000000000000000000000000003",
    implementation: "0x00000000000000000000000000000000000000a3",
    marketUrl:
      "https://example.invalid/markets/0x0000000000000000000000000000000000000003",
    metadata: {
      category: "sports",
      description:
        "Resolves Yes if Northgate Rovers win the 2027 Aurora Cup.",
      endDate: "2027-06-15T00:00:00.000Z",
      outcomes: ["Yes", "No"],
      question: "Will Northgate Rovers win the 2027 Aurora Cup?",
      resolutionCriteria:
        "The Aurora Cup final result lists Northgate Rovers as winners.",
      title: "Northgate Rovers win the 2027 Aurora Cup",
    },
    metadataUri: "https://example.invalid/metadata/aurora-cup.json",
    metadataUriContentHash:
      "0x0000000000000000000000000000000000000000000000000000000000000003",
    proof: null,
    resolvesAt: "2027-06-16T00:00:00.000Z",
    settledAt: null,
    settlesAt: "2027-06-22T00:00:00.000Z",
    status: "awaiting_settlement",
    tradingFee: "0.02",
    verifiable: true,
    winningOutcomeIdx: null,
  },
  {
    appMarketId: "00000000-0000-4000-8000-000000000004",
    category: "crypto",
    competition: {
      evidenceCutoff: "2027-05-31T00:00:00.000Z",
      oddsNo: 0.83,
      oddsYes: 0.17,
      rewardPot: 420,
    },
    createdAt: "2026-11-20T06:00:00.000Z",
    dataSources: ["https://example.invalid/sources/aurora-token-market-data"],
    deployer: "0x00000000000000000000000000000000000000d4",
    error: null,
    fetchedAt: "2026-11-20T00:00:00.000Z",
    fetchResponseStatus: "200",
    id: "0x0000000000000000000000000000000000000004",
    implementation: "0x00000000000000000000000000000000000000a4",
    marketUrl:
      "https://example.invalid/markets/0x0000000000000000000000000000000000000004",
    metadata: {
      category: "crypto",
      description:
        "Resolves Yes if the AURORA token reaches a market capitalisation above $1 billion on or before 1 June 2027.",
      endDate: "2027-06-01T00:00:00.000Z",
      outcomes: ["Yes", "No"],
      question:
        "Will the AURORA token reach a market capitalisation above $1 billion before 1 June 2027?",
      resolutionCriteria:
        "A public market-data source reports AURORA above a $1 billion market capitalisation on or before 1 June 2027.",
      title: "AURORA token above $1 billion market cap before 1 June 2027",
    },
    metadataUri: "https://example.invalid/metadata/aurora-token.json",
    metadataUriContentHash:
      "0x0000000000000000000000000000000000000000000000000000000000000004",
    proof: null,
    resolvesAt: null,
    settledAt: null,
    settlesAt: "2027-06-08T00:00:00.000Z",
    status: "open",
    tradingFee: "0.02",
    verifiable: true,
    winningOutcomeIdx: null,
  },
  {
    appMarketId: "00000000-0000-4000-8000-000000000005",
    category: "technology",
    competition: {
      evidenceCutoff: "2027-12-31T00:00:00.000Z",
      oddsNo: 0.64,
      oddsYes: 0.36,
      rewardPot: 300,
    },
    createdAt: "2026-11-20T14:15:00.000Z",
    dataSources: ["https://example.invalid/sources/quantleaf-announcements"],
    deployer: "0x00000000000000000000000000000000000000d5",
    error: null,
    fetchedAt: "2026-11-20T00:00:00.000Z",
    fetchResponseStatus: "200",
    id: "0x0000000000000000000000000000000000000005",
    implementation: "0x00000000000000000000000000000000000000a5",
    marketUrl:
      "https://example.invalid/markets/0x0000000000000000000000000000000000000005",
    metadata: {
      category: "technology",
      description:
        "Resolves Yes if Quantleaf ships a 1,000-qubit quantum computer on or before 1 January 2028. Its metadata carries no end date, so the close time falls back to the scheduled settlement time.",
      outcomes: ["Yes", "No"],
      question:
        "Will Quantleaf ship a 1,000-qubit quantum computer before 1 January 2028?",
      resolutionCriteria:
        "Quantleaf publicly announces a shipped 1,000-qubit quantum computer on or before 1 January 2028.",
      title: "Quantleaf ships a 1,000-qubit quantum computer before 1 January 2028",
    },
    metadataUri: "https://example.invalid/metadata/quantleaf-qubit.json",
    metadataUriContentHash:
      "0x0000000000000000000000000000000000000000000000000000000000000005",
    proof: null,
    resolvesAt: null,
    settledAt: null,
    settlesAt: "2028-01-01T00:00:00.000Z",
    status: "open",
    tradingFee: "0.02",
    verifiable: true,
    winningOutcomeIdx: null,
  },
];
