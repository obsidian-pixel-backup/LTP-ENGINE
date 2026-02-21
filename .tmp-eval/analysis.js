"use strict";
/**
 * Statistical Analysis Engine for SA LOTTO
 * Auto-detects game format (6/49, 6/52, 6/58) and uses appropriate pool size.
 * Implements frequency analysis, hot/cold, pairs, groups, gaps, chi-square, autocorrelation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.K = void 0;
exports.detectFormat = detectFormat;
exports.frequencyAnalysis = frequencyAnalysis;
exports.hotColdAnalysis = hotColdAnalysis;
exports.pairAnalysis = pairAnalysis;
exports.getGroup = getGroup;
exports.groupAnalysis = groupAnalysis;
exports.gapAnalysis = gapAnalysis;
exports.chiSquareTest = chiSquareTest;
exports.autocorrelationAnalysis = autocorrelationAnalysis;
exports.positionalFrequencyAnalysis = positionalFrequencyAnalysis;
exports.transitionAnalysis = transitionAnalysis;
exports.entropyDiagnostics = entropyDiagnostics;
exports.runFullDiagnostics = runFullDiagnostics;
exports.getOddEvenSplit = getOddEvenSplit;
exports.getSum = getSum;
exports.checkConsecutiveness = checkConsecutiveness;
exports.deltaAnalysis = deltaAnalysis;
exports.tripleAnalysis = tripleAnalysis;
exports.quadrupleAnalysis = quadrupleAnalysis;
exports.quintetAnalysis = quintetAnalysis;
exports.K = 6; // 6 numbers drawn per game
function inferDrawPoolSize(draw) {
    const maxInDraw = Math.max(...draw.numbers, draw.bonus || 0);
    if (maxInDraw > 52)
        return 58;
    if (maxInDraw > 49)
        return 52;
    return 49;
}
/**
 * Auto-detect the pool size for each draw.
 * The SA LOTTO has changed from 6/49 → 6/52 → 6/58 over the years.
 * We detect the current era and return only draws from that era for analysis.
 */
function detectFormat(draws) {
    if (draws.length === 0)
        return { currentN: 52, currentDraws: [], eras: [] };
    // Determine current pool size based on recent data
    const recentWindow = Math.min(50, draws.length);
    const recentDraws = draws.slice(-recentWindow);
    const recentMax = Math.max(...recentDraws.flatMap((d) => [...d.numbers, d.bonus].filter((n) => n > 0)));
    let currentN;
    if (recentMax > 52)
        currentN = 58;
    else if (recentMax > 49)
        currentN = 52;
    else
        currentN = 49;
    // Find transitions between eras
    const eras = [];
    let eraStartIndex = 0;
    let lastPoolSize = -1;
    for (let i = 0; i < draws.length; i++) {
        const poolAtI = inferDrawPoolSize(draws[i]);
        if (lastPoolSize === -1) {
            lastPoolSize = poolAtI;
        }
        else if (poolAtI > lastPoolSize) {
            // Transition to a larger pool
            eras.push({
                poolSize: lastPoolSize,
                startIndex: eraStartIndex,
                endIndex: i - 1,
                drawCount: i - eraStartIndex,
            });
            eraStartIndex = i;
            lastPoolSize = poolAtI;
        }
    }
    // Add the last (current) era
    eras.push({
        poolSize: currentN,
        startIndex: eraStartIndex,
        endIndex: draws.length - 1,
        drawCount: draws.length - eraStartIndex,
    });
    const currentDraws = draws.slice(eraStartIndex);
    return { currentN, currentDraws, eras };
}
function frequencyAnalysis(draws, N) {
    const T = draws.length;
    const K_ANALYSIS = 7; // Treat as 7-number draw for frequency
    const counts = new Array(N + 1).fill(0);
    for (const d of draws) {
        const allNums = [...d.numbers, d.bonus];
        for (const n of allNums) {
            if (n > 0 && n <= N)
                counts[n]++;
        }
    }
    const expected = (T * K_ANALYSIS) / N;
    const stdDev = Math.sqrt(T * (K_ANALYSIS / N) * (1 - K_ANALYSIS / N));
    const results = [];
    for (let i = 1; i <= N; i++) {
        results.push({
            number: i,
            count: counts[i],
            expected,
            zScore: stdDev > 0 ? (counts[i] - expected) / stdDev : 0,
            frequency: counts[i] / T,
        });
    }
    return results;
}
function hotColdAnalysis(draws, N, windowSize = 20) {
    const allFreq = frequencyAnalysis(draws, N);
    const actualWindow = Math.min(windowSize, draws.length);
    const recentDraws = draws.slice(-actualWindow);
    const recentCounts = new Array(N + 1).fill(0);
    for (const d of recentDraws) {
        const allNums = [...d.numbers, d.bonus];
        for (const n of allNums) {
            if (n > 0 && n <= N)
                recentCounts[n]++;
        }
    }
    const threshold = 1.5;
    return allFreq.map((f) => {
        const recentFreq = recentCounts[f.number] / actualWindow;
        const p = f.frequency; // Use all-time frequency as the probability
        const expWindow = actualWindow * p;
        const stdWindow = Math.sqrt(actualWindow * p * (1 - p));
        const zRecent = stdWindow > 0 ? (recentCounts[f.number] - expWindow) / stdWindow : 0;
        let status = "neutral";
        if (zRecent > threshold)
            status = "hot";
        else if (zRecent < -threshold)
            status = "cold";
        return {
            number: f.number,
            recentCount: recentCounts[f.number],
            allTimeFreq: f.frequency,
            recentFreq,
            status,
            delta: zRecent,
        };
    });
}
function pairAnalysis(draws, N, topN = 30) {
    const T = draws.length;
    const K_A = 6; // Main numbers only
    const pPair = (K_A * (K_A - 1)) / (N * (N - 1));
    const expectedPair = T * pPair;
    const stdPair = Math.sqrt(T * pPair * (1 - pPair));
    const pairCounts = new Map();
    for (const d of draws) {
        const nums = [...d.numbers].filter((n) => n > 0 && n <= N);
        for (let a = 0; a < nums.length; a++) {
            for (let b = a + 1; b < nums.length; b++) {
                const key = `${nums[a]}-${nums[b]}`;
                pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
            }
        }
    }
    const results = [];
    for (const [key, count] of pairCounts) {
        const [i, j] = key.split("-").map(Number);
        results.push({
            i,
            j,
            count,
            expected: expectedPair,
            zScore: stdPair > 0 ? (count - expectedPair) / stdPair : 0,
        });
    }
    results.sort((a, b) => b.zScore - a.zScore);
    return results.slice(0, topN);
}
function getGroup(n, N = 52) {
    const q = Math.ceil(N / 4);
    if (n <= q)
        return "Low";
    if (n <= q * 2)
        return "Medium";
    if (n <= q * 3)
        return "MedHigh";
    return "High";
}
function groupAnalysis(draws, N) {
    const T = draws.length;
    const patternCounts = new Map();
    for (const d of draws) {
        const groups = { Low: 0, Medium: 0, MedHigh: 0, High: 0 };
        const allNums = [...d.numbers, d.bonus].filter((n) => n > 0);
        for (const n of allNums)
            groups[getGroup(n, N)]++;
        const pattern = `${groups.Low}-${groups.Medium}-${groups.MedHigh}-${groups.High}`;
        patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
    }
    const results = [];
    for (const [pattern, count] of patternCounts) {
        results.push({ pattern, count, percentage: (count / T) * 100 });
    }
    results.sort((a, b) => b.count - a.count);
    return results;
}
function gapAnalysis(draws, N) {
    const T = draws.length;
    const results = [];
    for (let num = 1; num <= N; num++) {
        let lastSeen = -1;
        const gaps = [];
        for (let t = 0; t < T; t++) {
            const allNums = [...draws[t].numbers, draws[t].bonus];
            if (allNums.includes(num)) {
                if (lastSeen >= 0)
                    gaps.push(t - lastSeen);
                lastSeen = t;
            }
        }
        const currentGap = lastSeen >= 0 ? T - 1 - lastSeen : T;
        const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : T;
        const maxGap = gaps.length > 0 ? Math.max(...gaps) : T;
        results.push({
            number: num,
            currentGap,
            avgGap,
            maxGap,
            isOverdue: currentGap > avgGap * 1.5,
        });
    }
    return results;
}
function normalCDF(z) {
    if (z < -8)
        return 0;
    if (z > 8)
        return 1;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + p * x);
    const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
}
function chiSquarePValue(chiSq, df) {
    const z = Math.pow(chiSq / df, 1 / 3) - (1 - 2 / (9 * df));
    const denom = Math.sqrt(2 / (9 * df));
    const zNorm = z / denom;
    return 1 - normalCDF(zNorm);
}
function chiSquareTest(draws, N) {
    const T = draws.length;
    const counts = new Array(N + 1).fill(0);
    for (const d of draws) {
        for (const n of d.numbers) {
            if (n <= N)
                counts[n]++;
        }
    }
    const expected = (T * exports.K) / N;
    const chiSq = counts.slice(1).reduce(
    // Start from index 1 to ignore the 0th element if N is the max number
    (acc, count) => acc + (count - expected) ** 2 / expected, 0);
    // Using N for degrees of freedom calculation
    const pValue = chiSquarePValue(chiSq, N - 1);
    return {
        chiSquare: chiSq,
        degreesOfFreedom: N - 1,
        pValue,
        isUniform: pValue > 0.05,
    };
}
function autocorrelationAnalysis(draws, N) {
    const T = draws.length;
    const results = [];
    for (let num = 1; num <= N; num++) {
        const x = [];
        for (let t = 0; t < T; t++) {
            x.push(draws[t].numbers.includes(num) ? 1 : 0);
        }
        const mean = x.reduce((a, b) => a + b, 0) / T;
        let num1 = 0, denom = 0;
        for (let t = 0; t < T; t++) {
            denom += (x[t] - mean) ** 2;
            if (t < T - 1)
                num1 += (x[t] - mean) * (x[t + 1] - mean);
        }
        const lag1 = denom > 0 ? num1 / denom : 0;
        const threshold = 2 / Math.sqrt(T);
        results.push({
            number: num,
            lag1Corr: lag1,
            isSignificant: Math.abs(lag1) > threshold,
        });
    }
    return results;
}
function positionalFrequencyAnalysis(draws, _N) {
    const K_SIZE = 7; // Updated to 7 for all-inclusive training
    const counts = Array.from({ length: K_SIZE }, () => ({}));
    for (const d of draws) {
        const sorted = [...d.numbers, d.bonus]
            .filter((n) => n > 0)
            .sort((a, b) => a - b);
        for (let i = 0; i < sorted.length; i++) {
            const n = sorted[i];
            if (counts[i]) {
                counts[i][n] = (counts[i][n] || 0) + 1;
            }
        }
    }
    return counts.map((c, i) => {
        const freqs = {};
        // Ensure all numbers in pool N are represented if needed, or just map existing
        Object.entries(c).forEach(([num, count]) => {
            freqs[parseInt(num)] = (count / (draws.length || 1)) * 100;
        });
        return { position: i + 1, numberFreqs: freqs };
    });
}
function transitionAnalysis(draws, N, maxLag = 4, topN = 10) {
    const results = [];
    for (let lag = 1; lag <= maxLag; lag++) {
        const matrix = {};
        for (let t = 0; t < draws.length - lag; t++) {
            const current = [...draws[t].numbers].filter((n) => n > 0);
            const next = [...draws[t + lag].numbers].filter((n) => n > 0);
            for (const a of current) {
                if (!matrix[a])
                    matrix[a] = {};
                for (const b of next) {
                    matrix[a][b] = (matrix[a][b] || 0) + 1;
                }
            }
        }
        for (let i = 1; i <= N; i++) {
            if (!matrix[i])
                continue;
            const transitions = Object.entries(matrix[i]).map(([num, count]) => ({
                number: parseInt(num),
                count,
            }));
            const total = transitions.reduce((s, x) => s + x.count, 0);
            const sorted = transitions
                .map((t) => ({
                number: t.number,
                count: t.count,
                probability: t.count / total,
            }))
                .sort((a, b) => b.probability - a.probability)
                .slice(0, topN);
            results.push({ lag, fromNumber: i, toNumbers: sorted });
        }
    }
    return results;
}
function clampUnit(value) {
    if (!Number.isFinite(value))
        return 0;
    if (value < 0)
        return 0;
    if (value > 1)
        return 1;
    return value;
}
function normalizedShannonEntropy(counts, N) {
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total <= 0 || N <= 1)
        return 1;
    let entropy = 0;
    for (let i = 1; i <= N; i++) {
        const count = counts[i] || 0;
        if (count <= 0)
            continue;
        const p = count / total;
        entropy -= p * Math.log2(p);
    }
    const maxEntropy = Math.log2(N);
    return clampUnit(maxEntropy > 0 ? entropy / maxEntropy : 1);
}
function countNumbersInDrawWindow(draws, N) {
    const counts = new Array(N + 1).fill(0);
    for (const draw of draws) {
        const all = [...draw.numbers, draw.bonus].filter((n) => n > 0 && n <= N);
        for (const n of all)
            counts[n]++;
    }
    return counts;
}
function entropyDiagnostics(draws, N) {
    if (draws.length === 0) {
        return {
            normalizedEntropy: 1,
            concentration: 0,
            entropyTrend: 0,
            rollingEntropy: [],
            windowSize: 0,
            regime: "neutral",
        };
    }
    const preferredWindow = Math.max(20, Math.round(draws.length * 0.22));
    const windowSize = Math.max(8, Math.min(draws.length, preferredWindow));
    const stride = Math.max(4, Math.floor(windowSize / 3));
    const rollingEntropy = [];
    if (draws.length <= windowSize) {
        rollingEntropy.push(normalizedShannonEntropy(countNumbersInDrawWindow(draws, N), N));
    }
    else {
        for (let start = 0; start + windowSize <= draws.length; start += stride) {
            const segment = draws.slice(start, start + windowSize);
            rollingEntropy.push(normalizedShannonEntropy(countNumbersInDrawWindow(segment, N), N));
        }
        const tailStart = Math.max(0, draws.length - windowSize);
        const tail = draws.slice(tailStart);
        const tailEntropy = normalizedShannonEntropy(countNumbersInDrawWindow(tail, N), N);
        if (rollingEntropy.length === 0 ||
            Math.abs(rollingEntropy[rollingEntropy.length - 1] - tailEntropy) > 1e-6) {
            rollingEntropy.push(tailEntropy);
        }
    }
    const recentWindow = draws.slice(-windowSize);
    const recentCounts = countNumbersInDrawWindow(recentWindow, N);
    const normalizedEntropy = normalizedShannonEntropy(recentCounts, N);
    const totalRecent = recentCounts.reduce((sum, count) => sum + count, 0);
    let hhi = 0;
    if (totalRecent > 0) {
        for (let i = 1; i <= N; i++) {
            const p = recentCounts[i] / totalRecent;
            hhi += p * p;
        }
    }
    const uniformHhi = 1 / Math.max(1, N);
    const concentration = clampUnit((hhi - uniformHhi) / (1 - uniformHhi));
    let entropyTrend = 0;
    if (rollingEntropy.length >= 2) {
        const split = Math.max(1, Math.floor(rollingEntropy.length / 2));
        const early = rollingEntropy.slice(0, split);
        const late = rollingEntropy.slice(split);
        const avg = (arr) => arr.reduce((sum, value) => sum + value, 0) / Math.max(1, arr.length);
        entropyTrend = avg(late) - avg(early);
    }
    let regime = "neutral";
    if (normalizedEntropy <= 0.94 ||
        (entropyTrend < -0.015 && concentration >= 0.08)) {
        regime = "structured";
    }
    else if (normalizedEntropy >= 0.98 &&
        concentration <= 0.05 &&
        entropyTrend >= -0.01) {
        regime = "diffuse";
    }
    return {
        normalizedEntropy,
        concentration,
        entropyTrend,
        rollingEntropy,
        windowSize,
        regime,
    };
}
function runFullDiagnostics(draws) {
    const { currentN, currentDraws, eras } = detectFormat(draws);
    const N = currentN;
    // Relationship analysis should stay within the same detected format pool.
    // Mixing 6/49, 6/52, and 6/58 eras can dilute affinity/transition signals.
    const samePoolDraws = draws.filter((draw) => inferDrawPoolSize(draw) === N);
    const relationshipDraws = samePoolDraws.length > 0 ? samePoolDraws : currentDraws;
    // BIAS DIAGNOSTICS: Stay era-pure for frequency/uniformity
    const freq = frequencyAnalysis(currentDraws, N);
    const hc = hotColdAnalysis(currentDraws, N, 20);
    const pairs = pairAnalysis(currentDraws, N, 30);
    const groups = groupAnalysis(currentDraws, N);
    const gaps = gapAnalysis(currentDraws, N);
    const chi = chiSquareTest(currentDraws, N);
    const ac = autocorrelationAnalysis(currentDraws, N);
    // RELATIONSHIP ANALYSIS: Use full uploaded history
    const deltas = deltaAnalysis(relationshipDraws);
    const triples = tripleAnalysis(relationshipDraws, 50);
    const quadruples = quadrupleAnalysis(relationshipDraws, 20);
    const quintets = quintetAnalysis(relationshipDraws, 10);
    const positional = positionalFrequencyAnalysis(relationshipDraws, N);
    const transitions = transitionAnalysis(relationshipDraws, N);
    const entropy = entropyDiagnostics(currentDraws, N);
    const sigAutocorr = ac.filter((a) => a.isSignificant);
    const biasReasons = [];
    if (!chi.isUniform)
        biasReasons.push("Frequency imbalance (Chi-Square)");
    if (sigAutocorr.length > 0)
        biasReasons.push(`Sequential dependency (${sigAutocorr.length} lags)`);
    if (gaps.filter((g) => g.isOverdue).length > N * 0.2)
        biasReasons.push("High number of overdue values");
    if (hc.filter((h) => h.status === "hot").length < 3)
        biasReasons.push("Weak recent trend (Cold cycle)");
    if (entropy.regime === "structured")
        biasReasons.push("Entropy contraction (structured regime)");
    const biasDetected = biasReasons.length > 0;
    return {
        totalDraws: draws.length,
        poolSize: N,
        eraDrawCount: currentDraws.length,
        frequency: freq,
        hotCold: hc,
        topPairs: pairs,
        groupPatterns: groups,
        gaps,
        chiSquare: chi,
        autocorrelation: ac,
        deltas,
        topTriples: triples,
        topQuadruples: quadruples,
        topQuintets: quintets,
        positionalFreq: positional,
        transitions,
        entropy,
        biasDetected,
        biasReasons,
        eras,
    };
}
// ─── Set Balance Helpers ────────────────────────────────────────────
function getOddEvenSplit(numbers) {
    let odd = 0;
    for (const n of numbers) {
        if (n % 2 !== 0)
            odd++;
    }
    return { odd, even: numbers.length - odd };
}
function getSum(numbers) {
    return numbers.reduce((a, b) => a + b, 0);
}
function checkConsecutiveness(numbers) {
    let consecutivePairs = 0;
    // numbers are assumed sorted
    for (let i = 0; i < numbers.length - 1; i++) {
        if (numbers[i + 1] === numbers[i] + 1)
            consecutivePairs++;
    }
    return consecutivePairs;
}
function deltaAnalysis(draws) {
    const deltaCounts = {};
    let totalDeltas = 0;
    for (const draw of draws) {
        const sorted = [...draw.numbers, draw.bonus]
            .filter((n) => n > 0)
            .sort((a, b) => a - b);
        for (let i = 0; i < sorted.length - 1; i++) {
            const d = sorted[i + 1] - sorted[i];
            deltaCounts[d] = (deltaCounts[d] || 0) + 1;
            totalDeltas++;
        }
    }
    return Object.entries(deltaCounts)
        .map(([d, count]) => ({
        delta: parseInt(d),
        count,
        percentage: (count / totalDeltas) * 100,
    }))
        .sort((a, b) => b.count - a.count);
}
function tripleAnalysis(draws, topN = 50) {
    const trips = {};
    for (const draw of draws) {
        const allNums = [...draw.numbers, draw.bonus]
            .filter((n) => n > 0)
            .sort((a, b) => a - b);
        for (let i = 0; i < allNums.length - 2; i++) {
            for (let j = i + 1; j < allNums.length - 1; j++) {
                for (let l = j + 1; l < allNums.length; l++) {
                    const key = `${allNums[i]},${allNums[j]},${allNums[l]}`;
                    trips[key] = (trips[key] || 0) + 1;
                }
            }
        }
    }
    return Object.entries(trips)
        .map(([key, count]) => {
        const [i, j, k] = key.split(",").map(Number);
        return { i, j, k, count };
    })
        .sort((a, b) => b.count - a.count)
        .slice(0, topN);
}
function quadrupleAnalysis(draws, topN = 20) {
    const quads = {};
    for (const draw of draws) {
        const allNums = [...draw.numbers, draw.bonus]
            .filter((n) => n > 0)
            .sort((a, b) => a - b);
        for (let i = 0; i < allNums.length - 3; i++) {
            for (let j = i + 1; j < allNums.length - 2; j++) {
                for (let k = j + 1; k < allNums.length - 1; k++) {
                    for (let l = k + 1; l < allNums.length; l++) {
                        const key = `${allNums[i]},${allNums[j]},${allNums[k]},${allNums[l]}`;
                        quads[key] = (quads[key] || 0) + 1;
                    }
                }
            }
        }
    }
    return Object.entries(quads)
        .filter(([, count]) => count > 1) // Only care about repeats
        .map(([key, count]) => {
        const [i, j, k, l] = key.split(",").map(Number);
        return { i, j, k, l, count };
    })
        .sort((a, b) => b.count - a.count)
        .slice(0, topN);
}
function quintetAnalysis(draws, topN = 10) {
    const quints = {};
    for (const draw of draws) {
        const allNums = [...draw.numbers, draw.bonus]
            .filter((n) => n > 0)
            .sort((a, b) => a - b);
        for (let i = 0; i < allNums.length - 4; i++) {
            for (let j = i + 1; j < allNums.length - 3; j++) {
                for (let k = j + 1; k < allNums.length - 2; k++) {
                    for (let l = k + 1; l < allNums.length - 1; l++) {
                        for (let m = l + 1; m < allNums.length; m++) {
                            const key = `${allNums[i]},${allNums[j]},${allNums[k]},${allNums[l]},${allNums[m]}`;
                            quints[key] = (quints[key] || 0) + 1;
                        }
                    }
                }
            }
        }
    }
    return Object.entries(quints)
        .filter(([, count]) => count > 1) // Only rare repeats
        .map(([key, count]) => {
        const [i, j, k, l, m] = key.split(",").map(Number);
        return { i, j, k, l, m, count };
    })
        .sort((a, b) => b.count - a.count)
        .slice(0, topN);
}
