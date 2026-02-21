"use strict";
/**
 * Prediction Engine for SA LOTTO
 * Format-aware: uses detected pool size N from analysis.
 * Bayesian smoothed marginals, composite scoring, 10 candidate methods, backtesting.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEIGHT_PROFILES = void 0;
exports.calibrateRuntimeBudgets = calibrateRuntimeBudgets;
exports.createDiagnosticsCache = createDiagnosticsCache;
exports.bayesianSmoothed = bayesianSmoothed;
exports.compositeScoring = compositeScoring;
exports.generateCandidateSets = generateCandidateSets;
exports.backtest = backtest;
exports.runPrediction = runPrediction;
exports.refreshPredictionCandidates = refreshPredictionCandidates;
const analysis_1 = require("./analysis");
const BASE_MONTE_CARLO_MIN_TRIALS = 2000;
const BASE_MONTE_CARLO_MAX_TRIALS = 10000;
const BASE_BACKTEST_REFRESH_EVERY = 8;
const BASE_HISTORICAL_ECHO_MAX_DRAWS = 320;
const BASE_HISTORICAL_ECHO_MAX_WINDOWS = 120;
const BASE_HISTORICAL_ECHO_TOP_MATCHES = 3;
const BASE_GENETIC_GENERATIONS = 45;
const BASE_GENETIC_POPULATION = 120;
const DEFAULT_TARGET_LATENCY_MS = 1400;
function calibrateRuntimeBudgets(drawCount, options = {}) {
    const fastMode = options.fastMode ?? false;
    const safeDrawCount = Math.max(1, drawCount);
    const latencyScale = Math.max(0.65, Math.min(1.35, (options.targetLatencyMs || DEFAULT_TARGET_LATENCY_MS) / DEFAULT_TARGET_LATENCY_MS));
    let sizeScale = 1;
    if (safeDrawCount <= 160)
        sizeScale = 1.2;
    else if (safeDrawCount <= 320)
        sizeScale = 1;
    else if (safeDrawCount <= 480)
        sizeScale = 0.82;
    else
        sizeScale = 0.65;
    const modeScale = fastMode ? 0.38 : 1;
    const combinedScale = sizeScale * modeScale * latencyScale;
    const monteCarloMinTrials = Math.max(250, Math.round(BASE_MONTE_CARLO_MIN_TRIALS * combinedScale));
    const monteCarloMaxTrials = Math.max(monteCarloMinTrials + 800, Math.round(BASE_MONTE_CARLO_MAX_TRIALS * combinedScale));
    const geneticGenerations = Math.max(10, Math.round(BASE_GENETIC_GENERATIONS * combinedScale));
    const geneticPopulation = Math.max(36, Math.round(BASE_GENETIC_POPULATION * combinedScale));
    const backtestRefreshEvery = fastMode
        ? Math.max(6, Math.round(BASE_BACKTEST_REFRESH_EVERY + safeDrawCount / 200))
        : Math.max(5, Math.round(BASE_BACKTEST_REFRESH_EVERY + safeDrawCount / 280));
    const historicalEchoMaxDraws = Math.max(180, Math.round(BASE_HISTORICAL_ECHO_MAX_DRAWS * (fastMode ? 0.7 : sizeScale)));
    const historicalEchoMaxWindows = Math.max(28, Math.round(BASE_HISTORICAL_ECHO_MAX_WINDOWS * (fastMode ? 0.6 : sizeScale)));
    const historicalEchoTopMatches = fastMode
        ? Math.max(2, BASE_HISTORICAL_ECHO_TOP_MATCHES - 1)
        : BASE_HISTORICAL_ECHO_TOP_MATCHES;
    return {
        monteCarloMinTrials,
        monteCarloMaxTrials,
        geneticGenerations,
        geneticPopulation,
        backtestRefreshEvery,
        historicalEchoMaxDraws,
        historicalEchoMaxWindows,
        historicalEchoTopMatches,
    };
}
function drawStateSignature(draws) {
    if (draws.length === 0)
        return "0";
    // Use the full chronological draw sequence to avoid cache-key collisions.
    return draws
        .map((draw) => `${draw.date}:${draw.numbers.join("-")}:${draw.bonus}`)
        .join("|");
}
function createDiagnosticsCache(maxEntries = 128) {
    const limit = Math.max(8, maxEntries);
    const store = new Map();
    const order = [];
    const get = (draws) => {
        const key = drawStateSignature(draws);
        const cached = store.get(key);
        if (cached)
            return cached;
        const diagnostics = (0, analysis_1.runFullDiagnostics)(draws);
        store.set(key, diagnostics);
        order.push(key);
        while (order.length > limit) {
            const oldest = order.shift();
            if (!oldest)
                break;
            store.delete(oldest);
        }
        return diagnostics;
    };
    const clear = () => {
        store.clear();
        order.length = 0;
    };
    return { get, clear };
}
function hashStringToSeed(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
function createSeededRandom(seed) {
    let state = seed || 1;
    return () => {
        state += 0x6d2b79f5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function transitionKey(lag, fromNumber) {
    return `${lag}:${fromNumber}`;
}
const LAG1_MIN_SUPPORT = 2;
const LAG1_MAX_CONFIDENCE_TARGETS = 3;
const LAG1_CONFIDENCE_FLOOR = 0.02;
const LAG1_CONFIDENCE_RELATIVE = 0.75;
function buildTransitionLookup(transitions) {
    const transitionByLagFrom = new Map();
    const lag1TransitionByFrom = new Map();
    const lag1HighConfidenceTargetsByFrom = new Map();
    for (const transition of transitions) {
        transitionByLagFrom.set(transitionKey(transition.lag, transition.fromNumber), transition);
        if (transition.lag === 1) {
            lag1TransitionByFrom.set(transition.fromNumber, transition);
            const sortedTargets = [...transition.toNumbers].sort((a, b) => b.probability - a.probability || b.count - a.count);
            const maxProbability = sortedTargets[0]?.probability ?? 0;
            const confidenceThreshold = Math.max(LAG1_CONFIDENCE_FLOOR, maxProbability * LAG1_CONFIDENCE_RELATIVE);
            lag1HighConfidenceTargetsByFrom.set(transition.fromNumber, new Set(sortedTargets
                .filter((to) => to.count >= LAG1_MIN_SUPPORT &&
                to.probability >= confidenceThreshold)
                .slice(0, LAG1_MAX_CONFIDENCE_TARGETS)
                .map((to) => to.number)));
        }
    }
    return {
        transitionByLagFrom,
        lag1TransitionByFrom,
        lag1HighConfidenceTargetsByFrom,
    };
}
function bayesianSmoothed(draws, N, alpha0 = 1, lambda = 0.005) {
    const T = draws.length;
    const weightedCounts = new Array(N + 1).fill(0);
    let totalWeight = 0;
    for (let t = 0; t < T; t++) {
        const w = Math.exp(-lambda * (T - 1 - t));
        if (isNaN(w) || !isFinite(w))
            continue;
        totalWeight += w;
        for (const n of draws[t].numbers) {
            if (n <= N)
                weightedCounts[n] += w;
        }
    }
    const rawCounts = new Array(N + 1).fill(0);
    for (const d of draws)
        for (const n of d.numbers)
            if (n <= N)
                rawCounts[n]++;
    const totalAlpha = N * alpha0;
    const denominator = totalAlpha + totalWeight * analysis_1.K;
    const results = [];
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
exports.WEIGHT_PROFILES = [
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
function deriveAdaptiveSignalScale(diagnostics) {
    const entropy = diagnostics.entropy || {
        normalizedEntropy: 1,
        concentration: 0,
        entropyTrend: 0,
        rollingEntropy: [],
        windowSize: 0,
        regime: "neutral",
    };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const structureStrength = clamp((1 - entropy.normalizedEntropy) * 2.2 +
        entropy.concentration * 0.85 -
        Math.max(0, entropy.entropyTrend) * 1.4, 0, 1);
    const diffuseStrength = clamp((entropy.normalizedEntropy - 0.94) * 3.2 +
        (0.08 - entropy.concentration) * 3.4 +
        Math.max(0, entropy.entropyTrend) * 1.6, 0, 1);
    const scales = {
        bayesian: 1 + diffuseStrength * 0.18 - structureStrength * 0.08,
        hotCold: 1 + structureStrength * 0.22 - diffuseStrength * 0.1,
        gap: 1 + structureStrength * 0.18 - diffuseStrength * 0.06,
        pair: 1 + structureStrength * 0.34 - diffuseStrength * 0.32,
        triple: 1 + structureStrength * 0.38 - diffuseStrength * 0.34,
        positional: 1 + diffuseStrength * 0.08 - structureStrength * 0.05,
        transition: 1 + structureStrength * 0.42 - diffuseStrength * 0.35,
        repeat: 1 + structureStrength * 0.14 - diffuseStrength * 0.08,
    };
    if (entropy.regime === "structured") {
        scales.pair += 0.08;
        scales.triple += 0.1;
        scales.transition += 0.1;
        scales.hotCold += 0.05;
    }
    else if (entropy.regime === "diffuse") {
        scales.bayesian += 0.08;
        scales.positional += 0.04;
        scales.pair -= 0.08;
        scales.triple -= 0.1;
        scales.transition -= 0.1;
    }
    return {
        bayesian: clamp(scales.bayesian, 0.65, 1.4),
        hotCold: clamp(scales.hotCold, 0.7, 1.45),
        gap: clamp(scales.gap, 0.7, 1.35),
        pair: clamp(scales.pair, 0.55, 1.55),
        triple: clamp(scales.triple, 0.5, 1.65),
        positional: clamp(scales.positional, 0.75, 1.25),
        transition: clamp(scales.transition, 0.5, 1.7),
        repeat: clamp(scales.repeat, 0.7, 1.35),
    };
}
function compositeScoring(diagnostics, draws, profile = exports.WEIGHT_PROFILES[0]) {
    const N = diagnostics.poolSize;
    const bayesian = bayesianSmoothed(draws, N);
    const bayesMax = Math.max(...bayesian.map((b) => b.posterior));
    const bayesMin = Math.min(...bayesian.map((b) => b.posterior));
    const bayesianPosteriorByNumber = new Array(N + 1).fill(0);
    for (const b of bayesian) {
        bayesianPosteriorByNumber[b.number] = b.posterior;
    }
    const hcMap = new Map(diagnostics.hotCold.map((h) => [h.number, h]));
    const gapMap = new Map(diagnostics.gaps.map((g) => [g.number, g]));
    const { transitionByLagFrom } = buildTransitionLookup(diagnostics.transitions);
    // PHASE 6: Noise Floor Utility (filter out weak signals) - UPDATED: removed arbitrary threshold
    const filterNoise = (val) => Math.max(0, val);
    // Helper for min-max normalization
    const normalizeValues = (arr) => {
        const min = Math.min(...arr);
        const max = Math.max(...arr);
        if (max === min)
            return arr.map(() => 0.5);
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
        if (!historicalDraw)
            continue;
        const lagNums = [...historicalDraw.numbers, historicalDraw.bonus].filter((n) => n > 0);
        const lagWeight = Math.pow(0.5, lag - 1); // 1.0, 0.5, 0.25, 0.125
        for (const ln of lagNums) {
            const trans = transitionByLagFrom.get(transitionKey(lag, ln));
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
    const scores = [];
    for (let i = 1; i <= N; i++) {
        const posterior = bayesianPosteriorByNumber[i];
        const bayesianScore = bayesMax > bayesMin
            ? (posterior - bayesMin) / (bayesMax - bayesMin)
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
    const signalScale = deriveAdaptiveSignalScale(diagnostics);
    for (const s of scores) {
        s.compositeScore =
            (W.bayesian || 0) * signalScale.bayesian * filterNoise(s.bayesianScore) +
                (W.hotCold || 0) * signalScale.hotCold * filterNoise(s.hotColdScore) +
                (W.gap || 0) * signalScale.gap * filterNoise(s.gapScore) +
                (W.pair || 0) * signalScale.pair * filterNoise(s.pairAffinityScore) +
                (W.triple || 0) * signalScale.triple * filterNoise(s.tripleAffinityScore) +
                (W.positional || 0) * signalScale.positional * s.positionalScore +
                (W.transition || 0) * signalScale.transition * filterNoise(s.transitionScore) +
                (W.repeat || 0) * signalScale.repeat * s.repeatNumberScore;
    }
    scores.sort((a, b) => b.compositeScore - a.compositeScore);
    return scores;
}
function getGroupBreakdown(nums, N) {
    const g = { Low: 0, Medium: 0, MedHigh: 0, High: 0 };
    for (const n of nums)
        g[(0, analysis_1.getGroup)(n, N)]++;
    return `${g.Low}-${g.Medium}-${g.MedHigh}-${g.High}`;
}
function computeGroupBalanceScore(nums, N) {
    const g = { Low: 0, Medium: 0, MedHigh: 0, High: 0 };
    for (const n of nums)
        g[(0, analysis_1.getGroup)(n, N)]++;
    const counts = Object.values(g);
    const ideal = analysis_1.K / 4;
    const deviation = counts.reduce((sum, c) => sum + Math.pow(c - ideal, 2), 0);
    const maxDeviation = analysis_1.K * analysis_1.K;
    return 1 - deviation / maxDeviation;
}
function computeBalancePenalty(nums, N) {
    // 1. Odd/Even Penalty
    const { odd } = (0, analysis_1.getOddEvenSplit)(nums);
    // Penalize 0/6 or 6/0 splits heavily, 1/5 or 5/1 moderately
    let oePenalty = 0;
    if (odd === 0 || odd === 6)
        oePenalty = 1.0;
    else if (odd === 1 || odd === 5)
        oePenalty = 0.5;
    // 2. Sum Penalty
    const sum = (0, analysis_1.getSum)(nums);
    // Expected sum approx K * N / 2. For N=52 -> 156. Range 100-220 is healthy
    const minSum = analysis_1.K * (N / 4); // rough lower bound
    const maxSum = analysis_1.K * (N * 0.75); // rough upper bound
    let sumPenalty = 0;
    if (sum < minSum || sum > maxSum)
        sumPenalty = 1.0;
    // 3. Consecutive Penalty
    const cons = (0, analysis_1.checkConsecutiveness)(nums);
    // More than 2 consecutive pairs (e.g. 1-2-3-4) is very rare
    let consPenalty = 0;
    if (cons > 2)
        consPenalty = 1.0;
    if (cons === 2)
        consPenalty = 0.4;
    return (oePenalty + sumPenalty + consPenalty) / 3;
}
function comboKey(values) {
    return values.join(",");
}
function createScoringLookup(scores, diag) {
    const scoreByNumber = new Map(scores.map((score) => [score.number, score]));
    const transitionScoreByNumber = new Map(scores.map((score) => [score.number, score.transitionScore]));
    const groupPatternPercentageByBreakdown = new Map(diag.groupPatterns.map((pattern) => [pattern.pattern, pattern.percentage]));
    const deltaPercentageByValue = new Map(diag.deltas.map((delta) => [delta.delta, delta.percentage]));
    const tripleWeightByKey = new Map();
    const quadrupleWeightByKey = new Map();
    const quintetWeightByKey = new Map();
    const relationshipNodeSet = new Set();
    for (const t of diag.topTriples) {
        const key = comboKey([t.i, t.j, t.k]);
        tripleWeightByKey.set(key, (tripleWeightByKey.get(key) || 0) + Math.pow(1.5, 1));
        relationshipNodeSet.add(t.i);
        relationshipNodeSet.add(t.j);
        relationshipNodeSet.add(t.k);
    }
    for (const q of diag.topQuadruples) {
        const key = comboKey([q.i, q.j, q.k, q.l]);
        quadrupleWeightByKey.set(key, (quadrupleWeightByKey.get(key) || 0) + Math.pow(1.5, 2));
        relationshipNodeSet.add(q.i);
        relationshipNodeSet.add(q.j);
        relationshipNodeSet.add(q.k);
        relationshipNodeSet.add(q.l);
    }
    if (diag.topQuintets) {
        for (const q of diag.topQuintets) {
            const key = comboKey([q.i, q.j, q.k, q.l, q.m]);
            quintetWeightByKey.set(key, (quintetWeightByKey.get(key) || 0) + Math.pow(1.5, 3));
        }
    }
    return {
        scoreByNumber,
        transitionScoreByNumber,
        groupPatternPercentageByBreakdown,
        deltaPercentageByValue,
        tripleWeightByKey,
        quadrupleWeightByKey,
        quintetWeightByKey,
        relationshipNodeSet,
        ...buildTransitionLookup(diag.transitions),
    };
}
function setScore(nums, scores, N, _diag, lookup = createScoringLookup(scores, _diag)) {
    const sortedNums = [...nums].sort((a, b) => a - b);
    const compositeSum = sortedNums.reduce((sum, n) => sum + (lookup.scoreByNumber.get(n)?.compositeScore || 0), 0);
    const groupBonus = computeGroupBalanceScore(sortedNums, N) * 0.1;
    // Pattern Bonus: favor patterns that appear in history
    const breakdown = getGroupBreakdown(sortedNums, N);
    const patternPct = lookup.groupPatternPercentageByBreakdown.get(breakdown) || 0;
    const patternBonus = (patternPct / 100) * 1.5;
    // Relationship Bonus: use pre-indexed combination lookups.
    let relationshipBonus = 0;
    for (let i = 0; i < sortedNums.length - 2; i++) {
        for (let j = i + 1; j < sortedNums.length - 1; j++) {
            for (let k = j + 1; k < sortedNums.length; k++) {
                relationshipBonus +=
                    lookup.tripleWeightByKey.get(comboKey([sortedNums[i], sortedNums[j], sortedNums[k]])) || 0;
            }
        }
    }
    for (let i = 0; i < sortedNums.length - 3; i++) {
        for (let j = i + 1; j < sortedNums.length - 2; j++) {
            for (let k = j + 1; k < sortedNums.length - 1; k++) {
                for (let l = k + 1; l < sortedNums.length; l++) {
                    relationshipBonus +=
                        lookup.quadrupleWeightByKey.get(comboKey([sortedNums[i], sortedNums[j], sortedNums[k], sortedNums[l]])) || 0;
                }
            }
        }
    }
    if (lookup.quintetWeightByKey.size > 0) {
        for (let i = 0; i < sortedNums.length - 4; i++) {
            for (let j = i + 1; j < sortedNums.length - 3; j++) {
                for (let k = j + 1; k < sortedNums.length - 2; k++) {
                    for (let l = k + 1; l < sortedNums.length - 1; l++) {
                        for (let m = l + 1; m < sortedNums.length; m++) {
                            relationshipBonus +=
                                lookup.quintetWeightByKey.get(comboKey([
                                    sortedNums[i],
                                    sortedNums[j],
                                    sortedNums[k],
                                    sortedNums[l],
                                    sortedNums[m],
                                ])) || 0;
                        }
                    }
                }
            }
        }
    }
    // Transition Bonus (Exponential)
    let transitionBonus = 0;
    for (const n of sortedNums) {
        const transitionScore = lookup.transitionScoreByNumber.get(n) || 0;
        if (transitionScore > 0.4)
            transitionBonus += Math.pow(transitionScore, 2);
    }
    // PHASE 5: Chain Link Bonus (favor sequences that follow a known path)
    let chainBonus = 0;
    // Real implementation: check if any pairs in 'nums' match a transition pair in diag.transitions
    // This is a high-order signal for "3-hit" potential
    for (let i = 0; i < sortedNums.length; i++) {
        for (let j = i + 1; j < sortedNums.length; j++) {
            const a = sortedNums[i];
            const b = sortedNums[j];
            const followers = lookup.lag1HighConfidenceTargetsByFrom.get(a);
            if (followers?.has(b)) {
                chainBonus += 1.5; // Significant boost for a validated sequential link
            }
        }
    }
    // Delta Penalty: discourage sets with deltas that are very rare
    let deltaPenalty = 0;
    for (let i = 0; i < sortedNums.length - 1; i++) {
        const d = sortedNums[i + 1] - sortedNums[i];
        const deltaPct = lookup.deltaPercentageByValue.get(d);
        if (!deltaPct || deltaPct < 1.0)
            deltaPenalty += 0.3;
    }
    // PHASE 7: Match Density Reward (pre-indexed relationship nodes)
    let relationshipNodeCount = 0;
    for (const n of sortedNums) {
        if (lookup.relationshipNodeSet.has(n))
            relationshipNodeCount++;
    }
    // Reward density: if more than 3 numbers are part of validated clusters, it's a high-probability set
    let densityBonus = 0;
    if (relationshipNodeCount >= 3)
        densityBonus += 2.0;
    if (relationshipNodeCount >= 4)
        densityBonus += 3.0;
    if (relationshipNodeCount >= 5)
        densityBonus += 5.0;
    const balancePenalty = computeBalancePenalty(sortedNums, N) * 2.0;
    return (compositeSum +
        groupBonus +
        patternBonus +
        relationshipBonus +
        transitionBonus +
        chainBonus +
        densityBonus -
        balancePenalty -
        deltaPenalty);
}
function generateCandidateSets(scores, diagnostics, draws, numSets = 10, rng = Math.random, options = {}) {
    const N = diagnostics.poolSize;
    const candidates = [];
    const scoringLookup = createScoringLookup(scores, diagnostics);
    const setScoreCache = new Map();
    const fastMode = options.fastMode ?? false;
    const runtimeBudgets = options.runtimeBudgets ||
        calibrateRuntimeBudgets(draws.length, { fastMode });
    const includeMonteCarlo = options.includeMonteCarlo ?? !fastMode;
    const includeGenetic = options.includeGenetic ?? !fastMode;
    const includeSlidingWindow = options.includeSlidingWindow ?? !fastMode;
    const includeHistoricalEcho = options.includeHistoricalEcho ?? !fastMode;
    const addSet = (nums, method) => {
        const sorted = nums.slice(0, analysis_1.K).sort((a, b) => a - b);
        const key = sorted.join(",");
        let totalScore = setScoreCache.get(key);
        if (totalScore === undefined) {
            totalScore = setScore(sorted, scores, N, diagnostics, scoringLookup);
            setScoreCache.set(key, totalScore);
        }
        candidates.push({
            numbers: sorted,
            totalScore,
            groupBreakdown: getGroupBreakdown(sorted, N),
            relativeLift: 0,
            method,
        });
    };
    // 1. Top Composite
    addSet(scores.slice(0, analysis_1.K).map((s) => s.number), "Top Composite");
    // 2. Group Balanced (1 from each group + fill)
    {
        const byGroup = new Map();
        for (const s of scores) {
            const g = (0, analysis_1.getGroup)(s.number, N);
            if (!byGroup.has(g))
                byGroup.set(g, []);
            byGroup.get(g).push(s);
        }
        for (const [, arr] of byGroup)
            arr.sort((a, b) => b.compositeScore - a.compositeScore);
        const balanced = [];
        for (const [, arr] of byGroup) {
            if (arr.length > 0)
                balanced.push(arr[0].number);
        }
        for (const s of scores) {
            if (balanced.length >= analysis_1.K)
                break;
            if (!balanced.includes(s.number))
                balanced.push(s.number);
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
        const result = [];
        for (const n of hotNumbers) {
            if (result.length >= 3)
                break;
            result.push(n);
        }
        for (const n of overdueNumbers) {
            if (result.length >= analysis_1.K)
                break;
            if (!result.includes(n))
                result.push(n);
        }
        for (const s of scores) {
            if (result.length >= analysis_1.K)
                break;
            if (!result.includes(s.number))
                result.push(s.number);
        }
        addSet(result, "Hot + Overdue");
    }
    // 4. Pair Affinity
    {
        const pairSet = [];
        for (const p of diagnostics.topPairs.slice(0, 5)) {
            if (!pairSet.includes(p.i) && pairSet.length < analysis_1.K)
                pairSet.push(p.i);
            if (!pairSet.includes(p.j) && pairSet.length < analysis_1.K)
                pairSet.push(p.j);
        }
        for (const s of scores) {
            if (pairSet.length >= analysis_1.K)
                break;
            if (!pairSet.includes(s.number))
                pairSet.push(s.number);
        }
        addSet(pairSet, "Pair Affinity");
    }
    // 5. Monte Carlo Optimized (20,000 trials + Seeded Sampling)
    if (includeMonteCarlo) {
        const totalComposite = scores.reduce((s, x) => s + x.compositeScore, 0);
        const probDist = totalComposite > 0
            ? scores.map((s) => s.compositeScore / totalComposite)
            : scores.map(() => 1 / Math.max(1, scores.length));
        const maxTrials = Math.min(runtimeBudgets.monteCarloMaxTrials, Math.max(runtimeBudgets.monteCarloMinTrials, draws.length * 25));
        const earlyStopPatience = Math.max(1200, Math.floor(maxTrials * 0.2));
        const minTrialsBeforeEarlyStop = Math.floor(maxTrials * 0.35);
        let bestMC = [];
        let bestMCScore = -Infinity;
        let staleTrials = 0;
        for (let trial = 0; trial < maxTrials; trial++) {
            let set = [];
            const available = scores.map((s, idx) => ({
                number: s.number,
                prob: probDist[idx],
            }));
            // Seeded Sampling: 30% of trials start with a top relationship seed
            if (trial % 3 === 0 && diagnostics.topTriples.length > 0) {
                const seed = diagnostics.topTriples[Math.floor(rng() * Math.min(5, diagnostics.topTriples.length))];
                set = [seed.i, seed.j, seed.k];
                // Remove seeds from available
                [seed.i, seed.j, seed.k].forEach((n) => {
                    const idx = available.findIndex((a) => a.number === n);
                    if (idx !== -1)
                        available.splice(idx, 1);
                });
            }
            while (set.length < analysis_1.K) {
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
            const { odd } = (0, analysis_1.getOddEvenSplit)(set);
            if (odd === 0 || odd === 6)
                continue;
            const setKey = set.join(",");
            let score = setScoreCache.get(setKey);
            if (score === undefined) {
                score = setScore(set, scores, N, diagnostics, scoringLookup);
                setScoreCache.set(setKey, score);
            }
            if (score > bestMCScore) {
                bestMCScore = score;
                bestMC = [...set];
                staleTrials = 0;
            }
            else {
                staleTrials++;
            }
            if (trial >= minTrialsBeforeEarlyStop && staleTrials >= earlyStopPatience) {
                break;
            }
        }
        addSet(bestMC.length === analysis_1.K ? bestMC : scores.slice(0, analysis_1.K).map((s) => s.number), "Monte Carlo Best");
    }
    // 6. Pattern Mimic (Explicitly follows historical spacing/groups)
    {
        const topPattern = diagnostics.groupPatterns[0];
        const topDeltas = diagnostics.deltas.slice(0, 3).map((d) => d.delta);
        if (topPattern) {
            // Try to build a set that matches the top group pattern
            const bits = topPattern.pattern.split("-").map(Number);
            const groups = {
                Low: scores
                    .filter((s) => (0, analysis_1.getGroup)(s.number, N) === "Low")
                    .map((s) => s.number),
                Medium: scores
                    .filter((s) => (0, analysis_1.getGroup)(s.number, N) === "Medium")
                    .map((s) => s.number),
                MedHigh: scores
                    .filter((s) => (0, analysis_1.getGroup)(s.number, N) === "MedHigh")
                    .map((s) => s.number),
                High: scores
                    .filter((s) => (0, analysis_1.getGroup)(s.number, N) === "High")
                    .map((s) => s.number),
            };
            const result = [];
            const keys = ["Low", "Medium", "MedHigh", "High"];
            bits.forEach((count, i) => {
                const groupNums = groups[keys[i]] || [];
                for (let j = 0; j < count; j++) {
                    if (groupNums[j])
                        result.push(groupNums[j]);
                }
            });
            if (result.length === analysis_1.K) {
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
                }
                else {
                    // If no common delta, it might be too sparse, but let's add it anyway if it's the only one
                    // but maybe with a slightly lower score (setScore handles this via deltaPenalty)
                    addSet(result, "Pattern Mimic");
                }
            }
        }
    }
    // 7. Genetic Jackpot Optimizer (Elite evolution)
    if (includeGenetic) {
        const gaResult = runGeneticOptimization(scores, diagnostics, rng, runtimeBudgets.geneticGenerations, runtimeBudgets.geneticPopulation, setScoreCache, scoringLookup);
        addSet(gaResult, "Jackpot Target");
    }
    // 6. Pure Overdue (most overdue by gap ratio)
    {
        const overdueByRatio = diagnostics.gaps
            .filter((g) => g.avgGap > 0)
            .sort((a, b) => b.currentGap / b.avgGap - a.currentGap / a.avgGap)
            .map((g) => g.number);
        addSet(overdueByRatio.slice(0, analysis_1.K), "Most Overdue");
    }
    // 7. Frequency Leaders (all-time most frequent)
    {
        const freqSorted = [...diagnostics.frequency].sort((a, b) => b.count - a.count);
        addSet(freqSorted.slice(0, analysis_1.K).map((f) => f.number), "Frequency Leaders");
    }
    // 9. Markov Flow (Sequential Pathwalking)
    {
        const flowSet = [];
        const lastDraw = draws[draws.length - 1];
        if (lastDraw) {
            const seeds = [...lastDraw.numbers, lastDraw.bonus].filter((n) => n > 0);
            for (const s of seeds) {
                const trans = scoringLookup.lag1TransitionByFrom.get(s);
                if (trans) {
                    for (const to of trans.toNumbers) {
                        if (!flowSet.includes(to.number))
                            flowSet.push(to.number);
                        if (flowSet.length >= analysis_1.K)
                            break;
                    }
                }
                if (flowSet.length >= analysis_1.K)
                    break;
            }
        }
        // Fill if needed
        for (const s of scores) {
            if (flowSet.length >= analysis_1.K)
                break;
            if (!flowSet.includes(s.number))
                flowSet.push(s.number);
        }
        addSet(flowSet, "Markov Flow");
    }
    // 10. Bayesian Top (pure Bayesian posterior)
    {
        // Use scores which already contain Bayesian component — pick top by bayesianScore
        const bayesSorted = [...scores].sort((a, b) => b.bayesianScore - a.bayesianScore);
        addSet(bayesSorted.slice(0, analysis_1.K).map((s) => s.number), "Bayesian Top");
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
        const result = [];
        for (const n of coldNums) {
            if (result.length >= 4)
                break;
            result.push(n);
        }
        for (const n of neutralHigh) {
            if (result.length >= analysis_1.K)
                break;
            if (!result.includes(n))
                result.push(n);
        }
        for (const s of scores) {
            if (result.length >= analysis_1.K)
                break;
            if (!result.includes(s.number))
                result.push(s.number);
        }
        addSet(result, "Cold Reversal");
    }
    // 10. Sliding Window (picks blocks of high-scoring numbers)
    if (includeSlidingWindow) {
        for (let i = 0; i <= scores.length - analysis_1.K; i++) {
            const combo = scores.slice(i, i + analysis_1.K).map((s) => s.number);
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
        const chainSet = new Set();
        // Follow the strongest 2-step chains starting from last draw's numbers
        for (const startNum of lastNums) {
            const step1 = scoringLookup.lag1TransitionByFrom.get(startNum);
            if (step1 && step1.toNumbers.length > 0) {
                const next1 = step1.toNumbers[0].number;
                chainSet.add(next1);
                const step2 = scoringLookup.lag1TransitionByFrom.get(next1);
                if (step2 && step2.toNumbers.length > 0) {
                    chainSet.add(step2.toNumbers[0].number);
                }
            }
        }
        if (chainSet.size >= analysis_1.K) {
            addSet(Array.from(chainSet).slice(0, analysis_1.K), "Chain Master");
        }
    }
    // 10. Weighted Random Ensemble (blend of all strategies)
    {
        // Create a frequency map from all candidates so far
        const numFreq = new Array(N + 1).fill(0);
        for (const c of candidates) {
            for (const n of c.numbers)
                numFreq[n]++;
        }
        // Numbers that appear in most candidate sets are likely good picks
        const rankedByConsensus = Array.from({ length: N }, (_, i) => i + 1)
            .map((n) => ({
            number: n,
            consensus: numFreq[n],
            score: scoringLookup.scoreByNumber.get(n)?.compositeScore || 0,
        }))
            .sort((a, b) => b.consensus * 10 + b.score - (a.consensus * 10 + a.score));
        addSet(rankedByConsensus.slice(0, analysis_1.K).map((r) => r.number), "Consensus Pick");
    }
    // 8. Historical Echo (numbers from eras with similar statistical profiles)
    // Run on full history; internal stride/runtime budgets keep this bounded.
    if (includeHistoricalEcho) {
        const echoes = findHistoricalEchoes(scores, diagnostics, draws, runtimeBudgets, options.diagnosticsCache);
        if (echoes.length >= analysis_1.K) {
            addSet(echoes.slice(0, analysis_1.K), "Historical Echo");
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
    const unique = [];
    const seen = new Set();
    for (const c of candidates) {
        const key = c.numbers.join(",");
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(c);
        }
    }
    return unique.slice(0, numSets);
}
function clampUnit(value) {
    if (Number.isNaN(value) || !Number.isFinite(value))
        return 0;
    if (value < 0)
        return 0;
    if (value > 1)
        return 1;
    return value;
}
function matchUtility(overlap) {
    if (overlap >= 6)
        return overlap + 26;
    if (overlap >= 5)
        return overlap + 11;
    if (overlap >= 4)
        return overlap + 5;
    if (overlap === 3)
        return overlap + 1;
    return overlap;
}
function buildSevenTargetSet(draw) {
    const target = new Set();
    for (const n of draw.numbers) {
        if (n > 0)
            target.add(n);
    }
    if (draw.bonus > 0) {
        target.add(draw.bonus);
    }
    return target;
}
function selectSequenceFocusedTopSet(candidates, scores) {
    const fallback = scores
        .slice(0, analysis_1.K)
        .map((score) => score.number)
        .sort((a, b) => a - b);
    if (candidates.length === 0)
        return fallback;
    const numberWeight = new Map();
    const maxComposite = Math.max(...scores.map((score) => score.compositeScore));
    const minComposite = Math.min(...scores.map((score) => score.compositeScore));
    const scoreRange = Math.max(1e-9, maxComposite - minComposite);
    const candidateLimit = Math.min(10, candidates.length);
    for (let idx = 0; idx < candidateLimit; idx++) {
        const candidate = candidates[idx];
        const rankWeight = 1 / (idx + 1);
        const liftWeight = clampNumber(candidate.relativeLift || 1, 0.35, 1.75);
        const methodBoost = candidate.method.includes("Consensus") || candidate.method.includes("Jackpot")
            ? 1.15
            : 1;
        const candidateWeight = rankWeight * liftWeight * methodBoost;
        for (const n of candidate.numbers) {
            numberWeight.set(n, (numberWeight.get(n) || 0) + candidateWeight);
        }
    }
    for (const score of scores) {
        const compositeNorm = (score.compositeScore - minComposite) / scoreRange;
        const transitionBonus = Math.max(0, score.transitionScore) * 0.35;
        const structureBonus = Math.max(0, score.tripleAffinityScore) * 0.25;
        const priorWeight = compositeNorm * 0.8 + transitionBonus + structureBonus;
        numberWeight.set(score.number, (numberWeight.get(score.number) || 0) + priorWeight);
    }
    const ranked = Array.from(numberWeight.entries())
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .map(([number]) => number);
    const topSet = [];
    for (const number of ranked) {
        if (topSet.length >= analysis_1.K)
            break;
        if (!topSet.includes(number))
            topSet.push(number);
    }
    for (const score of scores) {
        if (topSet.length >= analysis_1.K)
            break;
        if (!topSet.includes(score.number))
            topSet.push(score.number);
    }
    return topSet.slice(0, analysis_1.K).sort((a, b) => a - b);
}
function prependConsensusSet(sets, scores, N, diag) {
    if (sets.length === 0)
        return sets;
    const consensus = selectSequenceFocusedTopSet(sets, scores);
    const consensusKey = consensus.join(",");
    const existing = sets.find((set) => set.numbers.join(",") === consensusKey);
    const ordered = existing
        ? [existing, ...sets.filter((set) => set !== existing)]
        : [
            {
                numbers: consensus,
                // Keep scoring scale consistent with all generated methods.
                totalScore: setScore(consensus, scores, N, diag),
                groupBreakdown: getGroupBreakdown(consensus, N),
                relativeLift: 0,
                method: "Sequence Consensus",
            },
            ...sets,
        ].slice(0, sets.length);
    const ranked = [...ordered].sort((a, b) => b.totalScore - a.totalScore);
    const bestScore = Math.max(...ranked.map((set) => set.totalScore), 1e-9);
    return ranked.map((set) => ({
        ...set,
        relativeLift: bestScore > 0 ? set.totalScore / bestScore : 1,
    }));
}
function backtest(draws, N, trainRatio = 0.8, // Updated to 80/20 as requested
onProgress, runtimeBudgets = calibrateRuntimeBudgets(draws.length, {
    fastMode: true,
}), diagnosticsCache = createDiagnosticsCache(192), seedSalt = "", settings = {}, onTrace) {
    const emitProgress = (progress, stage) => {
        if (!onProgress)
            return;
        onProgress(clampUnit(progress), stage);
    };
    const masteryBacktestMode = settings.masteryBacktestMode === true;
    const masteryTargetMatch = Math.round(clampNumber(settings.targetSequenceMatch ?? 6, 1, 6));
    const masteryMaxAttemptsPerSequenceRaw = settings.masteryMaxAttemptsPerSequence;
    const masteryMaxAttemptsPerSequence = masteryMaxAttemptsPerSequenceRaw !== undefined &&
        masteryMaxAttemptsPerSequenceRaw > 0
        ? Math.round(clampNumber(masteryMaxAttemptsPerSequenceRaw, 1, 2000))
        : Number.POSITIVE_INFINITY;
    const masteryGlobalAttemptCapRaw = settings.masteryGlobalAttemptCap;
    const masteryGlobalAttemptCap = masteryGlobalAttemptCapRaw !== undefined && masteryGlobalAttemptCapRaw > 0
        ? Math.round(clampNumber(masteryGlobalAttemptCapRaw, 1, 1_000_000))
        : Number.POSITIVE_INFINITY;
    const masteryProgressEveryAttempts = Math.max(1, Math.round(clampNumber(settings.masteryProgressEveryAttempts ?? 8, 1, 1000)));
    const masteryMaxAttemptsPerSequenceEffective = Number.isFinite(masteryMaxAttemptsPerSequence)
        ? masteryMaxAttemptsPerSequence
        : 5000;
    const masteryGlobalAttemptCapEffective = Number.isFinite(masteryGlobalAttemptCap)
        ? masteryGlobalAttemptCap
        : 250000;
    const warmStartEnabled = settings.warmStartEnabled === true;
    const warmStartProfile = warmStartEnabled && settings.warmStartProfile
        ? sanitizeWeightProfile(settings.warmStartProfile, exports.WEIGHT_PROFILES[0])
        : null;
    const warmProfileOverlaps = settings.warmProfileOverlaps || {};
    emitProgress(0.02, "Initializing backtest");
    if (draws.length < 2) {
        const diagnostics = diagnosticsCache.get(draws);
        emitProgress(1, "Backtest complete");
        return {
            mode: masteryBacktestMode ? "mastery" : "standard",
            trainSize: draws.length,
            testSize: 0,
            modelHits: 0,
            baselineHitRate: (analysis_1.K + 1) / N,
            modelHitRate: 0,
            improvement: 0,
            top6Overlap: 0,
            rowDetails: [],
            profilePerformance: exports.WEIGHT_PROFILES.map((p) => ({
                name: p.name,
                overlap: clampNumber(Number(warmProfileOverlaps[p.name] || 0), 0, 2000),
            })),
            finalDiagnostics: diagnostics,
            finalBestProfile: warmStartProfile || exports.WEIGHT_PROFILES[0],
            learningTrend: 0,
            earlyMatches: 0,
            recentMatches: 0,
            fourPlusHits: 0,
            fourPlusRate: 0,
            maxObservedOverlap: 0,
            sixMatchHits: 0,
            sixMatchRate: 0,
            warmStartApplied: warmStartProfile !== null,
            warmStartProfileName: warmStartProfile?.name,
            forwardOnlyModelHits: masteryBacktestMode ? 0 : undefined,
            forwardOnlyModelHitRate: masteryBacktestMode ? 0 : undefined,
            forwardOnlyTop6Overlap: masteryBacktestMode ? 0 : undefined,
            forwardOnlyFourPlusHits: masteryBacktestMode ? 0 : undefined,
            forwardOnlyFourPlusRate: masteryBacktestMode ? 0 : undefined,
            forwardOnlySixMatchHits: masteryBacktestMode ? 0 : undefined,
            forwardOnlySixMatchRate: masteryBacktestMode ? 0 : undefined,
            masteryTargetMatch: masteryBacktestMode ? masteryTargetMatch : undefined,
            masteryTotalAttempts: masteryBacktestMode ? 0 : undefined,
            masterySolvedSequences: masteryBacktestMode ? 0 : undefined,
            masteryUnresolvedSequences: masteryBacktestMode ? 0 : undefined,
            masteryFirstAttemptSolved: masteryBacktestMode ? 0 : undefined,
            masteryAverageAttempts: masteryBacktestMode ? 0 : undefined,
            masteryGlobalCapReached: masteryBacktestMode ? false : undefined,
        };
    }
    const splitIdx = Math.floor(draws.length * trainRatio);
    const trainDraws = draws.slice(0, splitIdx);
    const testDraws = draws.slice(splitIdx);
    const fastCandidateOptions = {
        fastMode: true,
        includeMonteCarlo: false,
        includeGenetic: false,
        includeSlidingWindow: false,
        includeHistoricalEcho: false,
        runtimeBudgets,
        diagnosticsCache,
    };
    const masteryCandidateBaseOptions = {
        fastMode: settings.fastMode ?? false,
        includeMonteCarlo: settings.includeMonteCarlo ?? true,
        includeGenetic: settings.includeGenetic ?? true,
        includeSlidingWindow: settings.includeSlidingWindow ?? true,
        includeHistoricalEcho: settings.includeHistoricalEcho ?? true,
        runtimeBudgets,
        diagnosticsCache,
    };
    const buildMasteryBudgets = (attempt) => {
        const boostStage = Math.min(10, Math.floor(Math.max(0, attempt - 1) / 6));
        return {
            ...runtimeBudgets,
            monteCarloMinTrials: Math.round(clampNumber(runtimeBudgets.monteCarloMinTrials + boostStage * 350, 100, 120_000)),
            monteCarloMaxTrials: Math.round(clampNumber(runtimeBudgets.monteCarloMaxTrials + boostStage * 1400, 500, 200_000)),
            geneticGenerations: Math.round(clampNumber(runtimeBudgets.geneticGenerations + boostStage * 3, 5, 320)),
            geneticPopulation: Math.round(clampNumber(runtimeBudgets.geneticPopulation + boostStage * 10, 20, 1500)),
            backtestRefreshEvery: runtimeBudgets.backtestRefreshEvery,
            historicalEchoMaxDraws: runtimeBudgets.historicalEchoMaxDraws,
            historicalEchoMaxWindows: runtimeBudgets.historicalEchoMaxWindows,
            historicalEchoTopMatches: runtimeBudgets.historicalEchoTopMatches,
        };
    };
    // Initial training: find best starting profile
    emitProgress(0.08, "Building initial diagnostics");
    let currentDiagnostics = diagnosticsCache.get(trainDraws);
    let bestProfile = warmStartProfile || exports.WEIGHT_PROFILES[0];
    let bestProfileOverlap = -1;
    const profilePerformance = exports.WEIGHT_PROFILES.map((p) => ({
        name: p.name,
        overlap: clampNumber(Number(warmProfileOverlaps[p.name] || 0), 0, 2000),
        rollingHistory: [],
    }));
    // Initial profile sweep on training data (last 50 draws of training)
    const valWindow = 50;
    const valStart = Math.max(0, trainDraws.length - valWindow);
    const valTrain = trainDraws.slice(0, valStart);
    const valTest = trainDraws.slice(valStart);
    if (valTrain.length > 50) {
        for (let profileIdx = 0; profileIdx < exports.WEIGHT_PROFILES.length; profileIdx++) {
            const profile = exports.WEIGHT_PROFILES[profileIdx];
            const profileValHistory = [...valTrain];
            let profileValDiagnostics = diagnosticsCache.get(profileValHistory);
            let o = 0;
            for (let valIdx = 0; valIdx < valTest.length; valIdx++) {
                const d = valTest[valIdx];
                const s = compositeScoring(profileValDiagnostics, profileValHistory, profile);
                const seededValRng = createSeededRandom(hashStringToSeed(`val:${profile.name}:${profileValHistory.length}:${d.date}:${seedSalt}`));
                const valCandidates = generateCandidateSets(s, profileValDiagnostics, profileValHistory, 12, seededValRng, fastCandidateOptions);
                const valSet = selectSequenceFocusedTopSet(valCandidates, s);
                const t6 = new Set(valSet);
                const targetSet = buildSevenTargetSet(d);
                const overlap = Array.from(t6).filter((n) => targetSet.has(n)).length;
                o += matchUtility(overlap);
                profileValHistory.push(d);
                const shouldRefresh = valIdx === valTest.length - 1 ||
                    (valIdx + 1) % runtimeBudgets.backtestRefreshEvery === 0;
                if (shouldRefresh) {
                    profileValDiagnostics = diagnosticsCache.get(profileValHistory);
                }
            }
            if (o > bestProfileOverlap) {
                bestProfileOverlap = o;
                bestProfile = profile;
            }
            emitProgress(0.12 + ((profileIdx + 1) / exports.WEIGHT_PROFILES.length) * 0.08, `Validating profile ${profileIdx + 1}/${exports.WEIGHT_PROFILES.length}`);
        }
        if (warmStartProfile) {
            bestProfile = blendWeightProfiles("Warm Hybrid", warmStartProfile, bestProfile, 0.65);
        }
    }
    else {
        emitProgress(0.2, "Validation skipped (insufficient train window)");
    }
    let hits = 0;
    let fourPlusHits = 0;
    let sixMatchHits = 0;
    let top6TotalOverlap = 0;
    let forwardOnlyHits = 0;
    let forwardOnlyFourPlusHits = 0;
    let forwardOnlySixMatchHits = 0;
    let forwardOnlyTop6TotalOverlap = 0;
    const rowDetails = [];
    let masteryTotalAttempts = 0;
    let masterySolvedSequences = 0;
    let masteryFirstAttemptSolved = 0;
    let masteryGlobalCapReached = false;
    // Iterative Learning Loop: for each test draw, predict -> validate -> learn
    const history = [...trainDraws];
    const rollingWindow = 50;
    const progressInterval = Math.max(1, Math.floor(testDraws.length / 40));
    for (let testIdx = 0; testIdx < testDraws.length; testIdx++) {
        if (masteryBacktestMode &&
            masteryTotalAttempts >= masteryGlobalAttemptCapEffective) {
            masteryGlobalCapReached = true;
            emitProgress(0.97, `Mastery attempt cap reached at sequence ${testIdx}/${testDraws.length}`);
            break;
        }
        const testDraw = testDraws[testIdx];
        const actualMain = [...testDraw.numbers].filter((n) => n > 0);
        const actualTargetSet = buildSevenTargetSet(testDraw);
        let selectedTop6 = [];
        let t6Overlap = 0;
        let firstAttemptTop6 = undefined;
        let firstAttemptOverlap = undefined;
        let attemptsUsed = 1;
        let mastered = false;
        if (masteryBacktestMode) {
            let sequenceBestSet = [];
            let sequenceBestOverlap = -1;
            let sequenceBestProfile = null;
            let sequenceAttempts = 0;
            let previousAttemptKey = "";
            let stagnantAttempts = 0;
            const numberMomentum = new Array(N + 1).fill(0);
            const rankedProfiles = [...profilePerformance]
                .sort((a, b) => b.overlap - a.overlap)
                .slice(0, 4)
                .map((entry) => entry.name);
            while (sequenceBestOverlap < masteryTargetMatch &&
                sequenceAttempts < masteryMaxAttemptsPerSequenceEffective &&
                masteryTotalAttempts < masteryGlobalAttemptCapEffective) {
                const profileName = rankedProfiles[sequenceAttempts % Math.max(1, rankedProfiles.length)];
                const tunedProfile = exports.WEIGHT_PROFILES.find((profile) => profile.name === profileName) ||
                    bestProfile;
                const attemptSeed = `mastery:${testDraw.date}:${history.length}:${sequenceAttempts}:${seedSalt}`;
                const attemptRng = createSeededRandom(hashStringToSeed(attemptSeed));
                let attemptSet = [];
                let attemptOverlap = -1;
                const baseAttemptScores = compositeScoring(currentDiagnostics, history, tunedProfile);
                const jitterAmplitude = Math.max(0.02, 0.12 - Math.min(0.08, sequenceAttempts * 0.003));
                const adjustedScores = baseAttemptScores
                    .map((score) => ({
                    ...score,
                    compositeScore: score.compositeScore +
                        numberMomentum[score.number] +
                        (attemptRng() - 0.5) * jitterAmplitude,
                }))
                    .sort((a, b) => b.compositeScore - a.compositeScore);
                const attemptBudgets = buildMasteryBudgets(sequenceAttempts + 1);
                const candidateCount = Math.min(24, 16 +
                    Math.floor(sequenceAttempts / 8) * 2 +
                    Math.min(4, stagnantAttempts));
                const attemptCandidates = generateCandidateSets(adjustedScores, currentDiagnostics, history, candidateCount, attemptRng, {
                    ...masteryCandidateBaseOptions,
                    runtimeBudgets: attemptBudgets,
                });
                const momentumSet = adjustedScores
                    .slice(0, analysis_1.K)
                    .map((score) => score.number)
                    .sort((a, b) => a - b);
                const consensusSet = selectSequenceFocusedTopSet(attemptCandidates, adjustedScores);
                const candidateSetPool = [
                    consensusSet,
                    momentumSet,
                    ...attemptCandidates
                        .slice(0, Math.min(candidateCount, 18))
                        .map((candidate) => candidate.numbers),
                ];
                const uniqueCandidateSets = [];
                const seenCandidateKeys = new Set();
                for (const candidateSet of candidateSetPool) {
                    const normalized = [...candidateSet].sort((a, b) => a - b);
                    const key = normalized.join(",");
                    if (seenCandidateKeys.has(key))
                        continue;
                    seenCandidateKeys.add(key);
                    uniqueCandidateSets.push(normalized);
                }
                const selectionIndex = uniqueCandidateSets.length <= 1
                    ? 0
                    : sequenceAttempts === 0
                        ? 0
                        : Math.floor(attemptRng() * uniqueCandidateSets.length);
                attemptSet =
                    uniqueCandidateSets[selectionIndex] ||
                        [...consensusSet].sort((a, b) => a - b);
                attemptOverlap = attemptSet.filter((n) => actualTargetSet.has(n)).length;
                sequenceAttempts++;
                masteryTotalAttempts++;
                if (sequenceAttempts === 1) {
                    firstAttemptTop6 = [...attemptSet];
                    firstAttemptOverlap = attemptOverlap;
                }
                const attemptKey = attemptSet.join(",");
                if (attemptKey === previousAttemptKey) {
                    stagnantAttempts++;
                }
                else {
                    stagnantAttempts = 0;
                    previousAttemptKey = attemptKey;
                }
                // Forward-only momentum update: reinforce numbers selected by the model.
                for (let number = 1; number <= N; number++) {
                    numberMomentum[number] *= 0.93;
                }
                const scoreByNumber = new Map(adjustedScores.map((score) => [score.number, score.compositeScore]));
                for (const number of attemptSet) {
                    const modelScore = scoreByNumber.get(number) || 0;
                    numberMomentum[number] += 0.12 + Math.max(0, Math.min(0.24, modelScore * 0.09));
                }
                if (stagnantAttempts >= 2) {
                    for (let number = 1; number <= N; number++) {
                        numberMomentum[number] += (attemptRng() - 0.5) * 0.12;
                    }
                }
                if (attemptOverlap > sequenceBestOverlap) {
                    sequenceBestOverlap = attemptOverlap;
                    sequenceBestSet = [...attemptSet];
                    sequenceBestProfile = tunedProfile;
                }
                const shouldReportAttemptProgress = sequenceAttempts === 1 ||
                    sequenceAttempts % masteryProgressEveryAttempts === 0 ||
                    attemptOverlap >= masteryTargetMatch ||
                    masteryTotalAttempts >= masteryGlobalAttemptCapEffective ||
                    sequenceAttempts >= masteryMaxAttemptsPerSequenceEffective;
                if (shouldReportAttemptProgress) {
                    onTrace?.({
                        phase: "mastery_attempt",
                        sequenceIndex: testIdx + 1,
                        sequenceTotal: testDraws.length,
                        date: testDraw.date,
                        actual: [...actualMain].sort((a, b) => a - b),
                        bonus: testDraw.bonus,
                        predicted: [...attemptSet].sort((a, b) => a - b),
                        overlap: attemptOverlap,
                        bestOverlap: Math.max(0, sequenceBestOverlap),
                        attemptsUsed: sequenceAttempts,
                        attemptCap: Number.isFinite(masteryMaxAttemptsPerSequence)
                            ? masteryMaxAttemptsPerSequenceEffective
                            : null,
                        profileName: tunedProfile.name,
                    });
                    const withinSequenceProgress = Number.isFinite(masteryMaxAttemptsPerSequence)
                        ? Math.min(1, sequenceAttempts /
                            Math.max(1, masteryMaxAttemptsPerSequenceEffective))
                        : Math.min(0.98, sequenceAttempts / 25);
                    const loopProgress = testDraws.length > 0
                        ? (testIdx + withinSequenceProgress) / testDraws.length
                        : 1;
                    emitProgress(0.2 + loopProgress * 0.75, `Mastery sequence ${testIdx + 1}/${testDraws.length} | attempt ${sequenceAttempts}${Number.isFinite(masteryMaxAttemptsPerSequence) ? `/${masteryMaxAttemptsPerSequenceEffective}` : ""} | best ${Math.max(0, sequenceBestOverlap)}/6`);
                }
            }
            attemptsUsed = sequenceAttempts;
            selectedTop6 = sequenceBestSet;
            t6Overlap = Math.max(0, sequenceBestOverlap);
            mastered = t6Overlap >= masteryTargetMatch;
            if (mastered)
                masterySolvedSequences++;
            if (mastered && sequenceAttempts === 1)
                masteryFirstAttemptSolved++;
            if (sequenceBestProfile) {
                bestProfile = sequenceBestProfile;
            }
            if (masteryTotalAttempts >= masteryGlobalAttemptCapEffective) {
                masteryGlobalCapReached = true;
            }
            if (selectedTop6.length === 0) {
                const fallbackScores = compositeScoring(currentDiagnostics, history, bestProfile);
                selectedTop6 = fallbackScores
                    .slice(0, analysis_1.K)
                    .map((score) => score.number)
                    .sort((a, b) => a - b);
                t6Overlap = selectedTop6.filter((n) => actualTargetSet.has(n)).length;
            }
            if (!firstAttemptTop6) {
                firstAttemptTop6 = [...selectedTop6];
                firstAttemptOverlap = t6Overlap;
            }
        }
        else {
            // 1. Predict using current best profile and latest diagnostics
            const currentScores = compositeScoring(currentDiagnostics, history, bestProfile);
            const drawSeed = `${testDraw.date}:${history.length}:${bestProfile.name}:${seedSalt}`;
            const drawRng = createSeededRandom(hashStringToSeed(drawSeed));
            const bestCandidates = generateCandidateSets(currentScores, currentDiagnostics, history, 12, drawRng, fastCandidateOptions);
            selectedTop6 = selectSequenceFocusedTopSet(bestCandidates, currentScores);
            t6Overlap = selectedTop6.filter((n) => actualTargetSet.has(n)).length;
        }
        const top6 = new Set(selectedTop6);
        if (t6Overlap > 0)
            hits++;
        if (t6Overlap >= 4)
            fourPlusHits++;
        if (t6Overlap >= 6)
            sixMatchHits++;
        top6TotalOverlap += t6Overlap;
        if (masteryBacktestMode) {
            const firstOverlap = firstAttemptOverlap ?? t6Overlap;
            forwardOnlyTop6TotalOverlap += firstOverlap;
            if (firstOverlap > 0)
                forwardOnlyHits++;
            if (firstOverlap >= 4)
                forwardOnlyFourPlusHits++;
            if (firstOverlap >= 6)
                forwardOnlySixMatchHits++;
        }
        rowDetails.push({
            date: testDraw.date,
            actual: actualMain.sort((a, b) => a - b),
            bonus: testDraw.bonus,
            predictedTop6: Array.from(top6).sort((a, b) => a - b),
            overlap: t6Overlap,
            firstAttemptTop6: masteryBacktestMode
                ? [...(firstAttemptTop6 || selectedTop6)].sort((a, b) => a - b)
                : undefined,
            firstAttemptOverlap: masteryBacktestMode
                ? (firstAttemptOverlap ?? t6Overlap)
                : undefined,
            attemptsUsed: masteryBacktestMode ? attemptsUsed : undefined,
            mastered: masteryBacktestMode ? mastered : undefined,
        });
        onTrace?.({
            phase: "backtest_row",
            sequenceIndex: testIdx + 1,
            sequenceTotal: testDraws.length,
            date: testDraw.date,
            actual: [...actualMain].sort((a, b) => a - b),
            bonus: testDraw.bonus,
            predicted: [...selectedTop6].sort((a, b) => a - b),
            overlap: t6Overlap,
            bestOverlap: masteryBacktestMode ? Math.max(0, t6Overlap) : undefined,
            attemptsUsed: masteryBacktestMode ? attemptsUsed : undefined,
            attemptCap: masteryBacktestMode
                ? Number.isFinite(masteryMaxAttemptsPerSequence)
                    ? masteryMaxAttemptsPerSequenceEffective
                    : null
                : undefined,
        });
        // 3. Reinforcement update without leakage:
        // evaluate profile predictions built from pre-outcome history only.
        exports.WEIGHT_PROFILES.forEach((p, idx) => {
            const ps = compositeScoring(currentDiagnostics, history, p);
            const profileSeed = `${testDraw.date}:${history.length}:${p.name}:${seedSalt}`;
            const profileRng = createSeededRandom(hashStringToSeed(profileSeed));
            const profileCandidates = generateCandidateSets(ps, currentDiagnostics, history, 12, profileRng, fastCandidateOptions);
            const profileSet = selectSequenceFocusedTopSet(profileCandidates, ps);
            const pt6 = new Set(profileSet);
            const po = Array.from(pt6).filter((n) => actualTargetSet.has(n)).length;
            // Update rolling overlap (we store per-draw result and sum the last 50)
            const rh = profilePerformance[idx].rollingHistory;
            rh.push(matchUtility(po));
            if (rh.length > rollingWindow)
                rh.shift();
            profilePerformance[idx].overlap = rh.reduce((a, b) => a + b, 0);
        });
        // 4. "Learn" - Update history and diagnostics for the NEXT prediction
        history.push(testDraw);
        const shouldRefreshDiagnostics = testIdx === testDraws.length - 1 ||
            (testIdx + 1) % runtimeBudgets.backtestRefreshEvery === 0;
        if (shouldRefreshDiagnostics) {
            currentDiagnostics = diagnosticsCache.get(history);
        }
        // Strategy: Every 5 draws, compute a NEURAL ENSEMBLE profile (Phase 7)
        // We blend all profiles based on their rolling overlap squared (to favor experts)
        if (history.length % 5 === 0) {
            const totalPower = profilePerformance.reduce((acc, p) => acc + Math.pow(p.overlap, 2), 0) || 1;
            const ensembleProfile = {
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
            exports.WEIGHT_PROFILES.forEach((p, idx) => {
                const profileWeight = Math.pow(profilePerformance[idx].overlap, 2) / totalPower;
                ensembleProfile.bayesian += (p.bayesian || 0) * profileWeight;
                ensembleProfile.hotCold += (p.hotCold || 0) * profileWeight;
                ensembleProfile.gap += (p.gap || 0) * profileWeight;
                ensembleProfile.pair += (p.pair || 0) * profileWeight;
                ensembleProfile.triple += (p.triple || 0) * profileWeight;
                ensembleProfile.positional += (p.positional || 0) * profileWeight;
                ensembleProfile.transition += (p.transition || 0) * profileWeight;
                ensembleProfile.repeat += (p.repeat || 0) * profileWeight;
            });
            bestProfile = ensembleProfile;
        }
        if (testIdx === testDraws.length - 1 ||
            (testIdx + 1) % progressInterval === 0) {
            const loopProgress = testDraws.length > 0 ? (testIdx + 1) / testDraws.length : 1;
            emitProgress(0.2 + loopProgress * 0.75, masteryBacktestMode
                ? `Mastery sequence ${testIdx + 1}/${testDraws.length} | solved ${masterySolvedSequences}`
                : `Backtesting draw ${testIdx + 1}/${testDraws.length}`);
        }
    }
    const processedTestSize = rowDetails.length;
    const avgTop6Overlap = processedTestSize > 0 ? top6TotalOverlap / processedTestSize : 0;
    const forwardOnlyAvgTop6Overlap = processedTestSize > 0 ? forwardOnlyTop6TotalOverlap / processedTestSize : 0;
    const modelHitRate = avgTop6Overlap / analysis_1.K; // Hits per prediction slot
    const forwardOnlyModelHitRate = forwardOnlyAvgTop6Overlap / analysis_1.K;
    const baselinePercentage = (analysis_1.K + 1) / N; // Random baseline against a 7-ball target
    const result = {
        mode: masteryBacktestMode ? "mastery" : "standard",
        trainSize: trainDraws.length,
        testSize: processedTestSize,
        modelHits: hits,
        baselineHitRate: baselinePercentage,
        modelHitRate: modelHitRate,
        improvement: baselinePercentage > 0
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
        fourPlusRate: processedTestSize > 0 ? fourPlusHits / processedTestSize : 0,
        maxObservedOverlap: 0,
        sixMatchHits,
        sixMatchRate: processedTestSize > 0 ? sixMatchHits / processedTestSize : 0,
        warmStartApplied: warmStartProfile !== null,
        warmStartProfileName: warmStartProfile?.name,
        forwardOnlyModelHits: masteryBacktestMode ? forwardOnlyHits : undefined,
        forwardOnlyModelHitRate: masteryBacktestMode
            ? forwardOnlyModelHitRate
            : undefined,
        forwardOnlyTop6Overlap: masteryBacktestMode
            ? forwardOnlyAvgTop6Overlap
            : undefined,
        forwardOnlyFourPlusHits: masteryBacktestMode
            ? forwardOnlyFourPlusHits
            : undefined,
        forwardOnlyFourPlusRate: masteryBacktestMode
            ? processedTestSize > 0
                ? forwardOnlyFourPlusHits / processedTestSize
                : 0
            : undefined,
        forwardOnlySixMatchHits: masteryBacktestMode
            ? forwardOnlySixMatchHits
            : undefined,
        forwardOnlySixMatchRate: masteryBacktestMode
            ? processedTestSize > 0
                ? forwardOnlySixMatchHits / processedTestSize
                : 0
            : undefined,
        masteryTargetMatch: masteryBacktestMode ? masteryTargetMatch : undefined,
        masteryTotalAttempts: masteryBacktestMode ? masteryTotalAttempts : undefined,
        masterySolvedSequences: masteryBacktestMode ? masterySolvedSequences : undefined,
        masteryUnresolvedSequences: masteryBacktestMode
            ? Math.max(0, processedTestSize - masterySolvedSequences)
            : undefined,
        masteryFirstAttemptSolved: masteryBacktestMode
            ? masteryFirstAttemptSolved
            : undefined,
        masteryAverageAttempts: masteryBacktestMode
            ? processedTestSize > 0
                ? masteryTotalAttempts / processedTestSize
                : 0
            : undefined,
        masteryGlobalCapReached: masteryBacktestMode
            ? masteryGlobalCapReached
            : undefined,
    };
    // PHASE 6: Calculate Learning Trend (Recent 50 vs First 50 test rows)
    emitProgress(0.97, "Computing backtest metrics");
    const windowSize = 50;
    if (rowDetails.length >= windowSize * 2) {
        const earlyRows = rowDetails.slice(0, windowSize);
        const recentRows = rowDetails.slice(-windowSize);
        const earlyAvg = earlyRows.reduce((s, r) => s + r.overlap, 0) / windowSize;
        const recentAvg = recentRows.reduce((s, r) => s + r.overlap, 0) / windowSize;
        result.earlyMatches = earlyAvg;
        result.recentMatches = recentAvg;
        result.learningTrend =
            earlyAvg > 0 ? ((recentAvg - earlyAvg) / earlyAvg) * 100 : 0;
    }
    result.maxObservedOverlap = rowDetails.reduce((maxVal, row) => Math.max(maxVal, row.overlap), 0);
    emitProgress(1, "Backtest complete");
    return result;
}
function clampNumber(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    if (value < min)
        return min;
    if (value > max)
        return max;
    return value;
}
function sanitizeWeightProfile(raw, fallback, defaultName = "Warm Start") {
    if (!raw)
        return { ...fallback };
    const keys = [
        "bayesian",
        "hotCold",
        "gap",
        "pair",
        "triple",
        "positional",
        "transition",
        "repeat",
    ];
    const values = keys.map((key) => clampNumber(Number(raw[key] || 0), 0, 1.5));
    const sum = values.reduce((acc, value) => acc + value, 0);
    if (sum <= 0)
        return { ...fallback };
    const normalized = values.map((value) => value / sum);
    const name = typeof raw.name === "string" && raw.name.trim().length > 0
        ? raw.name
        : defaultName;
    return {
        name,
        bayesian: normalized[0],
        hotCold: normalized[1],
        gap: normalized[2],
        pair: normalized[3],
        triple: normalized[4],
        positional: normalized[5],
        transition: normalized[6],
        repeat: normalized[7],
    };
}
function blendWeightProfiles(name, primary, secondary, primaryWeight) {
    const wPrimary = clampNumber(primaryWeight, 0, 1);
    const wSecondary = 1 - wPrimary;
    return sanitizeWeightProfile({
        name,
        bayesian: primary.bayesian * wPrimary + secondary.bayesian * wSecondary,
        hotCold: primary.hotCold * wPrimary + secondary.hotCold * wSecondary,
        gap: primary.gap * wPrimary + secondary.gap * wSecondary,
        pair: primary.pair * wPrimary + secondary.pair * wSecondary,
        triple: primary.triple * wPrimary + secondary.triple * wSecondary,
        positional: primary.positional * wPrimary + secondary.positional * wSecondary,
        transition: primary.transition * wPrimary + secondary.transition * wSecondary,
        repeat: primary.repeat * wPrimary + secondary.repeat * wSecondary,
    }, secondary, name);
}
function applyModelSettingsToBudgets(budgets, settings) {
    const tuned = { ...budgets };
    if (settings.monteCarloMinTrials !== undefined) {
        tuned.monteCarloMinTrials = Math.round(clampNumber(settings.monteCarloMinTrials, 100, 100000));
    }
    if (settings.monteCarloMaxTrials !== undefined) {
        tuned.monteCarloMaxTrials = Math.round(clampNumber(settings.monteCarloMaxTrials, 500, 200000));
    }
    if (tuned.monteCarloMaxTrials < tuned.monteCarloMinTrials) {
        tuned.monteCarloMaxTrials = tuned.monteCarloMinTrials;
    }
    if (settings.geneticGenerations !== undefined) {
        tuned.geneticGenerations = Math.round(clampNumber(settings.geneticGenerations, 5, 250));
    }
    if (settings.geneticPopulation !== undefined) {
        tuned.geneticPopulation = Math.round(clampNumber(settings.geneticPopulation, 20, 1000));
    }
    if (settings.backtestRefreshEvery !== undefined) {
        tuned.backtestRefreshEvery = Math.round(clampNumber(settings.backtestRefreshEvery, 2, 40));
    }
    return tuned;
}
function blendCompositeScores(diagnostics, draws, weightedProfiles, onProfileScored) {
    if (weightedProfiles.length === 0) {
        return compositeScoring(diagnostics, draws, exports.WEIGHT_PROFILES[0]);
    }
    const snapshots = [];
    for (let i = 0; i < weightedProfiles.length; i++) {
        const entry = weightedProfiles[i];
        snapshots.push({
            weight: Math.max(0.0001, entry.weight),
            scores: compositeScoring(diagnostics, draws, entry.profile),
        });
        onProfileScored?.(i, weightedProfiles.length);
    }
    const template = snapshots[0].scores.map((score) => ({ ...score, compositeScore: 0 }));
    const templateByNumber = new Map(template.map((score) => [score.number, score]));
    const totalWeight = snapshots.reduce((sum, snapshot) => sum + snapshot.weight, 0) || 1;
    for (const snapshot of snapshots) {
        for (const score of snapshot.scores) {
            const target = templateByNumber.get(score.number);
            if (!target)
                continue;
            target.compositeScore += score.compositeScore * snapshot.weight;
        }
    }
    for (const score of template) {
        score.compositeScore /= totalWeight;
    }
    template.sort((a, b) => b.compositeScore - a.compositeScore);
    return template;
}
function buildFinalPredictionArtifacts(options) {
    const emitProgress = (progress, stage) => {
        options.onProgress?.(clampUnit(progress), stage);
    };
    emitProgress(0.05, "Selecting optimized profile");
    const seedBase = options.draws
        .slice(-50)
        .map((d) => `${d.date}:${d.numbers.join("-")}:${d.bonus}`)
        .join(options.refreshMode
        ? `|refresh:${Date.now()}|salt:${options.seedSalt}|`
        : `|salt:${options.seedSalt}|`);
    const rng = createSeededRandom(hashStringToSeed(seedBase));
    const learnedProfile = options.backtest.finalBestProfile;
    const learnedDiagnostics = options.backtest.finalDiagnostics;
    const profileByName = new Map(exports.WEIGHT_PROFILES.map((profile) => [profile.name, profile]));
    const weightedProfileMap = new Map();
    const addWeightedProfile = (profile, weight) => {
        const key = profile.name;
        const existing = weightedProfileMap.get(key);
        if (existing) {
            existing.weight += weight;
            return;
        }
        weightedProfileMap.set(key, { profile, weight });
    };
    addWeightedProfile(learnedProfile, 2.25);
    const rankedProfiles = [...options.backtest.profilePerformance]
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, 4);
    for (const ranked of rankedProfiles) {
        const profile = profileByName.get(ranked.name);
        if (!profile)
            continue;
        addWeightedProfile(profile, Math.max(1, ranked.overlap) + 0.75);
    }
    const weightedProfiles = Array.from(weightedProfileMap.values());
    emitProgress(0.28, "Scoring candidate numbers");
    const finalScores = blendCompositeScores(learnedDiagnostics, options.draws, weightedProfiles, (profileIndex, totalProfiles) => {
        const progress = totalProfiles > 0 ? (profileIndex + 1) / totalProfiles : 1;
        emitProgress(0.28 + progress * 0.2, `Scoring ensemble profile ${profileIndex + 1}/${totalProfiles}`);
    });
    emitProgress(0.5, "Generating candidate sets");
    const sets = generateCandidateSets(finalScores, learnedDiagnostics, options.draws, 14, rng, {
        fastMode: options.modelSettings.fastMode,
        includeMonteCarlo: options.modelSettings.includeMonteCarlo,
        includeGenetic: options.modelSettings.includeGenetic,
        includeHistoricalEcho: options.modelSettings.includeHistoricalEcho,
        includeSlidingWindow: options.modelSettings.includeSlidingWindow,
        runtimeBudgets: options.runtimeBudgets,
        diagnosticsCache: options.diagnosticsCache,
    });
    const finalizedSets = prependConsensusSet(sets, finalScores, options.diagnostics.poolSize, learnedDiagnostics).slice(0, 10);
    emitProgress(0.84, "Computing Bayesian summary");
    const bays = bayesianSmoothed(options.draws, options.diagnostics.poolSize);
    let warning;
    if (!learnedDiagnostics.biasDetected) {
        warning =
            "⚠️ No statistically significant bias detected in the current format era. " +
                "Under fair lottery conditions, every combination is equally likely. " +
                "These predictions are based on historical pattern analysis and should be treated as entertainment only.";
    }
    else {
        warning =
            "⚠️ Some statistical deviations were detected in the current format era. " +
                `Optimized Profile: ${learnedProfile.name}. ` +
                "Play responsibly.";
    }
    if (options.refreshMode) {
        warning =
            "Candidate refresh completed using current trained state (no full retrain). " +
                warning;
    }
    emitProgress(1, options.refreshMode ? "Candidate refresh complete" : "Prediction complete");
    return {
        sets: finalizedSets,
        scores: finalScores,
        bayesian: bays,
        warning,
    };
}
function runPrediction(draws, diagnostics, options = {}) {
    const emitProgress = (progress, stage) => {
        options.onProgress?.(clampUnit(progress), stage);
    };
    emitProgress(0.02, "Preparing training window");
    const N = diagnostics.poolSize;
    const modelSettings = options.settings || {};
    const seedSalt = modelSettings.randomSeedSalt !== undefined
        ? String(modelSettings.randomSeedSalt)
        : "";
    const trainRatio = modelSettings.trainRatio !== undefined
        ? clampNumber(modelSettings.trainRatio, 0.5, 0.95)
        : 0.8;
    // Use the full uploaded history in chronological order for training/prediction.
    const eraDraws = [...draws].sort((a, b) => a.date.localeCompare(b.date));
    const calibratedBudgets = calibrateRuntimeBudgets(eraDraws.length, {
        fastMode: modelSettings.fastMode,
        targetLatencyMs: modelSettings.targetLatencyMs,
    });
    const runtimeBudgets = applyModelSettingsToBudgets(calibratedBudgets, modelSettings);
    const diagnosticsCache = createDiagnosticsCache(220);
    // PHASE 5: Run backtest FIRST to "warm up" the model through online learning
    emitProgress(0.08, "Running adaptive backtest");
    const bt = backtest(eraDraws, N, trainRatio, (progress, stage) => {
        emitProgress(0.08 + progress * 0.72, stage);
    }, runtimeBudgets, diagnosticsCache, seedSalt, modelSettings, options.onTrace);
    const finalArtifacts = buildFinalPredictionArtifacts({
        draws: eraDraws,
        diagnostics,
        backtest: bt,
        modelSettings,
        runtimeBudgets,
        diagnosticsCache,
        seedSalt,
        onProgress: (progress, stage) => {
            emitProgress(0.82 + progress * 0.18, stage);
        },
    });
    return {
        sets: finalArtifacts.sets,
        backtest: bt,
        scores: finalArtifacts.scores,
        bayesian: finalArtifacts.bayesian,
        warning: finalArtifacts.warning,
    };
}
function refreshPredictionCandidates(draws, diagnostics, options) {
    const emitProgress = (progress, stage) => {
        options.onProgress?.(clampUnit(progress), stage);
    };
    emitProgress(0.03, "Preparing candidate refresh");
    const modelSettings = options.settings || {};
    const seedSalt = modelSettings.randomSeedSalt !== undefined
        ? String(modelSettings.randomSeedSalt)
        : "";
    const eraDraws = [...draws].sort((a, b) => a.date.localeCompare(b.date));
    const calibratedBudgets = calibrateRuntimeBudgets(eraDraws.length, {
        fastMode: modelSettings.fastMode,
        targetLatencyMs: modelSettings.targetLatencyMs,
    });
    const runtimeBudgets = applyModelSettingsToBudgets(calibratedBudgets, modelSettings);
    const diagnosticsCache = createDiagnosticsCache(120);
    const baseBacktest = options.basePrediction.backtest;
    const reusedDiagnostics = baseBacktest.finalDiagnostics.poolSize === diagnostics.poolSize
        ? baseBacktest.finalDiagnostics
        : diagnostics;
    const refreshedBacktest = {
        ...baseBacktest,
        finalDiagnostics: reusedDiagnostics,
    };
    const finalArtifacts = buildFinalPredictionArtifacts({
        draws: eraDraws,
        diagnostics: reusedDiagnostics,
        backtest: refreshedBacktest,
        modelSettings,
        runtimeBudgets,
        diagnosticsCache,
        seedSalt: `${seedSalt}|refresh`,
        refreshMode: true,
        onProgress: (progress, stage) => {
            emitProgress(0.08 + progress * 0.9, stage);
        },
    });
    return {
        sets: finalArtifacts.sets,
        backtest: refreshedBacktest,
        scores: finalArtifacts.scores,
        bayesian: finalArtifacts.bayesian,
        warning: finalArtifacts.warning,
    };
}
// ─── Genetic Algorithm Optimization ─────────────────────────────────
function runGeneticOptimization(scores, diag, rng, generations = BASE_GENETIC_GENERATIONS, popSize = BASE_GENETIC_POPULATION, setScoreCache = new Map(), scoringLookup = createScoringLookup(scores, diag)) {
    const N = diag.poolSize;
    const topN = 24; // Compress search space to top 24 numbers
    const numPool = scores.slice(0, topN).map((s) => s.number);
    const scoreSet = (set) => {
        const sorted = [...set].sort((a, b) => a - b);
        const key = sorted.join(",");
        const cached = setScoreCache.get(key);
        if (cached !== undefined)
            return cached;
        const score = setScore(sorted, scores, N, diag, scoringLookup);
        setScoreCache.set(key, score);
        return score;
    };
    // Initial Population
    let population = [];
    for (let i = 0; i < popSize; i++) {
        const set = [];
        while (set.length < analysis_1.K) {
            const n = numPool[Math.floor(rng() * numPool.length)];
            if (!set.includes(n))
                set.push(n);
        }
        population.push(set.sort((a, b) => a - b));
    }
    for (let gen = 0; gen < generations; gen++) {
        // 1. Fitness Calculation
        // PHASE 7: Aggressively target "Match Density" (high overlap probability)
        const fitnessResults = population.map((set) => {
            const baseScore = scoreSet(set);
            // Penalize sets that lack high-order relationship variety
            // Reward sets that sit in the "sweet spot" of recent transition hubs
            return { set, score: baseScore };
        });
        // Elitism: keep top 10%
        const ranked = [...fitnessResults].sort((a, b) => b.score - a.score);
        const nextGen = ranked
            .slice(0, Math.floor(popSize * 0.1))
            .map((r) => r.set);
        // Tournament Selection
        const tournament = (size) => {
            let best = fitnessResults[Math.floor(rng() * popSize)];
            for (let i = 1; i < size; i++) {
                const contestant = fitnessResults[Math.floor(rng() * popSize)];
                if (contestant.score > best.score)
                    best = contestant;
            }
            return best.set;
        };
        // 3. Crossover & Mutation
        while (nextGen.length < popSize) {
            const p1 = tournament(5);
            const p2 = tournament(5);
            // Uniform Crossover
            const offspringSet = new Set();
            for (let i = 0; i < analysis_1.K; i++) {
                offspringSet.add(rng() < 0.5 ? p1[i] : p2[i]);
            }
            // Fill missing numbers (restricted to Top N pool)
            while (offspringSet.size < analysis_1.K) {
                const n = numPool[Math.floor(rng() * numPool.length)];
                offspringSet.add(n);
            }
            let offspring = Array.from(offspringSet).sort((a, b) => a - b);
            // Adaptive Mutation (restricted to Top N pool)
            const mutationRate = 0.1; // Consistent mutation rate
            if (rng() < mutationRate) {
                const idx = Math.floor(rng() * analysis_1.K);
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
        .map((set) => ({
        set,
        score: scoreSet(set),
    }))
        .sort((a, b) => b.score - a.score);
    return finalRanked[0].set;
}
// ─── Cross-Era Similarity Search ────────────────────────────────────
function findHistoricalEchoes(scores, diag, draws, runtimeBudgets = calibrateRuntimeBudgets(draws.length), diagnosticsCache = createDiagnosticsCache(96)) {
    const currentProfile = {
        chi: diag.chiSquare.chiSquare,
        ac: diag.autocorrelation.filter((a) => a.isSignificant).length,
        hot: diag.hotCold.filter((h) => h.status === "hot").length,
        overdue: diag.gaps.filter((g) => g.isOverdue).length,
    };
    const windowSize = 50;
    const echoes = [];
    const similarityScores = [];
    const totalWindows = Math.max(0, draws.length - windowSize - 1);
    const stride = Math.max(1, Math.ceil(totalWindows / Math.max(1, runtimeBudgets.historicalEchoMaxWindows)));
    // Slide through history to find statistically similar 50-draw windows
    for (let i = 0; i < draws.length - windowSize - 1; i += stride) {
        const windowDraws = draws.slice(i, i + windowSize);
        const windowDiag = diagnosticsCache.get(windowDraws);
        if (windowDiag.poolSize !== diag.poolSize)
            continue;
        const windowProfile = {
            chi: windowDiag.chiSquare.chiSquare,
            ac: windowDiag.autocorrelation.filter((a) => a.isSignificant).length,
            hot: windowDiag.hotCold.filter((h) => h.status === "hot").length,
            overdue: windowDiag.gaps.filter((g) => g.isOverdue).length,
        };
        // Euclidean distance (normalized roughly)
        const dist = Math.sqrt(Math.pow((currentProfile.chi - windowProfile.chi) / 20, 2) +
            Math.pow(currentProfile.ac - windowProfile.ac, 2) +
            Math.pow(currentProfile.hot - windowProfile.hot, 2) +
            Math.pow(currentProfile.overdue - windowProfile.overdue, 2));
        if (dist < 3.0) {
            similarityScores.push({ index: i, score: dist });
            if (similarityScores.length > runtimeBudgets.historicalEchoMaxWindows) {
                similarityScores.sort((a, b) => a.score - b.score);
                similarityScores.pop();
            }
        }
    }
    similarityScores.sort((a, b) => a.score - b.score);
    // Take the draw immediately after the top most similar windows
    for (let i = 0; i < Math.min(runtimeBudgets.historicalEchoTopMatches, similarityScores.length); i++) {
        const nextDraw = draws[similarityScores[i].index + windowSize];
        if (nextDraw) {
            for (const n of nextDraw.numbers) {
                if (!echoes.includes(n))
                    echoes.push(n);
            }
        }
    }
    // Fill with high-composite numbers if needed
    for (const s of scores) {
        if (echoes.length >= 12)
            break;
        if (!echoes.includes(s.number))
            echoes.push(s.number);
    }
    return echoes;
}
