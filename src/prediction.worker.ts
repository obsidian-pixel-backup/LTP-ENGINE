import { runFullDiagnostics } from "./analysis";
import {
  refreshPredictionCandidates,
  runPrediction,
  type PredictionLiveTrace,
} from "./predictor";
import type {
  PredictionWorkerCancelRequest,
  PredictionWorkerRequest,
  PredictionWorkerResponse,
} from "./predictionWorkerTypes";
import type { ModelSettings, PredictionOutput } from "./predictor";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<PredictionWorkerRequest>) => void) | null;
  postMessage: (message: PredictionWorkerResponse) => void;
};
let activeRequestId = 0;
let activeRequestToken = 0;
const DEFAULT_TARGET_SEQUENCE_MATCH = 5;
const DEFAULT_MAX_OPTIMIZATION_ROUNDS = 10;

function clampPercent(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function getMaxOverlap(prediction: PredictionOutput): number {
  if (Number.isFinite(prediction.backtest.maxObservedOverlap)) {
    return prediction.backtest.maxObservedOverlap;
  }
  return prediction.backtest.rowDetails.reduce(
    (maxVal, row) => Math.max(maxVal, row.overlap),
    0,
  );
}

function scorePredictionQuality(prediction: PredictionOutput): number {
  const bt = prediction.backtest;
  const masterySolved = bt.masterySolvedSequences ?? 0;
  const masteryFirstAttemptSolved = bt.masteryFirstAttemptSolved ?? 0;
  const masteryAttempts = bt.masteryTotalAttempts ?? 0;
  const forwardSixMatchHits = bt.forwardOnlySixMatchHits ?? bt.sixMatchHits;
  const forwardSixMatchRate = bt.forwardOnlySixMatchRate ?? bt.sixMatchRate;
  const forwardTop6Overlap = bt.forwardOnlyTop6Overlap ?? bt.top6Overlap;
  const forwardModelHitRate = bt.forwardOnlyModelHitRate ?? bt.modelHitRate;
  const forwardFourPlusHits = bt.forwardOnlyFourPlusHits ?? bt.fourPlusHits;
  const forwardFourPlusRate = bt.forwardOnlyFourPlusRate ?? bt.fourPlusRate;
  const masteryAttemptsPerSequence =
    bt.testSize > 0 ? masteryAttempts / bt.testSize : masteryAttempts;

  return (
    // Prioritize first-attempt quality before multi-attempt mastery outcomes.
    forwardSixMatchRate * 1_600_000 +
    forwardSixMatchHits * 220_000 +
    masteryFirstAttemptSolved * 180_000 +
    forwardTop6Overlap * 10_000 +
    forwardModelHitRate * 8_000 +
    forwardFourPlusHits * 12_000 +
    forwardFourPlusRate * 80_000 +
    bt.maxObservedOverlap * 250_000 +
    bt.sixMatchHits * 20_000 +
    bt.sixMatchRate * 30_000 +
    masterySolved * 15_000 -
    masteryAttemptsPerSequence * 1_400 -
    masteryAttempts * 2 +
    bt.fourPlusHits * 2_000 +
    bt.fourPlusRate * 8_000 +
    bt.top6Overlap * 1_000 +
    bt.modelHitRate * 900 +
    bt.improvement * 15
  );
}

function extractProfileOverlapMap(
  prediction: PredictionOutput,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const profile of prediction.backtest.profilePerformance) {
    map[profile.name] = profile.overlap;
  }
  return map;
}

function buildRoundSettings(
  baseSettings: ModelSettings | undefined,
  round: number,
  attempt = 0,
): ModelSettings {
  const base = baseSettings || {};
  const baseTrainRatio = base.trainRatio ?? 0.8;
  const ratioOffsets = [-0.08, -0.04, 0, 0.04, 0.08];
  const ratioOffset = ratioOffsets[(round + attempt) % ratioOffsets.length];
  const targetLatencyMs = base.targetLatencyMs ?? 1400;
  const monteCarloMinTrials = base.monteCarloMinTrials;
  const monteCarloMaxTrials = base.monteCarloMaxTrials;
  const geneticGenerations = base.geneticGenerations;
  const geneticPopulation = base.geneticPopulation;
  const deepMatchMode =
    (base.targetSequenceMatch ?? DEFAULT_TARGET_SEQUENCE_MATCH) >= 6 &&
    !(base.fastMode ?? false);
  const adjustedTrainRatio = clampNumber(baseTrainRatio + ratioOffset, 0.5, 0.95);

  return {
    ...base,
    randomSeedSalt: `round-${round}-attempt-${attempt}-${Date.now()}`,
    trainRatio: adjustedTrainRatio,
    fastMode: base.fastMode ?? false,
    targetLatencyMs: Math.round(
      clampNumber(targetLatencyMs + round * 140 + attempt * 90, 450, 12000),
    ),
    monteCarloMinTrials:
      monteCarloMinTrials !== undefined
        ? Math.round(
            clampNumber(monteCarloMinTrials + round * 180 + attempt * 120, 100, 120000),
          )
        : deepMatchMode
          ? Math.round(
              clampNumber(3500 + round * 260 + attempt * 220, 800, 120000),
            )
          : undefined,
    monteCarloMaxTrials:
      monteCarloMaxTrials !== undefined
        ? Math.round(
            clampNumber(monteCarloMaxTrials + round * 360 + attempt * 240, 500, 200000),
          )
        : deepMatchMode
          ? Math.round(
              clampNumber(16000 + round * 1200 + attempt * 900, 4000, 200000),
            )
          : undefined,
    geneticGenerations:
      geneticGenerations !== undefined
        ? Math.round(clampNumber(geneticGenerations + round + attempt, 5, 300))
        : deepMatchMode
          ? Math.round(clampNumber(65 + round * 3 + attempt * 2, 20, 300))
          : undefined,
    geneticPopulation:
      geneticPopulation !== undefined
        ? Math.round(clampNumber(geneticPopulation + round * 3 + attempt * 2, 20, 1500))
        : deepMatchMode
          ? Math.round(clampNumber(180 + round * 8 + attempt * 6, 40, 1500))
          : undefined,
    includeMonteCarlo: base.includeMonteCarlo ?? true,
    includeGenetic: base.includeGenetic ?? true,
    includeHistoricalEcho: base.includeHistoricalEcho ?? true,
    includeSlidingWindow: base.includeSlidingWindow ?? true,
  };
}

workerScope.onmessage = (event: MessageEvent<PredictionWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    const cancelRequest = request as PredictionWorkerCancelRequest;
    activeRequestToken++;
    activeRequestId = cancelRequest.requestId;
    workerScope.postMessage({
      requestId: cancelRequest.requestId,
      type: "progress",
      percent: 0,
      stage: "Training stopped.",
    });
    return;
  }

  const requestToken = ++activeRequestToken;
  const { requestId } = request;
  activeRequestId = requestId;
  let lastPercent = -1;
  let lastStage = "";
  let lastTraceSentAt = 0;

  const reportProgress = (percent: number, stage: string) => {
    const rounded = Math.round(clampPercent(percent));
    if (rounded === lastPercent && stage === lastStage) return;
    if (stage === lastStage && rounded < lastPercent + 1) return;

    lastPercent = rounded;
    lastStage = stage;
    workerScope.postMessage({
      requestId,
      type: "progress",
      percent: rounded,
      stage,
    });
  };

  const reportTrace = (trace: PredictionLiveTrace) => {
    if (requestToken !== activeRequestToken || requestId !== activeRequestId) {
      return;
    }
    const now = Date.now();
    const attempt = trace.attemptsUsed ?? 0;
    const milestone =
      trace.phase === "backtest_row" ||
      attempt <= 1 ||
      attempt % 4 === 0 ||
      trace.overlap >= 4;
    if (!milestone && now - lastTraceSentAt < 140) {
      return;
    }
    lastTraceSentAt = now;
    workerScope.postMessage({
      requestId,
      type: "trace",
      percent: Math.max(0, lastPercent),
      trace,
    });
  };

  const handleRequest = async () => {
    if (request.type === "refresh_candidates") {
      reportProgress(4, "Preparing candidate refresh");
      const diagnostics =
        request.diagnostics ??
        request.basePrediction.backtest.finalDiagnostics ??
        runFullDiagnostics(request.draws);
      const prediction = refreshPredictionCandidates(request.draws, diagnostics, {
        onProgress: (progress, stage) => {
          reportProgress(8 + progress * 88, stage);
        },
        settings: request.settings,
        basePrediction: request.basePrediction,
      });
      if (requestToken !== activeRequestToken || requestId !== activeRequestId) {
        return;
      }
      reportProgress(99, "Publishing refreshed candidates");
      workerScope.postMessage({
        requestId,
        type: "refresh_result",
        diagnostics: prediction.backtest.finalDiagnostics,
        prediction,
      });
      return;
    }

    const { draws, settings } = request;
    reportProgress(3, "Loading training data");
    reportProgress(10, "Running diagnostics");
    const diagnostics = runFullDiagnostics(draws);
    reportProgress(28, "Diagnostics complete");

    const continuousTraining = settings?.continuousTraining === true;
    const masteryBacktestMode = settings?.masteryBacktestMode === true;
    const targetSequenceMatch = Math.round(
      clampNumber(settings?.targetSequenceMatch ?? DEFAULT_TARGET_SEQUENCE_MATCH, 1, 6),
    );
    const maxOptimizationRoundsRaw = settings?.maxOptimizationRounds;
    const maxOptimizationRounds =
      maxOptimizationRoundsRaw === undefined
        ? DEFAULT_MAX_OPTIMIZATION_ROUNDS
        : maxOptimizationRoundsRaw > 0
          ? Math.round(clampNumber(maxOptimizationRoundsRaw, 1, 500))
          : Number.POSITIVE_INFINITY;

    if (masteryBacktestMode && !continuousTraining) {
      reportProgress(20, "Sequence mastery backtest enabled");
      const prediction = runPrediction(draws, diagnostics, {
        onProgress: (progress, stage) => {
          reportProgress(20 + progress * 76, stage);
        },
        onTrace: reportTrace,
        settings,
      });
      reportProgress(99, "Publishing mastery results");
      workerScope.postMessage({
        requestId,
        type: "result",
        diagnostics: prediction.backtest.finalDiagnostics,
        prediction,
      });
      return;
    }

    if (!continuousTraining) {
      const prediction = runPrediction(draws, diagnostics, {
        onProgress: (progress, stage) => {
          reportProgress(28 + progress * 68, stage);
        },
        onTrace: reportTrace,
        settings,
      });
      reportProgress(99, "Publishing results");
      workerScope.postMessage({
        requestId,
        type: "result",
        diagnostics: prediction.backtest.finalDiagnostics,
        prediction,
      });
      return;
    }

    const roundCapText = Number.isFinite(maxOptimizationRounds)
      ? `${maxOptimizationRounds} rounds`
      : "no round cap";
    reportProgress(
      22,
      masteryBacktestMode
        ? `Continuous mastery optimization enabled (${roundCapText})`
        : `Continuous self-training enabled (${roundCapText})`,
    );
    let round = 0;
    let bestPrediction: PredictionOutput | null = null;
    let bestOverlap = -1;
    let bestQuality = -Infinity;
    let carriedWarmProfile = settings?.warmStartProfile;
    let carriedWarmOverlaps = settings?.warmProfileOverlaps;
    const latencyBudgetMs = settings?.targetLatencyMs ?? 1400;
    const baseAttempts = settings?.fastMode
      ? 1
      : masteryBacktestMode
        ? targetSequenceMatch >= 6
          ? 5
          : 4
        : targetSequenceMatch >= 6
          ? 4
          : targetSequenceMatch >= 5
            ? 3
            : 2;
    const latencyBonusAttempts =
      settings?.fastMode
        ? 0
        : latencyBudgetMs >= 3200
          ? 2
          : latencyBudgetMs >= 2400
            ? 1
            : 0;
    const attemptsPerRound = Math.max(
      1,
      Math.min(8, baseAttempts + latencyBonusAttempts),
    );

    while (round < maxOptimizationRounds) {
      if (requestToken !== activeRequestToken || requestId !== activeRequestId) {
        return;
      }

      const roundNumber = round + 1;

      const roundPercentStart = Number.isFinite(maxOptimizationRounds)
        ? 24 + (round / maxOptimizationRounds) * 68
        : 28;
      const roundPercentSpan = Number.isFinite(maxOptimizationRounds)
        ? 68 / Math.max(1, maxOptimizationRounds)
        : 64;
      const attemptSpan = roundPercentSpan / attemptsPerRound;
      let roundBestPrediction: PredictionOutput | null = null;
      let roundBestOverlap = -1;
      let roundBestQuality = -Infinity;

      for (let attempt = 0; attempt < attemptsPerRound; attempt++) {
        if (requestToken !== activeRequestToken || requestId !== activeRequestId) {
          return;
        }

        const roundBaseSettings: ModelSettings = {
          ...(settings || {}),
          warmStartEnabled: carriedWarmProfile !== undefined,
          warmStartProfile: carriedWarmProfile,
          warmProfileOverlaps: carriedWarmOverlaps,
        };
        const roundSettings = buildRoundSettings(roundBaseSettings, round, attempt);
        const prediction = runPrediction(draws, diagnostics, {
          onProgress: (progress, stage) => {
            reportProgress(
              roundPercentStart + attempt * attemptSpan + progress * attemptSpan,
              `Round ${roundNumber}.${attempt + 1}: ${stage}`,
            );
          },
          onTrace: reportTrace,
          settings: roundSettings,
        });

        const roundMaxOverlap = getMaxOverlap(prediction);
        const roundQuality = scorePredictionQuality(prediction);
        if (
          roundBestPrediction === null ||
          roundQuality > roundBestQuality ||
          (roundQuality === roundBestQuality && roundMaxOverlap > roundBestOverlap)
        ) {
          roundBestPrediction = prediction;
          roundBestOverlap = roundMaxOverlap;
          roundBestQuality = roundQuality;
        }
      }

      if (!roundBestPrediction) {
        throw new Error(`Round ${roundNumber} failed to produce a candidate prediction.`);
      }

      carriedWarmProfile = roundBestPrediction.backtest.finalBestProfile;
      carriedWarmOverlaps = extractProfileOverlapMap(roundBestPrediction);

      const hasBetter =
        bestPrediction === null ||
        roundBestQuality > bestQuality ||
        (roundBestQuality === bestQuality && roundBestOverlap > bestOverlap);

      if (hasBetter) {
        bestPrediction = roundBestPrediction;
        bestOverlap = roundBestOverlap;
        bestQuality = roundBestQuality;
      }

      const currentPercent = Number.isFinite(maxOptimizationRounds)
        ? Math.min(
            96,
            Math.round(24 + (roundNumber / maxOptimizationRounds) * 68),
          )
        : 94;
      const roundForwardOverlap =
        roundBestPrediction.backtest.forwardOnlyTop6Overlap ??
        roundBestPrediction.backtest.top6Overlap;
      const bestForwardOverlap =
        bestPrediction?.backtest.forwardOnlyTop6Overlap ??
        bestPrediction?.backtest.top6Overlap ??
        0;
      const roundStatus = masteryBacktestMode
        ? `Round ${roundNumber} complete | first-attempt ${roundForwardOverlap.toFixed(2)}/6 | best ${bestForwardOverlap.toFixed(2)}/6`
        : `Round ${roundNumber} complete | current ${roundBestOverlap}/6 | best ${Math.max(0, bestOverlap)}/6`;
      workerScope.postMessage({
        requestId,
        type: "round_result",
        diagnostics: roundBestPrediction.backtest.finalDiagnostics,
        prediction: roundBestPrediction,
        round: roundNumber,
        percent: currentPercent,
        stage: roundStatus,
      });

      reportProgress(
        currentPercent,
        roundStatus,
      );

      if (bestOverlap >= targetSequenceMatch && bestPrediction) {
        reportProgress(99, `Target reached (${bestOverlap}/6). Publishing.`);
        workerScope.postMessage({
          requestId,
          type: "result",
          diagnostics: bestPrediction.backtest.finalDiagnostics,
          prediction: bestPrediction,
        });
        return;
      }

      round++;
      reportProgress(
        Number.isFinite(maxOptimizationRounds)
          ? Math.min(97, 24 + (round / maxOptimizationRounds) * 68)
          : 30,
        `Continuing optimization... best overlap ${Math.max(0, bestOverlap)}/6`,
      );
      await yieldToEventLoop();
    }

    if (requestToken !== activeRequestToken || requestId !== activeRequestId) {
      return;
    }
    if (!bestPrediction) {
      throw new Error("Continuous optimization did not produce any prediction.");
    }

    reportProgress(99, "Optimization cap reached. Publishing best result.");
    workerScope.postMessage({
      requestId,
      type: "result",
      diagnostics: bestPrediction.backtest.finalDiagnostics,
      prediction: bestPrediction,
    });
  };

  void handleRequest().catch((error) => {
    if (requestToken !== activeRequestToken || requestId !== activeRequestId) {
      return;
    }
    workerScope.postMessage({
      requestId,
      type: "error",
      error:
        error instanceof Error
          ? error.message
          : "Unknown error while running prediction worker.",
    });
  });
};
