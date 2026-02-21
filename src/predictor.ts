/**
 * Prediction Engine for SA LOTTO
 * Format-aware: uses detected pool size N from analysis.
 * Bayesian smoothed marginals, composite scoring, 10 candidate methods, backtesting.
 */

import {
  K,
  DrawRecord,
  getGroup,
  type FullDiagnostics,
  getOddEvenSplit,
  getSum,
  checkConsecutiveness,
  runFullDiagnostics,
} from "./analysis";

function hashStringToSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Bayesian Smoothed Marginals ────────────────────────────────────
export interface BayesianResult {
  number: number;
  posterior: number;
  rawCount: number;
  weightedCount: number;
}

export function bayesianSmoothed(
  draws: DrawRecord[],
  N: number,
  alpha0 = 1,
  lambda = 0.005,
): BayesianResult[] {
  const T = draws.length;
  const weightedCounts = new Array(N + 1).fill(0);
  let totalWeight = 0;

  for (let t = 0; t < T; t++) {
    const w = Math.exp(-lambda * (T - 1 - t));
    if (isNaN(w) || !isFinite(w)) continue;
    totalWeight += w;
    for (const n of draws[t].numbers) {
      if (n <= N) weightedCounts[n] += w;
    }
  }

  const rawCounts = new Array(N + 1).fill(0);
  for (const d of draws) for (const n of d.numbers) if (n <= N) rawCounts[n]++;

  const totalAlpha = N * alpha0;
  const denominator = totalAlpha + totalWeight * K;

  const results: BayesianResult[] = [];
  for (let i = 1; i <= N; i++) {
    results.push({
      number: i,
      posterior: (alpha0 + weightedCounts[i]) / denominator,
      rawCount: rawCounts[i],
      weightedCount: weightedCounts[i],
    });
  }
  return results;
}

// ─── Composite Scoring ─────────────────────────────────────────────
export interface NumberScore {
  number: number;
  bayesianScore: number;
  hotColdScore: number;
  gapScore: number;
  pairAffinityScore: number;
  tripleAffinityScore: number;
  positionalScore: number;
  transitionScore: number;
  repeatNumberScore: number;
  groupBalanceBonus: number;
  compositeScore: number;
}

// ─── Adaptive Weight Profiles ───────────────────────────────────────
export interface WeightProfile {
  name: string;
  bayesian: number;
  hotCold: number;
  gap: number;
  pair: number;
  triple: number;
  positional: number;
  transition: number;
  repeat: number;
}

export const WEIGHT_PROFILES: WeightProfile[] = [
  {
    name: "Balanced",
    bayesian: 0.15,
    hotCold: 0.15,
    gap: 0.2,
    pair: 0.15,
    triple: 0.2,
    positional: 0.1,
    transition: 0.1,
    repeat: 0.1,
  },
  {
    name: "Trend-Focus",
    bayesian: 0.1,
    hotCold: 0.3,
    gap: 0.1,
    pair: 0.1,
    triple: 0.15,
    positional: 0.1,
    transition: 0.05,
    repeat: 0.15,
  },
  {
    name: "Gap-Target",
    bayesian: 0.1,
    hotCold: 0.1,
    gap: 0.4,
    pair: 0.1,
    triple: 0.15,
    positional: 0.05,
    transition: 0.05,
    repeat: 0.1,
  },
  {
    name: "Cluster-Heavy",
    bayesian: 0.1,
    hotCold: 0.1,
    gap: 0.1,
    pair: 0.25,
    triple: 0.25,
    positional: 0.1,
    transition: 0.1,
    repeat: 0.1,
  },
  {
    name: "Bayesian-Pure",
    bayesian: 0.5,
    hotCold: 0.1,
    gap: 0.05,
    pair: 0.1,
    triple: 0.1,
    positional: 0.05,
    transition: 0.1,
    repeat: 0.1,
  },
  {
    name: "Aggress-X",
    bayesian: 0.05,
    hotCold: 0.1,
    gap: 0.1,
    pair: 0.2,
    triple: 0.2,
    positional: 0.1,
    transition: 0.15,
    repeat: 0.1,
  },
  {
    name: "Bias-Master",
    bayesian: 0.0,
    hotCold: 0.05,
    gap: 0.05,
    pair: 0.15,
    triple: 0.15,
    positional: 0.1,
    transition: 0.4,
    repeat: 0.1,
  },
];

export function compositeScoring(
  diagnostics: FullDiagnostics,
  draws: DrawRecord[],
  profile: WeightProfile = WEIGHT_PROFILES[0],
): NumberScore[] {
  const N = diagnostics.poolSize;
  const bayesian = bayesianSmoothed(draws, N);
  const bayesMax = Math.max(...bayesian.map((b) => b.posterior));
  const bayesMin = Math.min(...bayesian.map((b) => b.posterior));

  const hcMap = new Map(diagnostics.hotCold.map((h) => [h.number, h]));
  const gapMap = new Map(diagnostics.gaps.map((g) => [g.number, g]));

  // PHASE 6: Noise Floor Utility (filter out weak signals) - UPDATED: removed arbitrary threshold
  const filterNoise = (val: number) => Math.max(0, val);

  // Helper for min-max normalization
  const normalizeValues = (arr: number[]) => {
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    if (max === min) return arr.map(() => 0.5);
    return arr.map((v) => (v - min) / (max - min));
  };

  // Pair affinity: sum of z-scores for pairs containing this number
  let pairAffinity = new Array(N + 1).fill(0);
  for (const p of diagnostics.topPairs) {
    if (p.zScore > 0) {
      pairAffinity[p.i] += p.zScore;
      pairAffinity[p.j] += p.zScore;
    }
  }
  pairAffinity = normalizeValues(pairAffinity);

  // Triple affinity
  let tripleAffinity = new Array(N + 1).fill(0);
  for (const t of diagnostics.topTriples) {
    tripleAffinity[t.i] += t.count;
    tripleAffinity[t.j] += t.count;
    tripleAffinity[t.k] += t.count;
  }
  tripleAffinity = normalizeValues(tripleAffinity);

  // Markov Transition: probability based on multiple previous draws (Multi-Lag)
  const transitionScores = new Array(N + 1).fill(0);
  const lagsToSearch = 4;

  for (let lag = 1; lag <= lagsToSearch; lag++) {
    const historicalDraw = draws[draws.length - lag];
    if (!historicalDraw) continue;

    const lagNums = [...historicalDraw.numbers, historicalDraw.bonus].filter(
      (n) => n > 0,
    );
    const lagWeight = Math.pow(0.5, lag - 1); // 1.0, 0.5, 0.25, 0.125

    for (const ln of lagNums) {
      const trans = diagnostics.transitions.find(
        (t) => t.lag === lag && t.fromNumber === ln,
      );
      if (trans) {
        for (const to of trans.toNumbers) {
          // PHASE 5: Exponential Transition Utility
          // we square the probability to favor high-confidence followers (e.g. 0.4 -> 0.16 vs 0.8 -> 0.64)
          // this amplifies strong signals and supresses noise
          transitionScores[to.number] +=
            Math.pow(to.probability, 2) * lagWeight;
        }
      }
    }
  }
  const transitionScoresNormalized = normalizeValues(transitionScores);

  const scores: NumberScore[] = [];

  for (let i = 1; i <= N; i++) {
    const b = bayesian.find((x) => x.number === i)!;
    const bayesianScore =
      bayesMax > bayesMin
        ? (b.posterior - bayesMin) / (bayesMax - bayesMin)
        : 0.5;

    const hc = hcMap.get(i);
    let hotColdScore = 0.5;
    if (hc) {
      // Use delta (z-score) directly as basis for normalized score
      // Range -3 to +3 mapped to 0 to 1
      hotColdScore = Math.max(0, Math.min(1, (hc.delta + 3) / 6));
    }

    const gap = gapMap.get(i);
    let gapScore = 0.5;
    if (gap) {
      const ratio = gap.currentGap / (gap.avgGap || 1);
      // Cap ratio at 3.0 for normalization
      gapScore = Math.min(ratio / 3, 1);
    }

    const pairAffinityScore = pairAffinity[i];
    const tripleAffinityScore = tripleAffinity[i];

    // Positional Score: likelihood of number i being in any of the 6 slots
    let positionalScoreRaw = 0;
    for (const pf of diagnostics.positionalFreq) {
      if (pf.numberFreqs[i]) {
        positionalScoreRaw += pf.numberFreqs[i];
      }
    }
    // Base normalization on history (max possible positional sum across slots)
    const positionalScore = Math.min(positionalScoreRaw / 60, 1.0);

    // ─── Repeat Number Score: numbers from the immediate previous draw
    const lastDraw = draws[draws.length - 1];
    const isRepeat = lastDraw ? lastDraw.numbers.includes(i) : false;
    const repeatNumberScore = isRepeat ? 1.0 : 0.0;

    scores.push({
      number: i,
      bayesianScore,
      hotColdScore,
      gapScore,
      pairAffinityScore,
      tripleAffinityScore,
      positionalScore,
      transitionScore: transitionScoresNormalized[i],
      repeatNumberScore,
      groupBalanceBonus: 0,
      compositeScore: 0,
    });
  }

  // Weights for composite
  const W = profile;

  for (const s of scores) {
    s.compositeScore =
      (W.bayesian || 0) * filterNoise(s.bayesianScore) +
      (W.hotCold || 0) * filterNoise(s.hotColdScore) +
      (W.gap || 0) * filterNoise(s.gapScore) +
      (W.pair || 0) * filterNoise(s.pairAffinityScore) +
      (W.triple || 0) * filterNoise(s.tripleAffinityScore) +
      (W.positional || 0) * s.positionalScore +
      (W.transition || 0) * filterNoise(s.transitionScore) +
      (W.repeat || 0) * s.repeatNumberScore;
  }

  scores.sort((a, b) => b.compositeScore - a.compositeScore);
  return scores;
}

// ─── Candidate Set Generation (10 methods) ──────────────────────────
export interface PredictedSet {
  numbers: number[];
  totalScore: number;
  groupBreakdown: string;
  relativeLift: number;
  method: string;
}

function getGroupBreakdown(nums: number[], N: number): string {
  const g = { Low: 0, Medium: 0, MedHigh: 0, High: 0 };
  for (const n of nums) g[getGroup(n, N)]++;
  return `${g.Low}-${g.Medium}-${g.MedHigh}-${g.High}`;
}

function computeGroupBalanceScore(nums: number[], N: number): number {
  const g = { Low: 0, Medium: 0, MedHigh: 0, High: 0 };
  for (const n of nums) g[getGroup(n, N)]++;
  const counts = Object.values(g);
  const ideal = K / 4;
  const deviation = counts.reduce((sum, c) => sum + Math.pow(c - ideal, 2), 0);
  const maxDeviation = K * K;
  return 1 - deviation / maxDeviation;
}

function computeBalancePenalty(nums: number[], N: number): number {
  // 1. Odd/Even Penalty
  const { odd } = getOddEvenSplit(nums);
  // Penalize 0/6 or 6/0 splits heavily, 1/5 or 5/1 moderately
  let oePenalty = 0;
  if (odd === 0 || odd === 6) oePenalty = 1.0;
  else if (odd === 1 || odd === 5) oePenalty = 0.5;

  // 2. Sum Penalty
  const sum = getSum(nums);
  // Expected sum approx K * N / 2. For N=52 -> 156. Range 100-220 is healthy
  const minSum = K * (N / 4); // rough lower bound
  const maxSum = K * (N * 0.75); // rough upper bound
  let sumPenalty = 0;
  if (sum < minSum || sum > maxSum) sumPenalty = 1.0;

  // 3. Consecutive Penalty
  const cons = checkConsecutiveness(nums);
  // More than 2 consecutive pairs (e.g. 1-2-3-4) is very rare
  let consPenalty = 0;
  if (cons > 2) consPenalty = 1.0;
  if (cons === 2) consPenalty = 0.4;

  return (oePenalty + sumPenalty + consPenalty) / 3;
}

function setScore(
  nums: number[],
  scores: NumberScore[],
  N: number,
  diag: FullDiagnostics,
): number {
  const compositeSum = nums.reduce((sum, n) => {
    const s = scores.find((x) => x.number === n);
    return sum + (s ? s.compositeScore : 0);
  }, 0);

  const groupBonus = computeGroupBalanceScore(nums, N) * 0.1;

  // Pattern Bonus: favor patterns that appear in history
  const breakdown = getGroupBreakdown(nums, N);
  const patternMatch = diag.groupPatterns.find((p) => p.pattern === breakdown);
  const patternBonus = patternMatch ? (patternMatch.percentage / 100) * 1.5 : 0;

  // Relationship Bonus: EXPONENTIAL scaling for high-order clusters
  let relationshipBonus = 0;
  for (const t of diag.topTriples) {
    if (nums.includes(t.i) && nums.includes(t.j) && nums.includes(t.k)) {
      relationshipBonus += Math.pow(1.5, 1); // base bonus
    }
  }
  for (const q of diag.topQuadruples) {
    if (
      nums.includes(q.i) &&
      nums.includes(q.j) &&
      nums.includes(q.k) &&
      nums.includes(q.l)
    ) {
      relationshipBonus += Math.pow(1.5, 2); // squared
    }
  }
  if (diag.topQuintets) {
    for (const q of diag.topQuintets) {
      if (
        nums.includes(q.i) &&
        nums.includes(q.j) &&
        nums.includes(q.k) &&
        nums.includes(q.l) &&
        nums.includes(q.m)
      ) {
        relationshipBonus += Math.pow(1.5, 3); // cubed (aggressive reward)
      }
    }
  }
  // Transition Bonus (Exponential)
  let transitionBonus = 0;
  for (const n of nums) {
    const s = scores.find((x) => x.number === n);
    if (s && s.transitionScore > 0.4)
      transitionBonus += Math.pow(s.transitionScore, 2);
  }

  // PHASE 5: Chain Link Bonus (favor sequences that follow a known path)
  let chainBonus = 0;
  const sortedNums = [...nums].sort((a, b) => a - b);
  // Real implementation: check if any pairs in 'nums' match a transition pair in diag.transitions
  // This is a high-order signal for "3-hit" potential
  for (let i = 0; i < sortedNums.length; i++) {
    for (let j = i + 1; j < sortedNums.length; j++) {
      const a = sortedNums[i];
      const b = sortedNums[j];
      const trans = diag.transitions.find((t) => t.fromNumber === a);
      if (
        trans &&
        trans.toNumbers.some((to) => to.number === b && to.probability > 0.3)
      ) {
        chainBonus += 1.5; // Significant boost for a validated sequential link
      }
    }
  }

  // Delta Penalty: discourage sets with deltas that are very rare
  let deltaPenalty = 0;
  const sorted = [...nums].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length - 1; i++) {
    const d = sorted[i + 1] - sorted[i];
    const stat = diag.deltas.find((x) => x.delta === d);
    if (!stat || stat.percentage < 1.0) deltaPenalty += 0.3;
  }

  // PHASE 7: Match Density Reward
  // Identify how many numbers in the set are 'Anchored' by high-order relationships
  const relationshipNodes = new Set<number>();
  for (const t of diag.topTriples) {
    if (nums.includes(t.i)) relationshipNodes.add(t.i);
    if (nums.includes(t.j)) relationshipNodes.add(t.j);
    if (nums.includes(t.k)) relationshipNodes.add(t.k);
  }
  for (const q of diag.topQuadruples) {
    if (nums.includes(q.i)) relationshipNodes.add(q.i);
    if (nums.includes(q.j)) relationshipNodes.add(q.j);
    if (nums.includes(q.k)) relationshipNodes.add(q.k);
    if (nums.includes(q.l)) relationshipNodes.add(q.l);
  }

  // Reward density: if more than 3 numbers are part of validated clusters, it's a high-probability set
  let densityBonus = 0;
  if (relationshipNodes.size >= 3) densityBonus += 2.0;
  if (relationshipNodes.size >= 4) densityBonus += 3.0;
  if (relationshipNodes.size >= 5) densityBonus += 5.0;

  const balancePenalty = computeBalancePenalty(nums, N) * 2.0;

  return (
    compositeSum +
    groupBonus +
    patternBonus +
    relationshipBonus +
    transitionBonus +
    chainBonus +
    densityBonus -
    balancePenalty -
    deltaPenalty
  );
}

export function generateCandidateSets(
  scores: NumberScore[],
  diagnostics: FullDiagnostics,
  draws: DrawRecord[],
  numSets: number = 10,
  rng: () => number = Math.random,
): PredictedSet[] {
  const N = diagnostics.poolSize;
  const candidates: PredictedSet[] = [];

  const addSet = (nums: number[], method: string) => {
    const sorted = nums.slice(0, K).sort((a, b) => a - b);
    candidates.push({
      numbers: sorted,
      totalScore: setScore(sorted, scores, N, diagnostics),
      groupBreakdown: getGroupBreakdown(sorted, N),
      relativeLift: 0,
      method,
    });
  };

  // 1. Top Composite
  addSet(
    scores.slice(0, K).map((s) => s.number),
    "Top Composite",
  );

  // 2. Group Balanced (1 from each group + fill)
  {
    const byGroup: Map<string, NumberScore[]> = new Map();
    for (const s of scores) {
      const g = getGroup(s.number, N);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(s);
    }
    for (const [, arr] of byGroup)
      arr.sort((a, b) => b.compositeScore - a.compositeScore);
    const balanced: number[] = [];
    for (const [, arr] of byGroup) {
      if (arr.length > 0) balanced.push(arr[0].number);
    }
    for (const s of scores) {
      if (balanced.length >= K) break;
      if (!balanced.includes(s.number)) balanced.push(s.number);
    }
    addSet(balanced, "Group Balanced");
  }

  // 3. Hot + Overdue
  {
    const hotNumbers = diagnostics.hotCold
      .filter((h) => h.status === "hot")
      .sort((a, b) => b.delta - a.delta)
      .map((h) => h.number);
    const overdueNumbers = diagnostics.gaps
      .filter((g) => g.isOverdue)
      .sort((a, b) => b.currentGap / b.avgGap - a.currentGap / a.avgGap)
      .map((g) => g.number);

    const result: number[] = [];
    for (const n of hotNumbers) {
      if (result.length >= 3) break;
      result.push(n);
    }
    for (const n of overdueNumbers) {
      if (result.length >= K) break;
      if (!result.includes(n)) result.push(n);
    }
    for (const s of scores) {
      if (result.length >= K) break;
      if (!result.includes(s.number)) result.push(s.number);
    }
    addSet(result, "Hot + Overdue");
  }

  // 4. Pair Affinity
  {
    const pairSet: number[] = [];
    for (const p of diagnostics.topPairs.slice(0, 5)) {
      if (!pairSet.includes(p.i) && pairSet.length < K) pairSet.push(p.i);
      if (!pairSet.includes(p.j) && pairSet.length < K) pairSet.push(p.j);
    }
    for (const s of scores) {
      if (pairSet.length >= K) break;
      if (!pairSet.includes(s.number)) pairSet.push(s.number);
    }
    addSet(pairSet, "Pair Affinity");
  }

  // 5. Monte Carlo Optimized (20,000 trials + Seeded Sampling)
  {
    const totalComposite = scores.reduce((s, x) => s + x.compositeScore, 0);
    const probDist =
      totalComposite > 0
        ? scores.map((s) => s.compositeScore / totalComposite)
        : scores.map(() => 1 / Math.max(1, scores.length));
    let bestMC: number[] = [];
    let bestMCScore = -Infinity;

    for (let trial = 0; trial < 20000; trial++) {
      let set: number[] = [];
      const available = scores.map((s, idx) => ({
        number: s.number,
        prob: probDist[idx],
      }));

      // Seeded Sampling: 30% of trials start with a top relationship seed
      if (trial % 3 === 0 && diagnostics.topTriples.length > 0) {
        const seed =
          diagnostics.topTriples[
            Math.floor(
              rng() * Math.min(5, diagnostics.topTriples.length),
            )
          ];
        set = [seed.i, seed.j, seed.k];
        // Remove seeds from available
        [seed.i, seed.j, seed.k].forEach((n) => {
          const idx = available.findIndex((a) => a.number === n);
          if (idx !== -1) available.splice(idx, 1);
        });
      }

      while (set.length < K) {
        const totalP = available.reduce((s, a) => s + a.prob, 0);
        let r = rng() * totalP;
        let chosen = 0;
        for (let i = 0; i < available.length; i++) {
          r -= available[i].prob;
          if (r <= 0) {
            chosen = i;
            break;
          }
        }
        set.push(available[chosen].number);
        available.splice(chosen, 1);
      }

      set.sort((a, b) => a - b);

      // Skip sets with extreme features before scoring
      const { odd } = getOddEvenSplit(set);
      if (odd === 0 || odd === 6) continue;

      const score = setScore(set, scores, N, diagnostics);
      if (score > bestMCScore) {
        bestMCScore = score;
        bestMC = [...set];
      }
    }
    addSet(bestMC.length === K ? bestMC : scores.slice(0, K).map((s) => s.number), "Monte Carlo Best");
  }

  // 6. Pattern Mimic (Explicitly follows historical spacing/groups)
  {
    const topPattern = diagnostics.groupPatterns[0];
    const topDeltas = diagnostics.deltas.slice(0, 3).map((d) => d.delta);

    if (topPattern) {
      // Try to build a set that matches the top group pattern
      const bits = topPattern.pattern.split("-").map(Number);
      const groups: Record<string, number[]> = {
        Low: scores
          .filter((s) => getGroup(s.number, N) === "Low")
          .map((s) => s.number),
        Medium: scores
          .filter((s) => getGroup(s.number, N) === "Medium")
          .map((s) => s.number),
        MedHigh: scores
          .filter((s) => getGroup(s.number, N) === "MedHigh")
          .map((s) => s.number),
        High: scores
          .filter((s) => getGroup(s.number, N) === "High")
          .map((s) => s.number),
      };

      const result: number[] = [];
      const keys = ["Low", "Medium", "MedHigh", "High"];
      bits.forEach((count, i) => {
        const groupNums = groups[keys[i]] || [];
        for (let j = 0; j < count; j++) {
          if (groupNums[j]) result.push(groupNums[j]);
        }
      });

      if (result.length === K) {
        // Simple verification: ensure at least one common delta exists
        const sortedR = [...result].sort((a, b) => a - b);
        let hasCommonDelta = false;
        for (let i = 0; i < sortedR.length - 1; i++) {
          if (topDeltas.includes(sortedR[i + 1] - sortedR[i])) {
            hasCommonDelta = true;
            break;
          }
        }
        if (hasCommonDelta) {
          addSet(result, "Pattern Mimic");
        } else {
          // If no common delta, it might be too sparse, but let's add it anyway if it's the only one
          // but maybe with a slightly lower score (setScore handles this via deltaPenalty)
          addSet(result, "Pattern Mimic");
        }
      }
    }
  }

  // 7. Genetic Jackpot Optimizer (Elite evolution)
  {
    const gaResult = runGeneticOptimization(scores, diagnostics, rng);
    addSet(gaResult, "Jackpot Target");
  }

  // 6. Pure Overdue (most overdue by gap ratio)
  {
    const overdueByRatio = diagnostics.gaps
      .filter((g) => g.avgGap > 0)
      .sort((a, b) => b.currentGap / b.avgGap - a.currentGap / a.avgGap)
      .map((g) => g.number);
    addSet(overdueByRatio.slice(0, K), "Most Overdue");
  }

  // 7. Frequency Leaders (all-time most frequent)
  {
    const freqSorted = [...diagnostics.frequency].sort(
      (a, b) => b.count - a.count,
    );
    addSet(
      freqSorted.slice(0, K).map((f) => f.number),
      "Frequency Leaders",
    );
  }

  // 9. Markov Flow (Sequential Pathwalking)
  {
    const flowSet: number[] = [];
    const lastDraw = draws[draws.length - 1];
    if (lastDraw) {
      const seeds = [...lastDraw.numbers, lastDraw.bonus].filter((n) => n > 0);
      for (const s of seeds) {
        const trans = diagnostics.transitions.find(
          (t) => t.lag === 1 && t.fromNumber === s,
        );
        if (trans) {
          for (const to of trans.toNumbers) {
            if (!flowSet.includes(to.number)) flowSet.push(to.number);
            if (flowSet.length >= K) break;
          }
        }
        if (flowSet.length >= K) break;
      }
    }
    // Fill if needed
    for (const s of scores) {
      if (flowSet.length >= K) break;
      if (!flowSet.includes(s.number)) flowSet.push(s.number);
    }
    addSet(flowSet, "Markov Flow");
  }

  // 10. Bayesian Top (pure Bayesian posterior)
  {
    // Use scores which already contain Bayesian component — pick top by bayesianScore
    const bayesSorted = [...scores].sort(
      (a, b) => b.bayesianScore - a.bayesianScore,
    );
    addSet(
      bayesSorted.slice(0, K).map((s) => s.number),
      "Bayesian Top",
    );
  }

  // 9. Cold Reversal (cold numbers expected to revert to mean)
  {
    const coldNums = diagnostics.hotCold
      .filter((h) => h.status === "cold")
      .sort((a, b) => a.delta - b.delta) // most cold first
      .map((h) => h.number);
    const neutralHigh = diagnostics.hotCold
      .filter((h) => h.status === "neutral")
      .sort((a, b) => b.allTimeFreq - a.allTimeFreq)
      .map((h) => h.number);
    const result: number[] = [];
    for (const n of coldNums) {
      if (result.length >= 4) break;
      result.push(n);
    }
    for (const n of neutralHigh) {
      if (result.length >= K) break;
      if (!result.includes(n)) result.push(n);
    }
    for (const s of scores) {
      if (result.length >= K) break;
      if (!result.includes(s.number)) result.push(s.number);
    }
    addSet(result, "Cold Reversal");
  }

  // 10. Sliding Window (picks blocks of high-scoring numbers)
  {
    for (let i = 0; i <= scores.length - K; i++) {
      const combo = scores.slice(i, i + K).map((s) => s.number);
      addSet(combo, "Sliding Window High");
    }
  }

  // METHOD: Chain Master (Phase 6 - High Order Transitions)
  const lastDrawForChain = draws.length > 0 ? draws[draws.length - 1] : null;
  if (lastDrawForChain) {
    const lastNums = [
      ...lastDrawForChain.numbers,
      lastDrawForChain.bonus,
    ].filter((n) => n > 0);
    const chainSet = new Set<number>();

    // Follow the strongest 2-step chains starting from last draw's numbers
    for (const startNum of lastNums) {
      const step1 = diagnostics.transitions.find(
        (t) => t.lag === 1 && t.fromNumber === startNum,
      );
      if (step1 && step1.toNumbers.length > 0) {
        const next1 = step1.toNumbers[0].number;
        chainSet.add(next1);
        const step2 = diagnostics.transitions.find(
          (t) => t.lag === 1 && t.fromNumber === next1,
        );
        if (step2 && step2.toNumbers.length > 0) {
          chainSet.add(step2.toNumbers[0].number);
        }
      }
    }
    if (chainSet.size >= K) {
      addSet(Array.from(chainSet).slice(0, K), "Chain Master");
    }
  }

  // 10. Weighted Random Ensemble (blend of all strategies)
  {
    // Create a frequency map from all candidates so far
    const numFreq = new Array(N + 1).fill(0);
    for (const c of candidates) {
      for (const n of c.numbers) numFreq[n]++;
    }
    // Numbers that appear in most candidate sets are likely good picks
    const rankedByConsensus = Array.from({ length: N }, (_, i) => i + 1)
      .map((n) => ({
        number: n,
        consensus: numFreq[n],
        score: scores.find((s) => s.number === n)?.compositeScore || 0,
      }))
      .sort(
        (a, b) => b.consensus * 10 + b.score - (a.consensus * 10 + a.score),
      );
    addSet(
      rankedByConsensus.slice(0, K).map((r) => r.number),
      "Consensus Pick",
    );
  }

  // 8. Historical Echo (numbers from eras with similar statistical profiles)
  {
    const echoes = findHistoricalEchoes(scores, diagnostics, draws);
    if (echoes.length >= K) {
      addSet(echoes.slice(0, K), "Historical Echo");
    }
  }

  // Calculate relative lift
  const maxScore = Math.max(...candidates.map((c) => c.totalScore));
  for (const c of candidates) {
    c.relativeLift = maxScore > 0 ? c.totalScore / maxScore : 1;
  }

  // Sort by score descending
  candidates.sort((a, b) => b.totalScore - a.totalScore);

  // Remove duplicates
  const unique: PredictedSet[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = c.numbers.join(",");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  return unique.slice(0, numSets);
}

// ─── Backtesting ────────────────────────────────────────────────────
export interface BacktestResult {
  trainSize: number;
  testSize: number;
  modelHits: number;
  baselineHitRate: number;
  modelHitRate: number;
  improvement: number;
  top6Overlap: number;
  rowDetails: Array<{
    date: string;
    actual: number[];
    predictedTop6: number[];
    overlap: number;
  }>;
  profilePerformance: Array<{
    name: string;
    overlap: number;
    rollingHistory?: number[];
  }>;
  finalDiagnostics: FullDiagnostics;
  finalBestProfile: WeightProfile;
  learningTrend: number; // Percentage change (Last 50 vs First 50)
  earlyMatches: number; // Avg matches in first 50
  recentMatches: number; // Avg matches in last 50
  fourPlusHits: number;
  fourPlusRate: number;
}

function matchUtility(overlap: number): number {
  if (overlap >= 5) return overlap + 8;
  if (overlap >= 4) return overlap + 4;
  if (overlap === 3) return overlap + 1;
  return overlap;
}

export function backtest(
  draws: DrawRecord[],
  N: number,
  trainRatio = 0.8, // Updated to 80/20 as requested
): BacktestResult {
  if (draws.length < 2) {
    const diagnostics = runFullDiagnostics(draws);
    return {
      trainSize: draws.length,
      testSize: 0,
      modelHits: 0,
      baselineHitRate: 7 / N,
      modelHitRate: 0,
      improvement: 0,
      top6Overlap: 0,
      rowDetails: [],
      profilePerformance: WEIGHT_PROFILES.map((p) => ({
        name: p.name,
        overlap: 0,
      })),
      finalDiagnostics: diagnostics,
      finalBestProfile: WEIGHT_PROFILES[0],
      learningTrend: 0,
      earlyMatches: 0,
      recentMatches: 0,
      fourPlusHits: 0,
      fourPlusRate: 0,
    };
  }

  const splitIdx = Math.floor(draws.length * trainRatio);
  const trainDraws = draws.slice(0, splitIdx);
  const testDraws = draws.slice(splitIdx);

  // Initial training: find best starting profile
  let currentDiagnostics = runFullDiagnostics(trainDraws);
  let bestProfile = WEIGHT_PROFILES[0];
  let bestProfileOverlap = -1;
  const profilePerformance = WEIGHT_PROFILES.map((p) => ({
    name: p.name,
    overlap: 0,
    rollingHistory: [] as number[],
  }));

  // Initial profile sweep on training data (last 50 draws of training)
  const valWindow = 50;
  const valStart = Math.max(0, trainDraws.length - valWindow);
  const valTrain = trainDraws.slice(0, valStart);
  const valTest = trainDraws.slice(valStart);

  if (valTrain.length > 50) {
    const valDiag = runFullDiagnostics(valTrain);
    for (const profile of WEIGHT_PROFILES) {
      const s = compositeScoring(valDiag, valTrain, profile);
      const seededValRng = createSeededRandom(
        hashStringToSeed(`val:${profile.name}:${valTrain.length}`),
      );
      const valSet = generateCandidateSets(
        s,
        valDiag,
        valTrain,
        1,
        seededValRng,
      )[0]?.numbers;
      const t6 = new Set(valSet ?? s.slice(0, K).map((x) => x.number));
      let o = 0;
      for (const d of valTest) {
        const overlap = d.numbers.filter((n) => t6.has(n)).length;
        o += matchUtility(overlap);
      }
      if (o > bestProfileOverlap) {
        bestProfileOverlap = o;
        bestProfile = profile;
      }
    }
  }

  let hits = 0;
  let fourPlusHits = 0;
  let top6TotalOverlap = 0;
  const rowDetails: Array<{
    date: string;
    actual: number[];
    predictedTop6: number[];
    overlap: number;
  }> = [];

  // Iterative Learning Loop: for each test draw, predict -> validate -> learn
  const history = [...trainDraws];

  for (const testDraw of testDraws) {
    // 1. Predict using current best profile and latest diagnostics
    const currentScores = compositeScoring(
      currentDiagnostics,
      history,
      bestProfile,
    );
    const drawSeed = `${testDraw.date}:${history.length}:${bestProfile.name}`;
    const drawRng = createSeededRandom(hashStringToSeed(drawSeed));
    const bestSet = generateCandidateSets(
      currentScores,
      currentDiagnostics,
      history,
      1,
      drawRng,
    )[0]?.numbers;
    const top6 = new Set(bestSet ?? currentScores.slice(0, K).map((s) => s.number));

    // 2. Validate against actual draw (main numbers only, 6-of-N objective)
    const actualMain = [...testDraw.numbers].filter((n) => n > 0);
    const t6Overlap = actualMain.filter((n) => top6.has(n)).length;

    if (t6Overlap > 0) hits++;
    if (t6Overlap >= 4) fourPlusHits++;
    top6TotalOverlap += t6Overlap;

    rowDetails.push({
      date: testDraw.date,
      actual: actualMain.sort((a, b) => a - b),
      predictedTop6: Array.from(top6).sort((a, b) => a - b),
      overlap: t6Overlap,
    });

    // 3. Reinforcement update without leakage:
    // evaluate profile predictions built from pre-outcome history only.
    const rollingWindow = 50;
    WEIGHT_PROFILES.forEach((p, idx) => {
      const ps = compositeScoring(currentDiagnostics, history, p);
      const profileSeed = `${testDraw.date}:${history.length}:${p.name}`;
      const profileRng = createSeededRandom(hashStringToSeed(profileSeed));
      const profileSet = generateCandidateSets(
        ps,
        currentDiagnostics,
        history,
        1,
        profileRng,
      )[0]?.numbers;
      const pt6 = new Set(profileSet ?? ps.slice(0, K).map((x) => x.number));
      const po = actualMain.filter((n) => pt6.has(n)).length;

      // Update rolling overlap (we store per-draw result and sum the last 50)
      if (!profilePerformance[idx].rollingHistory)
        (profilePerformance[idx] as any).rollingHistory = [];
      const rh = (profilePerformance[idx] as any).rollingHistory as number[];
      rh.push(matchUtility(po));
      if (rh.length > rollingWindow) rh.shift();
      profilePerformance[idx].overlap = rh.reduce((a, b) => a + b, 0);
    });

    // 4. "Learn" - Update history and diagnostics for the NEXT prediction
    history.push(testDraw);
    currentDiagnostics = runFullDiagnostics(history);

    // Strategy: Every 5 draws, compute a NEURAL ENSEMBLE profile (Phase 7)
    // We blend all profiles based on their rolling overlap squared (to favor experts)
    if (history.length % 5 === 0) {
      const totalPower =
        profilePerformance.reduce(
          (acc, p) => acc + Math.pow(p.overlap, 2),
          0,
        ) || 1;

      const ensembleProfile: WeightProfile = {
        name: "Neural Ensemble",
        bayesian: 0,
        hotCold: 0,
        gap: 0,
        pair: 0,
        triple: 0,
        positional: 0,
        transition: 0,
        repeat: 0,
      };

      WEIGHT_PROFILES.forEach((p, idx) => {
        const profileWeight =
          Math.pow(profilePerformance[idx].overlap, 2) / totalPower;
        ensembleProfile.bayesian! += (p.bayesian || 0) * profileWeight;
        ensembleProfile.hotCold! += (p.hotCold || 0) * profileWeight;
        ensembleProfile.gap! += (p.gap || 0) * profileWeight;
        ensembleProfile.pair! += (p.pair || 0) * profileWeight;
        ensembleProfile.triple! += (p.triple || 0) * profileWeight;
        ensembleProfile.positional! += (p.positional || 0) * profileWeight;
        ensembleProfile.transition! += (p.transition || 0) * profileWeight;
        ensembleProfile.repeat! += (p.repeat || 0) * profileWeight;
      });

      bestProfile = ensembleProfile;
    }
  }

  const avgTop6Overlap =
    testDraws.length > 0 ? top6TotalOverlap / testDraws.length : 0;
  const modelHitRate = avgTop6Overlap / K; // Hits per prediction slot
  const baselinePercentage = K / N; // Expected hit-rate for random 6-number pick

  const result: BacktestResult = {
    trainSize: trainDraws.length,
    testSize: testDraws.length,
    modelHits: hits,
    baselineHitRate: baselinePercentage,
    modelHitRate: modelHitRate,
    improvement:
      baselinePercentage > 0
        ? ((modelHitRate - baselinePercentage) / baselinePercentage) * 100
        : 0,
    top6Overlap: avgTop6Overlap,
    rowDetails,
    profilePerformance,
    finalDiagnostics: currentDiagnostics,
    finalBestProfile: bestProfile,
    learningTrend: 0,
    earlyMatches: 0,
    recentMatches: 0,
    fourPlusHits,
    fourPlusRate: testDraws.length > 0 ? fourPlusHits / testDraws.length : 0,
  };

  // PHASE 6: Calculate Learning Trend (Recent 50 vs First 50 test rows)
  const windowSize = 50;
  if (rowDetails.length >= windowSize * 2) {
    const earlyRows = rowDetails.slice(0, windowSize);
    const recentRows = rowDetails.slice(-windowSize);
    const earlyAvg = earlyRows.reduce((s, r) => s + r.overlap, 0) / windowSize;
    const recentAvg =
      recentRows.reduce((s, r) => s + r.overlap, 0) / windowSize;

    result.earlyMatches = earlyAvg;
    result.recentMatches = recentAvg;
    result.learningTrend =
      earlyAvg > 0 ? ((recentAvg - earlyAvg) / earlyAvg) * 100 : 0;
  }

  return result;
}

// ─── Full Prediction Pipeline ───────────────────────────────────────
export interface PredictionOutput {
  sets: PredictedSet[];
  backtest: BacktestResult;
  scores: NumberScore[];
  bayesian: BayesianResult[];
  warning: string;
}

const MAX_PREDICTION_WINDOW_DRAWS = 450;

export function runPrediction(
  draws: DrawRecord[],
  diagnostics: FullDiagnostics,
): PredictionOutput {
  const N = diagnostics.poolSize;

  // Keep prediction latency stable on large uploads.
  // A smaller rolling window still captures recent behavior while preventing
  // expensive O(n²) backtest loops from locking up the UI.
  const targetWindow = MAX_PREDICTION_WINDOW_DRAWS;
  const startIndex = Math.max(0, draws.length - targetWindow);
  // PHASE 5: Enforce chronological order (Oldest -> Newest) for correct learning direction
  const eraDraws = draws.slice(startIndex).sort((a, b) => {
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  // PHASE 5: Run backtest FIRST to "warm up" the model through online learning
  const bt = backtest(eraDraws, N);
  const seedBase = eraDraws
    .slice(-50)
    .map((d) => `${d.date}:${d.numbers.join("-")}:${d.bonus}`)
    .join("|");
  const rng = createSeededRandom(hashStringToSeed(seedBase));

  // Use the learned state for the final next-draw prediction
  const learnedProfile = bt.finalBestProfile;
  const learnedDiagnostics = bt.finalDiagnostics;

  const finalScores = compositeScoring(
    learnedDiagnostics,
    eraDraws,
    learnedProfile,
  );
  const sets = generateCandidateSets(
    finalScores,
    learnedDiagnostics,
    eraDraws,
    10,
    rng,
  );
  const bays = bayesianSmoothed(eraDraws, N);

  let warning: string;
  if (!learnedDiagnostics.biasDetected) {
    warning =
      "⚠️ No statistically significant bias detected in the current format era. " +
      "Under fair lottery conditions, every combination is equally likely. " +
      "These predictions are based on historical pattern analysis and should be treated as entertainment only.";
  } else {
    warning =
      "⚠️ Some statistical deviations were detected in the current format era. " +
      `Optimized Profile: ${learnedProfile.name}. ` +
      "Play responsibly.";
  }

  return { sets, backtest: bt, scores: finalScores, bayesian: bays, warning };
}

// ─── Genetic Algorithm Optimization ─────────────────────────────────
function runGeneticOptimization(
  scores: NumberScore[],
  diag: FullDiagnostics,
  rng: () => number,
  generations = 100,
  popSize = 250,
): number[] {
  const N = diag.poolSize;
  const topN = 24; // Compress search space to top 24 numbers
  const numPool = scores.slice(0, topN).map((s) => s.number);

  // Initial Population
  let population: number[][] = [];
  for (let i = 0; i < popSize; i++) {
      const set: number[] = [];
      while (set.length < K) {
      const n = numPool[Math.floor(rng() * numPool.length)];
      if (!set.includes(n)) set.push(n);
    }
    population.push(set.sort((a, b) => a - b));
  }

  for (let gen = 0; gen < generations; gen++) {
    // 1. Fitness Calculation
    // PHASE 7: Aggressively target "Match Density" (high overlap probability)
    const fitnessResults = population.map((set) => {
      const baseScore = setScore(set, scores, N, diag);

      // Penalize sets that lack high-order relationship variety
      // Reward sets that sit in the "sweet spot" of recent transition hubs
      return { set, score: baseScore };
    });

    // Elitism: keep top 10%
    const ranked = [...fitnessResults].sort((a, b) => b.score - a.score);
    const nextGen: number[][] = ranked
      .slice(0, Math.floor(popSize * 0.1))
      .map((r) => r.set);

    // Tournament Selection
    const tournament = (size: number): number[] => {
      let best = fitnessResults[Math.floor(rng() * popSize)];
      for (let i = 1; i < size; i++) {
        const contestant = fitnessResults[Math.floor(rng() * popSize)];
        if (contestant.score > best.score) best = contestant;
      }
      return best.set;
    };

    // 3. Crossover & Mutation
    while (nextGen.length < popSize) {
      const p1 = tournament(5);
      const p2 = tournament(5);

      // Uniform Crossover
      const offspringSet = new Set<number>();
      for (let i = 0; i < K; i++) {
        offspringSet.add(rng() < 0.5 ? p1[i] : p2[i]);
      }
      // Fill missing numbers (restricted to Top N pool)
      while (offspringSet.size < K) {
        const n = numPool[Math.floor(rng() * numPool.length)];
        offspringSet.add(n);
      }
      let offspring = Array.from(offspringSet).sort((a, b) => a - b);

      // Adaptive Mutation (restricted to Top N pool)
      const mutationRate = 0.1; // Consistent mutation rate
      if (rng() < mutationRate) {
        const idx = Math.floor(rng() * K);
        let newN = numPool[Math.floor(rng() * numPool.length)];
        // Ensure strictly new number
        while (offspring.includes(newN)) {
          newN = numPool[Math.floor(rng() * numPool.length)];
        }
        offspring[idx] = newN;
        offspring.sort((a, b) => a - b);
      }
      nextGen.push(offspring);
    }
    population = nextGen;
  }

  // Return the best of all generations
  const finalRanked = population
    .map((set) => ({ set, score: setScore(set, scores, N, diag) }))
    .sort((a, b) => b.score - a.score);

  return finalRanked[0].set;
}

// ─── Cross-Era Similarity Search ────────────────────────────────────
function findHistoricalEchoes(
  scores: NumberScore[],
  diag: FullDiagnostics,
  draws: DrawRecord[],
): number[] {
  const currentProfile = {
    chi: diag.chiSquare.chiSquare,
    ac: diag.autocorrelation.filter((a) => a.isSignificant).length,
    hot: diag.hotCold.filter((h) => h.status === "hot").length,
    overdue: diag.gaps.filter((g) => g.isOverdue).length,
  };

  const windowSize = 50;
  const echoes: number[] = [];
  const similarityScores: { index: number; score: number }[] = [];

  // Slide through history to find statistically similar 50-draw windows
  for (let i = 0; i < draws.length - windowSize - 1; i++) {
    const windowDraws = draws.slice(i, i + windowSize);
    const windowDiag = runFullDiagnostics(windowDraws);

    if (windowDiag.poolSize !== diag.poolSize) continue;

    const windowProfile = {
      chi: windowDiag.chiSquare.chiSquare,
      ac: windowDiag.autocorrelation.filter((a) => a.isSignificant).length,
      hot: windowDiag.hotCold.filter((h) => h.status === "hot").length,
      overdue: windowDiag.gaps.filter((g) => g.isOverdue).length,
    };

    // Euclidean distance (normalized roughly)
    const dist = Math.sqrt(
      Math.pow((currentProfile.chi - windowProfile.chi) / 20, 2) +
        Math.pow(currentProfile.ac - windowProfile.ac, 2) +
        Math.pow(currentProfile.hot - windowProfile.hot, 2) +
        Math.pow(currentProfile.overdue - windowProfile.overdue, 2),
    );

    if (dist < 3.0) {
      similarityScores.push({ index: i, score: dist });
    }
  }

  similarityScores.sort((a, b) => a.score - b.score);

  // Take the draw immediately after the top 3 most similar windows
  for (let i = 0; i < Math.min(3, similarityScores.length); i++) {
    const nextDraw = draws[similarityScores[i].index + windowSize];
    if (nextDraw) {
      for (const n of nextDraw.numbers) {
        if (!echoes.includes(n)) echoes.push(n);
      }
    }
  }

  // Fill with high-composite numbers if needed
  for (const s of scores) {
    if (echoes.length >= 12) break;
    if (!echoes.includes(s.number)) echoes.push(s.number);
  }

  return echoes;
}
