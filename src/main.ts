import * as XLSX from "xlsx";
import { type DrawRecord, runFullDiagnostics, getGroup } from "./analysis";
import {
  refreshPredictionCandidates,
  runPrediction,
  type ModelSettings,
  type PredictionLiveTrace,
  type PredictionOutput,
  type WeightProfile,
} from "./predictor";
import type {
  PredictionWorkerRequest,
  PredictionWorkerResponse,
} from "./predictionWorkerTypes";

interface LottoResult {
  [key: string]: string;
}

type DiagnosticsSnapshot = ReturnType<typeof runFullDiagnostics>;

interface PersistedLearningState {
  version: 1;
  updatedAt: string;
  drawCount: number;
  poolSize: number;
  dataSignature: string;
  score: number;
  bestProfile: WeightProfile;
  profileOverlaps: Record<string, number>;
}

class LottoViewer {
  private static readonly MAX_ALLOWED_BALL = 58;
  private static readonly MIN_PREDICTION_DRAWS = 120;
  private rawData: LottoResult[] = [];
  private filteredData: LottoResult[] = [];
  private headers: string[] = [];
  private drawRecords: DrawRecord[] = [];
  private poolSize: number = 52;
  private predictionTimer: number | null = null;
  private workerFirstResponseTimer: number | null = null;
  private workerFirstResponseRequestId: number | null = null;
  private predictionWorker: Worker | null = null;
  private predictionRequestId: number = 0;
  private latestPredictionRequestId: number = 0;
  private latestPredictionSnapshot: PredictionOutput | null = null;
  private latestDiagnosticsSnapshot: DiagnosticsSnapshot | null = null;
  private activeWarmLearningState: PersistedLearningState | null = null;
  private activePredictionAction: "idle" | "training" | "refreshing" = "idle";

  // DOM Elements
  private fileInput = document.getElementById("fileInput") as HTMLInputElement;
  private fileNameDisplay = document.getElementById(
    "fileNameDisplay",
  ) as HTMLSpanElement;
  private tableHeader = document.getElementById("tableHeader") as HTMLElement;
  private tableBody = document.getElementById("tableBody") as HTMLElement;
  private searchInput = document.getElementById(
    "searchInput",
  ) as HTMLInputElement;
  private dateFrom = document.getElementById("dateFrom") as HTMLInputElement;
  private dateTo = document.getElementById("dateTo") as HTMLInputElement;
  private sortOrder = document.getElementById("sortOrder") as HTMLSelectElement;
  private loader = document.getElementById("loader") as HTMLElement;
  private noData = document.getElementById("noData") as HTMLDivElement;
  private rerunBtn = document.getElementById(
    "rerunPrediction",
  ) as HTMLButtonElement;
  private generateCandidatesBtn = document.getElementById(
    "generateCandidatesBtn",
  ) as HTMLButtonElement | null;
  private exportDiagnosticsBtn = document.getElementById(
    "exportDiagnosticsBtn",
  ) as HTMLButtonElement | null;
  private predictionWarning = document.getElementById(
    "predictionWarning",
  ) as HTMLDivElement | null;
  private predictionWarningText = document.getElementById(
    "predictionWarningText",
  ) as HTMLDivElement | null;
  private predictionProgressWrap = document.getElementById(
    "predictionProgressWrap",
  ) as HTMLDivElement | null;
  private predictionProgressTrack = document.getElementById(
    "predictionProgressTrack",
  ) as HTMLDivElement | null;
  private predictionProgressBar = document.getElementById(
    "predictionProgressBar",
  ) as HTMLDivElement | null;
  private liveTrainingTracePanel = document.getElementById(
    "liveTrainingTracePanel",
  ) as HTMLDivElement | null;
  private liveTrainingTraceContent = document.getElementById(
    "liveTrainingTraceContent",
  ) as HTMLDivElement | null;

  // Rule Checkboxes
  private rules = {
    ranges: document.getElementById("ruleNumberRanges") as HTMLInputElement,
    bonus: document.getElementById("ruleBonusBall") as HTMLInputElement,
    jackpot: document.getElementById("ruleJackpot") as HTMLInputElement,
    special: document.getElementById("ruleSpecialDates") as HTMLInputElement,
  };

  // DOM Elements for Manual Entry
  private manualNums = [
    document.getElementById("num1") as HTMLInputElement,
    document.getElementById("num2") as HTMLInputElement,
    document.getElementById("num3") as HTMLInputElement,
    document.getElementById("num4") as HTMLInputElement,
    document.getElementById("num5") as HTMLInputElement,
    document.getElementById("num6") as HTMLInputElement,
  ];
  private manualBonus = document.getElementById(
    "manualBonus",
  ) as HTMLInputElement;
  private addManualBtn = document.getElementById(
    "addManualBtn",
  ) as HTMLButtonElement;
  private clearDataBtn = document.getElementById(
    "clearDataBtn",
  ) as HTMLButtonElement;
  private tableStats = document.getElementById(
    "tableStats",
  ) as HTMLDivElement | null;
  private exportCsvBtn = document.getElementById(
    "exportCsvBtn",
  ) as HTMLButtonElement | null;
  private applyModelSettingsBtn = document.getElementById(
    "applyModelSettingsBtn",
  ) as HTMLButtonElement | null;
  private stopTrainingBtn = document.getElementById(
    "stopTrainingBtn",
  ) as HTMLButtonElement | null;
  private settingTrainRatio = document.getElementById(
    "settingTrainRatio",
  ) as HTMLInputElement | null;
  private settingBacktestRefresh = document.getElementById(
    "settingBacktestRefresh",
  ) as HTMLInputElement | null;
  private settingTargetLatencyMs = document.getElementById(
    "settingTargetLatencyMs",
  ) as HTMLInputElement | null;
  private settingFastMode = document.getElementById(
    "settingFastMode",
  ) as HTMLInputElement | null;
  private settingContinuousTraining = document.getElementById(
    "settingContinuousTraining",
  ) as HTMLInputElement | null;
  private settingTargetSequenceMatch = document.getElementById(
    "settingTargetSequenceMatch",
  ) as HTMLInputElement | null;
  private settingMaxOptimizationRounds = document.getElementById(
    "settingMaxOptimizationRounds",
  ) as HTMLInputElement | null;
  private settingMasteryBacktestMode = document.getElementById(
    "settingMasteryBacktestMode",
  ) as HTMLInputElement | null;
  private settingMasteryMaxAttemptsPerSequence = document.getElementById(
    "settingMasteryMaxAttemptsPerSequence",
  ) as HTMLInputElement | null;
  private settingMasteryGlobalAttemptCap = document.getElementById(
    "settingMasteryGlobalAttemptCap",
  ) as HTMLInputElement | null;
  private settingMasteryProgressEveryAttempts = document.getElementById(
    "settingMasteryProgressEveryAttempts",
  ) as HTMLInputElement | null;
  private settingEnableMonteCarlo = document.getElementById(
    "settingEnableMonteCarlo",
  ) as HTMLInputElement | null;
  private settingEnableGenetic = document.getElementById(
    "settingEnableGenetic",
  ) as HTMLInputElement | null;
  private settingEnableHistoricalEcho = document.getElementById(
    "settingEnableHistoricalEcho",
  ) as HTMLInputElement | null;
  private settingEnableSlidingWindow = document.getElementById(
    "settingEnableSlidingWindow",
  ) as HTMLInputElement | null;
  private settingMonteCarloMin = document.getElementById(
    "settingMonteCarloMin",
  ) as HTMLInputElement | null;
  private settingMonteCarloMax = document.getElementById(
    "settingMonteCarloMax",
  ) as HTMLInputElement | null;
  private settingGeneticGenerations = document.getElementById(
    "settingGeneticGenerations",
  ) as HTMLInputElement | null;
  private settingGeneticPopulation = document.getElementById(
    "settingGeneticPopulation",
  ) as HTMLInputElement | null;

  private STORAGE_KEY = "lotto_viewer_data";
  private MODEL_SETTINGS_KEY = "lotto_model_settings_v1";
  private LEARNING_STATE_KEY = "lotto_learning_state_v1";

  constructor() {
    this.initPredictionWorker();
    this.initEvents();
    this.setTrainingControls(false);
    this.setDiagnosticsExportEnabled(false);
    this.loadModelSettingsFromStorage();
    this.setPredictionStatus("Load enough draws to start training.", {
      showProgress: false,
    });
    this.loadFromSessionStorage();
  }

  private initPredictionWorker() {
    try {
      this.predictionWorker = new Worker(
        new URL("./prediction.worker.ts", import.meta.url),
        { type: "module" },
      );

      this.predictionWorker.addEventListener(
        "message",
        (event: MessageEvent<PredictionWorkerResponse>) => {
          this.handlePredictionWorkerResponse(event.data);
        },
      );

      this.predictionWorker.addEventListener("error", (event) => {
        console.error("Prediction worker failed:", event);
        this.predictionWorker = null;
      });
    } catch (error) {
      console.error("Failed to initialize prediction worker:", error);
      this.predictionWorker = null;
    }
  }

  private handlePredictionWorkerResponse(response: PredictionWorkerResponse) {
    if (response.requestId !== this.latestPredictionRequestId) {
      return;
    }
    if (this.workerFirstResponseRequestId === response.requestId) {
      this.clearWorkerFirstResponseTimer();
    }

    if (response.type === "progress") {
      if (response.stage === "Training stopped.") {
        this.activePredictionAction = "idle";
        this.setTrainingControls(false);
        this.setPredictionStatus("Training stopped.", { showProgress: false });
        return;
      }
      this.updatePredictionProgress(response.percent, response.stage);
      return;
    }

    if (response.type === "trace") {
      this.renderLiveTrainingTrace(response.trace, response.percent);
      return;
    }

    if (response.type === "round_result") {
      this.applyPredictionResult(response.diagnostics, response.prediction, {
        suppressStatusUpdate: true,
      });
      this.updatePredictionProgress(response.percent, response.stage);
      return;
    }

    if (response.type === "refresh_result") {
      this.activePredictionAction = "idle";
      this.setTrainingControls(false);
      this.applyPredictionResult(response.diagnostics, response.prediction);
      return;
    }

    if (response.type === "error") {
      this.activePredictionAction = "idle";
      this.setTrainingControls(false);
      console.error("Prediction worker error:", response.error);
      this.setPredictionStatus("Prediction failed. Check console for details.", {
        showProgress: false,
      });
      return;
    }

    this.activePredictionAction = "idle";
    this.setTrainingControls(false);
    this.applyPredictionResult(response.diagnostics, response.prediction);
  }

  private clearWorkerFirstResponseTimer() {
    if (this.workerFirstResponseTimer !== null) {
      window.clearTimeout(this.workerFirstResponseTimer);
      this.workerFirstResponseTimer = null;
    }
    this.workerFirstResponseRequestId = null;
  }

  private armWorkerFirstResponseTimer(
    requestId: number,
    onTimeout: () => void,
    timeoutMs = 4500,
  ) {
    this.clearWorkerFirstResponseTimer();
    this.workerFirstResponseRequestId = requestId;
    this.workerFirstResponseTimer = window.setTimeout(() => {
      this.workerFirstResponseTimer = null;
      if (this.workerFirstResponseRequestId !== requestId) return;
      this.workerFirstResponseRequestId = null;
      onTimeout();
    }, timeoutMs);
  }

  private setPredictionStatus(
    message: string,
    options: { showProgress: boolean; percent?: number },
  ) {
    if (this.predictionWarningText) {
      this.predictionWarningText.textContent = message;
    } else if (this.predictionWarning) {
      this.predictionWarning.textContent = message;
    }

    if (!this.predictionProgressWrap || !this.predictionProgressBar) return;

    if (options.showProgress) {
      this.predictionProgressWrap.classList.remove("hidden");
      const clamped = Math.max(0, Math.min(100, Math.round(options.percent || 0)));
      this.predictionProgressBar.style.width = `${clamped}%`;
      this.predictionProgressTrack?.setAttribute(
        "aria-valuenow",
        String(clamped),
      );
    } else {
      this.predictionProgressWrap.classList.add("hidden");
      this.predictionProgressBar.style.width = "0%";
      this.predictionProgressTrack?.setAttribute("aria-valuenow", "0");
    }
  }

  private updatePredictionProgress(percent: number, stage: string) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const prefix =
      this.activePredictionAction === "refreshing"
        ? "Refreshing candidates..."
        : "Training model...";
    this.setPredictionStatus(`${prefix} ${clamped}% | ${stage}`, {
      showProgress: true,
      percent: clamped,
    });
  }

  private renderLiveTrainingTrace(trace: PredictionLiveTrace, percent = 0) {
    if (!this.liveTrainingTracePanel || !this.liveTrainingTraceContent) return;
    this.liveTrainingTracePanel.classList.remove("hidden");

    const actualSorted = [...trace.actual].sort((a, b) => a - b);
    const predictedSorted = [...trace.predicted].sort((a, b) => a - b);
    const actualSet = new Set<number>(actualSorted);
    if (trace.bonus > 0) actualSet.add(trace.bonus);

    const phaseTitle =
      trace.phase === "mastery_attempt"
        ? "Live Mastery Attempt"
        : "Live Validation Row";
    const attemptText =
      trace.attemptsUsed !== undefined
        ? trace.attemptCap && Number.isFinite(trace.attemptCap)
          ? `Attempt ${trace.attemptsUsed}/${trace.attemptCap}`
          : `Attempt ${trace.attemptsUsed}`
        : "Single-pass";
    const profileText = trace.profileName
      ? `<span class="trace-chip">Profile: ${trace.profileName}</span>`
      : "";
    const bestText =
      trace.bestOverlap !== undefined
        ? `<span class="trace-chip">Best: ${trace.bestOverlap}/6</span>`
        : "";

    this.liveTrainingTraceContent.innerHTML = `
      <div class="trace-meta-row">
        <span class="trace-chip">${phaseTitle}</span>
        <span class="trace-chip">Progress: ${Math.max(0, Math.min(100, Math.round(percent)))}%</span>
        <span class="trace-chip">Row: ${trace.sequenceIndex}/${trace.sequenceTotal}</span>
        <span class="trace-chip">${attemptText}</span>
        ${bestText}
        ${profileText}
      </div>
      <div class="trace-meta-row">
        <span class="trace-chip">Date: ${trace.date}</span>
        <span class="trace-chip">Current Overlap: ${trace.overlap}/6</span>
      </div>
      <div class="trace-grid">
        <div class="trace-col">
          <h5>Actual (6 + Bonus)</h5>
          <div class="mini-ball-row">
            ${actualSorted.map((n) => `<div class="mini-ball">${n}</div>`).join("")}
            ${
              trace.bonus > 0
                ? `<div class="mini-ball" style="border-color: rgba(223,190,135,0.6); color: var(--highlight-bonus);">B${trace.bonus}</div>`
                : ""
            }
          </div>
        </div>
        <div class="trace-col">
          <h5>Predicted</h5>
          <div class="mini-ball-row">
            ${predictedSorted
              .map(
                (n) =>
                  `<div class="mini-ball ${actualSet.has(n) ? "match" : ""}">${n}</div>`,
              )
              .join("")}
          </div>
        </div>
      </div>
    `;
  }

  private syncGenerateCandidatesControl() {
    if (!this.generateCandidatesBtn) return;
    const busy = this.activePredictionAction !== "idle";
    const canGenerate =
      !busy &&
      this.latestPredictionSnapshot !== null &&
      this.drawRecords.length >= LottoViewer.MIN_PREDICTION_DRAWS;
    this.generateCandidatesBtn.disabled = !canGenerate;
    this.generateCandidatesBtn.textContent =
      this.activePredictionAction === "refreshing"
        ? "Generating..."
        : "Generate Candidates";
  }

  private setTrainingControls(training: boolean) {
    if (!training) {
      this.activePredictionAction = "idle";
    }
    const trainingRun = training && this.activePredictionAction === "training";

    if (this.rerunBtn) {
      this.rerunBtn.disabled = training;
      this.rerunBtn.textContent = trainingRun ? "Running..." : "⟳ Rerun";
    }
    if (this.applyModelSettingsBtn) {
      this.applyModelSettingsBtn.disabled = training;
    }
    if (this.stopTrainingBtn) {
      this.stopTrainingBtn.disabled = !trainingRun;
    }
    this.setDiagnosticsExportEnabled(
      !training &&
        this.latestPredictionSnapshot !== null &&
        this.latestDiagnosticsSnapshot !== null,
    );
    this.syncGenerateCandidatesControl();
  }

  private setDiagnosticsExportEnabled(enabled: boolean) {
    if (!this.exportDiagnosticsBtn) return;
    this.exportDiagnosticsBtn.disabled = !enabled;
    this.exportDiagnosticsBtn.title = enabled
      ? "Download current training diagnostics as JSON."
      : "Run training to enable diagnostics export.";
  }

  private parseOptionalNumber(input: HTMLInputElement | null): number | undefined {
    if (!input) return undefined;
    const raw = input.value.trim();
    if (!raw) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private getModelSettings(): ModelSettings {
    return {
      trainRatio: this.parseOptionalNumber(this.settingTrainRatio),
      backtestRefreshEvery: this.parseOptionalNumber(this.settingBacktestRefresh),
      targetLatencyMs: this.parseOptionalNumber(this.settingTargetLatencyMs),
      fastMode: this.settingFastMode?.checked,
      continuousTraining: this.settingContinuousTraining?.checked,
      targetSequenceMatch: this.parseOptionalNumber(
        this.settingTargetSequenceMatch,
      ),
      maxOptimizationRounds: this.parseOptionalNumber(
        this.settingMaxOptimizationRounds,
      ),
      masteryBacktestMode: this.settingMasteryBacktestMode?.checked,
      masteryMaxAttemptsPerSequence: this.parseOptionalNumber(
        this.settingMasteryMaxAttemptsPerSequence,
      ),
      masteryGlobalAttemptCap: this.parseOptionalNumber(
        this.settingMasteryGlobalAttemptCap,
      ),
      masteryProgressEveryAttempts: this.parseOptionalNumber(
        this.settingMasteryProgressEveryAttempts,
      ),
      includeMonteCarlo: this.settingEnableMonteCarlo?.checked,
      includeGenetic: this.settingEnableGenetic?.checked,
      includeHistoricalEcho: this.settingEnableHistoricalEcho?.checked,
      includeSlidingWindow: this.settingEnableSlidingWindow?.checked,
      monteCarloMinTrials: this.parseOptionalNumber(this.settingMonteCarloMin),
      monteCarloMaxTrials: this.parseOptionalNumber(this.settingMonteCarloMax),
      geneticGenerations: this.parseOptionalNumber(
        this.settingGeneticGenerations,
      ),
      geneticPopulation: this.parseOptionalNumber(this.settingGeneticPopulation),
    };
  }

  private getModelSettingInputs(): HTMLInputElement[] {
    return [
      this.settingTrainRatio,
      this.settingBacktestRefresh,
      this.settingTargetLatencyMs,
      this.settingFastMode,
      this.settingContinuousTraining,
      this.settingTargetSequenceMatch,
      this.settingMaxOptimizationRounds,
      this.settingMasteryBacktestMode,
      this.settingMasteryMaxAttemptsPerSequence,
      this.settingMasteryGlobalAttemptCap,
      this.settingMasteryProgressEveryAttempts,
      this.settingEnableMonteCarlo,
      this.settingEnableGenetic,
      this.settingEnableHistoricalEcho,
      this.settingEnableSlidingWindow,
      this.settingMonteCarloMin,
      this.settingMonteCarloMax,
      this.settingGeneticGenerations,
      this.settingGeneticPopulation,
    ].filter((input): input is HTMLInputElement => input !== null);
  }

  private saveModelSettingsToStorage() {
    try {
      localStorage.setItem(
        this.MODEL_SETTINGS_KEY,
        JSON.stringify(this.getModelSettings()),
      );
    } catch (error) {
      console.error("Failed to persist model settings:", error);
    }
  }

  private setNumericInputValue(
    input: HTMLInputElement | null,
    value: number | undefined,
  ) {
    if (!input || value === undefined || !Number.isFinite(value)) return;
    input.value = String(value);
  }

  private setBooleanInputValue(
    input: HTMLInputElement | null,
    value: boolean | undefined,
  ) {
    if (!input || value === undefined) return;
    input.checked = Boolean(value);
  }

  private loadModelSettingsFromStorage() {
    try {
      const raw = localStorage.getItem(this.MODEL_SETTINGS_KEY);
      if (!raw) return;
      const settings = JSON.parse(raw) as ModelSettings;

      this.setNumericInputValue(this.settingTrainRatio, settings.trainRatio);
      this.setNumericInputValue(
        this.settingBacktestRefresh,
        settings.backtestRefreshEvery,
      );
      this.setNumericInputValue(
        this.settingTargetLatencyMs,
        settings.targetLatencyMs,
      );
      this.setBooleanInputValue(this.settingFastMode, settings.fastMode);
      this.setBooleanInputValue(
        this.settingContinuousTraining,
        settings.continuousTraining,
      );
      this.setNumericInputValue(
        this.settingTargetSequenceMatch,
        settings.targetSequenceMatch,
      );
      this.setNumericInputValue(
        this.settingMaxOptimizationRounds,
        settings.maxOptimizationRounds,
      );
      this.setBooleanInputValue(
        this.settingMasteryBacktestMode,
        settings.masteryBacktestMode,
      );
      this.setNumericInputValue(
        this.settingMasteryMaxAttemptsPerSequence,
        settings.masteryMaxAttemptsPerSequence,
      );
      this.setNumericInputValue(
        this.settingMasteryGlobalAttemptCap,
        settings.masteryGlobalAttemptCap,
      );
      this.setNumericInputValue(
        this.settingMasteryProgressEveryAttempts,
        settings.masteryProgressEveryAttempts,
      );
      this.setBooleanInputValue(
        this.settingEnableMonteCarlo,
        settings.includeMonteCarlo,
      );
      this.setBooleanInputValue(
        this.settingEnableGenetic,
        settings.includeGenetic,
      );
      this.setBooleanInputValue(
        this.settingEnableHistoricalEcho,
        settings.includeHistoricalEcho,
      );
      this.setBooleanInputValue(
        this.settingEnableSlidingWindow,
        settings.includeSlidingWindow,
      );
      this.setNumericInputValue(
        this.settingMonteCarloMin,
        settings.monteCarloMinTrials,
      );
      this.setNumericInputValue(
        this.settingMonteCarloMax,
        settings.monteCarloMaxTrials,
      );
      this.setNumericInputValue(
        this.settingGeneticGenerations,
        settings.geneticGenerations,
      );
      this.setNumericInputValue(
        this.settingGeneticPopulation,
        settings.geneticPopulation,
      );
    } catch (error) {
      console.error("Failed to restore model settings:", error);
    }
  }

  private initEvents() {
    this.fileInput.addEventListener("change", (e) => this.handleFileUpload(e));
    this.searchInput.addEventListener("input", () => this.applyFilters());
    this.dateFrom.addEventListener("change", () => this.applyFilters());
    this.dateTo.addEventListener("change", () => this.applyFilters());
    this.sortOrder.addEventListener("change", () => this.applyFilters());

    Object.values(this.rules).forEach((checkbox) => {
      checkbox.addEventListener("change", () => this.renderTable());
    });

    if (this.rerunBtn) {
      this.rerunBtn.addEventListener("click", () => this.handleRerun());
    }
    if (this.generateCandidatesBtn) {
      this.generateCandidatesBtn.addEventListener("click", () =>
        this.handleGenerateCandidates(),
      );
    }

    if (this.addManualBtn) {
      this.addManualBtn.addEventListener("click", () =>
        this.handleAddManualRecord(),
      );
    }

    if (this.clearDataBtn) {
      this.clearDataBtn.addEventListener("click", () => this.handleClearData());
    }

    if (this.exportCsvBtn) {
      this.exportCsvBtn.addEventListener("click", () => this.handleExportCsv());
    }
    if (this.exportDiagnosticsBtn) {
      this.exportDiagnosticsBtn.addEventListener("click", () =>
        this.handleExportDiagnostics(),
      );
    }

    if (this.applyModelSettingsBtn) {
      this.applyModelSettingsBtn.addEventListener("click", () =>
        this.handleRerun(),
      );
    }

    if (this.stopTrainingBtn) {
      this.stopTrainingBtn.addEventListener("click", () =>
        this.handleStopTraining(),
      );
    }

    this.getModelSettingInputs().forEach((input) => {
      const eventName = input.type === "checkbox" ? "change" : "input";
      input.addEventListener(eventName, () => this.saveModelSettingsToStorage());
      if (eventName !== "change") {
        input.addEventListener("change", () => this.saveModelSettingsToStorage());
      }
    });
  }

  private handleStopTraining() {
    const cancelRequestId = ++this.predictionRequestId;
    this.latestPredictionRequestId = cancelRequestId;
    this.clearWorkerFirstResponseTimer();

    if (this.predictionTimer !== null) {
      window.clearTimeout(this.predictionTimer);
      this.predictionTimer = null;
    }

    if (this.predictionWorker) {
      this.predictionWorker.postMessage({
        requestId: cancelRequestId,
        type: "cancel",
      });
    }

    this.setTrainingControls(false);
    this.setPredictionStatus("Training stopped.", { showProgress: false });
  }

  private runCandidateRefreshOnMainThread(
    requestId: number,
    baseDiagnostics: DiagnosticsSnapshot,
    basePrediction: PredictionOutput,
    modelSettings: ModelSettings,
  ) {
    window.setTimeout(() => {
      try {
        this.updatePredictionProgress(8, "Refreshing candidates on main thread");
        const prediction = refreshPredictionCandidates(
          this.drawRecords,
          baseDiagnostics,
          {
            onProgress: (progress, stage) => {
              this.updatePredictionProgress(10 + progress * 88, stage);
            },
            settings: modelSettings,
            basePrediction,
          },
        );
        if (requestId !== this.latestPredictionRequestId) return;
        this.activePredictionAction = "idle";
        this.setTrainingControls(false);
        this.applyPredictionResult(prediction.backtest.finalDiagnostics, prediction);
      } catch (error) {
        if (requestId !== this.latestPredictionRequestId) return;
        console.error("Candidate refresh fallback failed:", error);
        this.activePredictionAction = "idle";
        this.setTrainingControls(false);
        this.setPredictionStatus(
          "Candidate refresh failed on the main thread. Check console for details.",
          {
            showProgress: false,
          },
        );
      }
    }, 0);
  }

  private async handleFileUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.fileNameDisplay.textContent = file.name;
    this.showLoader(true);

    try {
      if (this.isDelimitedTextFile(file)) {
        const text = await file.text();
        this.rawData = this.parseDelimitedTextToRows(text);
      } else {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: "array" });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        this.rawData = XLSX.utils.sheet_to_json(worksheet, {
          raw: false,
          defval: "",
        });
      }

      if (this.rawData.length === 0) {
        alert("No rows were detected in the selected file.");
        return;
      }

      this.headers = Object.keys(this.rawData[0]);
      this.saveToSessionStorage();
      this.parseDrawRecords();
      this.applyFilters();
      this.schedulePredictionEngine(25);
    } catch (error) {
      console.error("Error parsing uploaded file:", error);
      alert(
        "Failed to parse selected file. Supported formats: XLSX, XLS, CSV, TXT.",
      );
    } finally {
      this.showLoader(false);
      // Allows selecting the same file again to retrigger parsing.
      input.value = "";
    }
  }

  private isDelimitedTextFile(file: File): boolean {
    const lowerName = file.name.toLowerCase();
    return lowerName.endsWith(".csv") || lowerName.endsWith(".txt");
  }

  private parseDelimitedTextToRows(text: string): LottoResult[] {
    const delimiter = this.detectDelimiter(text);
    const rows = this.parseCsvRows(text, delimiter);
    if (rows.length < 2) return [];

    const headerRowIndex = rows.findIndex((r) =>
      r.some((cell) => cell.trim() !== ""),
    );
    if (headerRowIndex < 0 || headerRowIndex >= rows.length - 1) return [];

    const headers = this.makeUniqueHeaders(
      rows[headerRowIndex].map((h, i) => this.sanitizeHeader(h, i)),
    );
    const result: LottoResult[] = [];

    for (let r = headerRowIndex + 1; r < rows.length; r++) {
      const cells = rows[r];
      if (cells.every((c) => c.trim() === "")) continue;

      const record: LottoResult = {};
      const maxCols = Math.max(headers.length, cells.length);
      for (let c = 0; c < maxCols; c++) {
        const header = headers[c] || `Column${c + 1}`;
        record[header] = (cells[c] ?? "").trim();
      }
      result.push(record);
    }

    return result;
  }

  private detectDelimiter(text: string): string {
    const normalized = text.replace(/^\uFEFF/, "");
    const lines = normalized
      .split(/\r\n|\n|\r/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, 5);

    if (lines.length === 0) return ",";

    const candidates = [",", ";", "\t", "|"];
    let bestDelimiter = ",";
    let bestScore = -1;

    for (const delimiter of candidates) {
      const counts = lines.map((line) =>
        this.countFieldsForDelimiter(line, delimiter),
      );
      const score = counts.reduce((acc, c) => acc + c, 0);
      const hasStructuredColumns = counts.some((c) => c > 1);

      if (hasStructuredColumns && score > bestScore) {
        bestScore = score;
        bestDelimiter = delimiter;
      }
    }

    return bestDelimiter;
  }

  private countFieldsForDelimiter(line: string, delimiter: string): number {
    let fields = 1;
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      if (ch === '"') {
        if (inQuotes && next === '"') {
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (!inQuotes && ch === delimiter) fields++;
    }

    return fields;
  }

  private makeUniqueHeaders(headers: string[]): string[] {
    const seen = new Map<string, number>();
    return headers.map((h, i) => {
      const base = h || `Column${i + 1}`;
      const count = seen.get(base) || 0;
      seen.set(base, count + 1);
      return count === 0 ? base : `${base}_${count + 1}`;
    });
  }

  private parseCsvRows(text: string, delimiter: string): string[][] {
    const normalized = text.replace(/^\uFEFF/, "");
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    const pushField = () => {
      row.push(field);
      field = "";
    };

    const pushRow = () => {
      pushField();
      rows.push(row);
      row = [];
    };

    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      const next = normalized[i + 1];

      if (ch === '"') {
        if (inQuotes && next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (!inQuotes && ch === delimiter) {
        pushField();
        continue;
      }

      if (!inQuotes && (ch === "\n" || ch === "\r")) {
        if (ch === "\r" && next === "\n") i++;
        pushRow();
        continue;
      }

      field += ch;
    }

    if (field.length > 0 || row.length > 0) {
      pushRow();
    }

    while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) {
      rows.pop();
    }

    return rows;
  }

  private sanitizeHeader(header: string, index: number): string {
    const clean = header.trim();
    if (!clean) return `Column${index + 1}`;
    return clean.replace(/^\uFEFF/, "");
  }

  private saveToSessionStorage() {
    sessionStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.rawData));
  }

  private loadFromSessionStorage() {
    const stored = sessionStorage.getItem(this.STORAGE_KEY);
    if (stored) {
      try {
        this.rawData = JSON.parse(stored);
        if (this.rawData.length > 0) {
          this.headers = Object.keys(this.rawData[0]);
          this.parseDrawRecords();
          this.applyFilters();
          this.runPredictionEngine();
        }
      } catch (e) {
        console.error("Error loading from sessionStorage:", e);
      }
    }
  }

  private normalizeWeightProfile(
    raw: WeightProfile | null | undefined,
  ): WeightProfile | null {
    if (!raw) return null;
    const keys: Array<
      keyof Omit<WeightProfile, "name">
    > = [
      "bayesian",
      "hotCold",
      "gap",
      "pair",
      "triple",
      "positional",
      "transition",
      "repeat",
    ];
    const values = keys.map((key) => {
      const value = Number(raw[key]);
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(1.5, value));
    });
    const sum = values.reduce((acc, value) => acc + value, 0);
    if (sum <= 0) return null;
    const normalized = values.map((value) => value / sum);
    return {
      name:
        typeof raw.name === "string" && raw.name.trim().length > 0
          ? raw.name
          : "Persisted Warm Start",
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

  private inferPoolFromDraws(draws: DrawRecord[]): number {
    let maxBall = 52;
    for (const draw of draws) {
      for (const number of draw.numbers) {
        if (number > maxBall) maxBall = number;
      }
      if (draw.bonus > maxBall) maxBall = draw.bonus;
    }
    return Math.max(52, Math.min(LottoViewer.MAX_ALLOWED_BALL, maxBall));
  }

  private buildDrawSignature(draws: DrawRecord[]): string {
    if (draws.length === 0) return "empty";
    const first = draws[0].date;
    const last = draws[draws.length - 1].date;
    const pool = this.inferPoolFromDraws(draws);
    const sample = draws.slice(Math.max(0, draws.length - 240));
    let checksum = 0;
    for (let idx = 0; idx < sample.length; idx++) {
      const draw = sample[idx];
      checksum =
        (checksum +
          (idx + 1) * 131 +
          draw.numbers.reduce((acc, n) => acc + n * 17, 0) +
          draw.bonus * 19) >>>
        0;
    }
    return `${draws.length}:${pool}:${first}:${last}:${checksum}`;
  }

  private computePredictionLearningScore(prediction: PredictionOutput): number {
    const bt = prediction.backtest;
    return (
      bt.maxObservedOverlap * 1_000_000 +
      bt.sixMatchHits * 80_000 +
      bt.sixMatchRate * 120_000 +
      (bt.masterySolvedSequences ?? 0) * 160_000 -
      (bt.masteryTotalAttempts ?? 0) * 3 +
      bt.fourPlusHits * 6_000 +
      bt.fourPlusRate * 35_000 +
      bt.top6Overlap * 3_000 +
      bt.modelHitRate * 2_500 +
      bt.improvement * 15
    );
  }

  private loadLearningStateFromStorage(): PersistedLearningState | null {
    try {
      const raw = localStorage.getItem(this.LEARNING_STATE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedLearningState;
      if (parsed?.version !== 1) return null;
      if (!Number.isFinite(parsed.drawCount) || parsed.drawCount < 0) return null;
      if (!Number.isFinite(parsed.poolSize) || parsed.poolSize < 1) return null;
      if (!Number.isFinite(parsed.score)) return null;
      if (typeof parsed.dataSignature !== "string") return null;
      if (
        !parsed.profileOverlaps ||
        typeof parsed.profileOverlaps !== "object"
      ) {
        return null;
      }
      const normalizedProfile = this.normalizeWeightProfile(parsed.bestProfile);
      if (!normalizedProfile) return null;
      return {
        ...parsed,
        bestProfile: normalizedProfile,
      };
    } catch (error) {
      console.error("Failed to read persisted learning state:", error);
      return null;
    }
  }

  private getCompatibleWarmLearningState(): PersistedLearningState | null {
    const state = this.loadLearningStateFromStorage();
    if (!state) return null;
    if (this.drawRecords.length < LottoViewer.MIN_PREDICTION_DRAWS) return null;
    const currentPool = this.inferPoolFromDraws(this.drawRecords);
    if (state.poolSize !== currentPool) return null;
    return state;
  }

  private saveLearningStateFromPrediction(prediction: PredictionOutput) {
    const normalizedProfile = this.normalizeWeightProfile(
      prediction.backtest.finalBestProfile,
    );
    if (!normalizedProfile || this.drawRecords.length === 0) return;

    const profileOverlaps: Record<string, number> = {};
    prediction.backtest.profilePerformance.forEach((entry) => {
      if (!Number.isFinite(entry.overlap)) return;
      profileOverlaps[entry.name] = Math.max(0, entry.overlap);
    });

    const nextState: PersistedLearningState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      drawCount: this.drawRecords.length,
      poolSize: this.inferPoolFromDraws(this.drawRecords),
      dataSignature: this.buildDrawSignature(this.drawRecords),
      score: this.computePredictionLearningScore(prediction),
      bestProfile: normalizedProfile,
      profileOverlaps,
    };

    const existing = this.loadLearningStateFromStorage();
    const shouldKeepExisting =
      existing &&
      existing.poolSize === nextState.poolSize &&
      existing.dataSignature === nextState.dataSignature &&
      existing.score > nextState.score;

    if (shouldKeepExisting) {
      this.activeWarmLearningState = existing;
      return;
    }

    try {
      localStorage.setItem(this.LEARNING_STATE_KEY, JSON.stringify(nextState));
      this.activeWarmLearningState = nextState;
    } catch (error) {
      console.error("Failed to persist learning state:", error);
    }
  }

  private clearLearningStateFromStorage() {
    this.activeWarmLearningState = null;
    localStorage.removeItem(this.LEARNING_STATE_KEY);
  }

  private handleAddManualRecord() {
    // Auto-generate local date (YYYY-MM-DD)
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const date = `${year}-${month}-${day}`;

    const numbers = this.manualNums.map((input) => parseInt(input.value));
    if (
      numbers.some(
        (n) =>
          isNaN(n) || n < 1 || n > LottoViewer.MAX_ALLOWED_BALL,
      )
    ) {
      alert(
        `Please enter 6 valid numbers between 1 and ${LottoViewer.MAX_ALLOWED_BALL}.`,
      );
      return;
    }

    if (new Set(numbers).size !== numbers.length) {
      alert("Manual entry numbers must be unique.");
      return;
    }

    const bonus = parseInt(this.manualBonus.value);
    if (
      isNaN(bonus) ||
      bonus < 1 ||
      bonus > LottoViewer.MAX_ALLOWED_BALL
    ) {
      alert(
        `Please enter a bonus ball between 1 and ${LottoViewer.MAX_ALLOWED_BALL}.`,
      );
      return;
    }

    if (numbers.includes(bonus)) {
      alert("Bonus ball cannot duplicate one of the main numbers.");
      return;
    }

    // Try to find if we have headers, if not, create them
    if (this.headers.length === 0) {
      this.headers = [
        "Date",
        "Number1",
        "Number2",
        "Number3",
        "Number4",
        "Number5",
        "Number6",
        "Bonus",
      ];
    }

    // Map to the existing row structure if possible
    const newRow: LottoResult = {};
    const dateKey =
      this.headers.find((h) => h.toLowerCase().includes("date")) || "Date";
    newRow[dateKey] = date;

    const bonusKey =
      this.headers.find((h) => this.isBonusHeader(h)) || "Bonus";
    newRow[bonusKey] = bonus.toString();

    // Map numbers to detected number columns first.
    const numKeys = this.getMainNumberHeaders(this.headers);
    numbers
      .sort((a, b) => a - b)
      .forEach((n, i) => {
        const key = numKeys[i] || `Number${i + 1}`;
        newRow[key] = n.toString();
        if (!this.headers.includes(key)) this.headers.push(key);
      });

    // Handle missing header keys if any
    if (!this.headers.includes(dateKey)) this.headers.push(dateKey);
    if (!this.headers.includes(bonusKey)) this.headers.push(bonusKey);

    this.rawData.push(newRow);
    this.saveToSessionStorage();

    // If this was the first record, we need to ensure headers are set for rendering
    if (this.rawData.length === 1) {
      this.headers = Object.keys(newRow);
    }

    this.parseDrawRecords();
    this.applyFilters();
    this.schedulePredictionEngine();

    // Clear inputs
    this.manualNums.forEach((input) => (input.value = ""));
    this.manualBonus.value = "";

    console.log("Manual record added:", newRow);
  }

  private handleClearData() {
    if (
      confirm("Are you sure you want to clear ALL data? This cannot be undone.")
    ) {
      if (this.predictionWorker) {
        this.predictionWorker.postMessage({
          requestId: this.latestPredictionRequestId,
          type: "cancel",
        });
      }
      this.latestPredictionRequestId = ++this.predictionRequestId;
      sessionStorage.removeItem(this.STORAGE_KEY);
      this.clearLearningStateFromStorage();
      this.rawData = [];
      this.filteredData = [];
      this.drawRecords = [];
      this.headers = [];
      this.latestPredictionSnapshot = null;
      this.latestDiagnosticsSnapshot = null;
      this.setDiagnosticsExportEnabled(false);
      this.setTrainingControls(false);
      this.renderTable();
      document.getElementById("predictionPanel")!.classList.add("hidden");
    }
  }

  private handleDeleteRow(rawDataIndex: number) {
    if (confirm("Delete this record?")) {
      this.rawData.splice(rawDataIndex, 1);
      this.saveToSessionStorage();
      this.parseDrawRecords();
      this.applyFilters();
      this.schedulePredictionEngine();
    }
  }

  private parseDrawRecords() {
    const mainNumberHeaders = this.getMainNumberHeaders(this.headers);
    this.drawRecords = this.rawData
      .map((row) => {
        const numbers =
          mainNumberHeaders.length > 0
            ? this.collectNumbersFromKnownHeaders(row, mainNumberHeaders)
            : this.collectMainNumbersFromRowFallback(row);
        if (numbers.length < 6) {
          const fallback = this.collectMainNumbersFromRowFallback(row).filter(
            (n) => !numbers.includes(n),
          );
          numbers.push(...fallback.slice(0, 6 - numbers.length));
        }
        let bonus = 0;
        const dateVal = this.findDateValue(row) || "";

        for (const [key, rawVal] of Object.entries(row)) {
          if (this.isBonusHeader(key)) {
            const parsedBonus = this.parseBallValue(rawVal);
            bonus = parsedBonus ?? 0;
            break;
          }
        }

        const parsedDate = this.parseDateValue(dateVal);
        const date = parsedDate ? this.toIsoDate(parsedDate) : dateVal;
        return { date, numbers: [...numbers].sort((a, b) => a - b), bonus };
      })
      .filter((d) => {
        const hasValidDate = this.parseDateValue(d.date) !== null;
        const hasValidNumbers =
          d.numbers.length === 6 &&
          new Set(d.numbers).size === 6 &&
          d.numbers.every((n) => n >= 1 && n <= LottoViewer.MAX_ALLOWED_BALL);
        const hasValidBonus =
          d.bonus === 0 ||
          (d.bonus >= 1 && d.bonus <= LottoViewer.MAX_ALLOWED_BALL);
        return hasValidDate && hasValidNumbers && hasValidBonus;
      })
      .sort(
        (a, b) =>
          (this.parseDateValue(a.date)?.getTime() || 0) -
          (this.parseDateValue(b.date)?.getTime() || 0),
      );
  }

  private applyFilters() {
    const searchTerm = this.searchInput.value.toLowerCase();
    const from = this.dateFrom.value;
    const to = this.dateTo.value;
    const sort = this.sortOrder.value;

    this.filteredData = this.rawData.filter((row) => {
      const matchesSearch = Object.values(row).some((val) =>
        String(val).toLowerCase().includes(searchTerm),
      );

      const dateVal = this.findDateValue(row);
      let matchesDate = true;
      if (dateVal) {
        const drawDate = this.parseDateValue(dateVal);
        if (drawDate) {
          if (from) {
            const fromDate = new Date(`${from}T00:00:00`);
            if (drawDate < fromDate) matchesDate = false;
          }
          if (to) {
            const toDate = new Date(`${to}T23:59:59`);
            if (drawDate > toDate) matchesDate = false;
          }
        }
      }

      return matchesSearch && matchesDate;
    });

    this.filteredData.sort((a, b) => {
      const dateA = this.parseDateValue(this.findDateValue(a))?.getTime() || 0;
      const dateB = this.parseDateValue(this.findDateValue(b))?.getTime() || 0;
      return sort === "desc" ? dateB - dateA : dateA - dateB;
    });

    this.renderTable();
  }

  private findDateValue(row: LottoResult): string | null {
    const keys = Object.keys(row);
    const dateKey =
      keys.find((k) => this.isDateHeader(k)) ||
      keys.find((k) => k.toLowerCase().includes("drawdate")) ||
      keys[0];
    return row[dateKey];
  }

  private getMainNumberHeaders(headers: string[]): string[] {
    const candidates = headers
      .filter((h) => this.isMainNumberHeader(h))
      .map((header, pos) => ({
        header,
        pos,
        order: this.extractHeaderNumberIndex(header),
      }))
      .sort((a, b) => a.order - b.order || a.pos - b.pos)
      .map((x) => x.header);

    if (candidates.length >= 6) return candidates.slice(0, 6);
    return candidates;
  }

  private isMainNumberHeader(header: string): boolean {
    if (this.isDateHeader(header) || this.isBonusHeader(header)) return false;
    const normalized = header.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (
      /^(number|num|n|ball)\d+$/.test(normalized) ||
      /^winningnumber\d*$/.test(normalized) ||
      /^main\d+$/.test(normalized)
    );
  }

  private isDateHeader(header: string): boolean {
    const h = header.toLowerCase();
    return /\bdate\b/.test(h) || h.includes("drawdate");
  }

  private isBonusHeader(header: string): boolean {
    return /\bbonus\b/.test(header.toLowerCase());
  }

  private extractHeaderNumberIndex(header: string): number {
    const match = header.match(/\d+/);
    return match ? parseInt(match[0], 10) : Number.MAX_SAFE_INTEGER;
  }

  private collectNumbersFromKnownHeaders(
    row: LottoResult,
    headers: string[],
  ): number[] {
    const values: number[] = [];
    for (const header of headers) {
      const parsed = this.parseBallValue(row[header]);
      if (parsed !== null) values.push(parsed);
    }
    return values;
  }

  private collectMainNumbersFromRowFallback(row: LottoResult): number[] {
    const values: number[] = [];
    for (const [key, rawVal] of Object.entries(row)) {
      if (this.isDateHeader(key) || this.isBonusHeader(key)) continue;
      if (this.shouldSkipAsMetadataKey(key)) continue;
      const parsed = this.parseBallValue(rawVal);
      if (parsed !== null) values.push(parsed);
    }
    return values.slice(0, 6);
  }

  private shouldSkipAsMetadataKey(key: string): boolean {
    const h = key.toLowerCase();
    return (
      /\b(day|jackpot|outcome|prize|payout|id|result|ticket)\b/.test(h) ||
      /\bdraw(no|number)?\b/.test(h)
    );
  }

  private parseBallValue(value: string | undefined): number | null {
    const n = parseInt(String(value ?? "").trim(), 10);
    if (!Number.isFinite(n)) return null;
    if (n < 1 || n > LottoViewer.MAX_ALLOWED_BALL) return null;
    return n;
  }

  private parseDateValue(value: string | null | undefined): Date | null {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    const ymd = raw.match(
      /^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:[ T].*)?$/,
    );
    if (ymd) {
      const parsed = this.makeValidDate(
        parseInt(ymd[1], 10),
        parseInt(ymd[2], 10),
        parseInt(ymd[3], 10),
      );
      if (parsed) return parsed;
    }

    const dmy = raw.match(
      /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ T].*)?$/,
    );
    if (dmy) {
      // Prefer day-first for regional lottery exports, with month-first fallback.
      const dayFirst = this.makeValidDate(
        parseInt(dmy[3], 10),
        parseInt(dmy[2], 10),
        parseInt(dmy[1], 10),
      );
      if (dayFirst) return dayFirst;

      const monthFirst = this.makeValidDate(
        parseInt(dmy[3], 10),
        parseInt(dmy[1], 10),
        parseInt(dmy[2], 10),
      );
      if (monthFirst) return monthFirst;
    }

    return null;
  }

  private makeValidDate(year: number, month: number, day: number): Date | null {
    const dt = new Date(year, month - 1, day);
    if (
      dt.getFullYear() !== year ||
      dt.getMonth() !== month - 1 ||
      dt.getDate() !== day
    ) {
      return null;
    }
    return dt;
  }

  private toIsoDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
  }

  private renderTable() {
    this.tableHeader.innerHTML = "";
    this.tableBody.innerHTML = "";
    this.setExportButtonEnabled(this.filteredData.length > 0);
    this.updateTableStats();

    if (this.filteredData.length === 0) {
      this.noData.classList.remove("hidden");
      return;
    }
    this.noData.classList.add("hidden");

    const visibleHeaders = this.getVisibleHeaders();

    visibleHeaders.forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      if (this.isNumberColumn(h)) th.classList.add("col-number");
      if (h.toLowerCase().includes("date")) th.classList.add("col-date");
      this.tableHeader.appendChild(th);
    });

    // Add Actions header
    const actionTh = document.createElement("th");
    actionTh.textContent = "Actions";
    actionTh.classList.add("col-actions");
    this.tableHeader.appendChild(actionTh);

    this.filteredData.forEach((row) => {
      const tr = document.createElement("tr");

      // Find the actual index in rawData for deletion
      const rawIndex = this.rawData.findIndex((r) => r === row);

      if (this.rules.jackpot.checked && this.isJackpotRow(row)) {
        tr.classList.add("row-jackpot");
      }
      if (this.rules.special.checked && this.isRecentDraw(row)) {
        tr.classList.add("row-special");
      }

      visibleHeaders.forEach((header) => {
        const td = document.createElement("td");
        const val = row[header];
        td.textContent = val;

        if (this.isNumberColumn(header)) td.classList.add("col-number");
        if (header.toLowerCase().includes("date")) td.classList.add("col-date");

        if (this.rules.ranges.checked && this.isNumberColumn(header)) {
          const n = parseInt(val);
          if (!isNaN(n)) {
            if (n >= 1 && n <= 14) td.classList.add("cell-low-range");
            else if (n >= 15 && n <= 28) td.classList.add("cell-med-range");
            else if (n >= 29 && n <= 42)
              td.classList.add("cell-med-high-range");
            else if (n >= 43 && n <= 58) td.classList.add("cell-high-range");
          }
        }

        if (
          this.rules.bonus.checked &&
          header.toLowerCase().includes("bonus")
        ) {
          td.classList.add("cell-bonus");
        }

        tr.appendChild(td);
      });

      // Add delete button
      const actionTd = document.createElement("td");
      actionTd.classList.add("col-actions");
      const delBtn = document.createElement("button");
      delBtn.innerHTML = "×";
      delBtn.className = "delete-btn";
      delBtn.title = "Delete Row";
      delBtn.onclick = () => this.handleDeleteRow(rawIndex);
      actionTd.appendChild(delBtn);
      tr.appendChild(actionTd);

      this.tableBody.appendChild(tr);
    });
  }

  private handleExportCsv() {
    const visibleHeaders = this.getVisibleHeaders();
    if (this.filteredData.length === 0 || visibleHeaders.length === 0) {
      this.setExportButtonEnabled(false);
      alert("No historical rows available to export.");
      return;
    }

    const csvRows: string[] = [];
    csvRows.push(visibleHeaders.map((h) => this.escapeCsvField(h)).join(","));

    this.filteredData.forEach((row) => {
      const cols = visibleHeaders.map((header) =>
        this.escapeCsvField(String(row[header] ?? "")),
      );
      csvRows.push(cols.join(","));
    });

    const csv = csvRows.join("\r\n");
    const blob = new Blob(["\uFEFF", csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `historical_results_${this.getLocalDateStamp()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  private handleExportDiagnostics() {
    if (!this.latestPredictionSnapshot || !this.latestDiagnosticsSnapshot) {
      this.setDiagnosticsExportEnabled(false);
      alert("No diagnostics available yet. Run training first.");
      return;
    }

    const firstDraw = this.drawRecords[0];
    const lastDraw = this.drawRecords[this.drawRecords.length - 1];
    const persistedLearningState = this.loadLearningStateFromStorage();
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "Lotto Results Explorer",
      modelSettings: this.getModelSettings(),
      dataSummary: {
        importedRows: this.rawData.length,
        validDraws: this.drawRecords.length,
        visibleRows: this.filteredData.length,
        drawRange: {
          from: firstDraw?.date ?? null,
          to: lastDraw?.date ?? null,
        },
      },
      predictionSummary: {
        warning: this.latestPredictionSnapshot.warning,
        candidateCount: this.latestPredictionSnapshot.sets.length,
        backtestMode: this.latestPredictionSnapshot.backtest.mode,
        maxObservedOverlap: this.latestPredictionSnapshot.backtest.maxObservedOverlap,
        sixMatchHits: this.latestPredictionSnapshot.backtest.sixMatchHits,
        sixMatchRate: this.latestPredictionSnapshot.backtest.sixMatchRate,
      },
      persistence: {
        warmStateInjectedAtRunStart:
          this.activeWarmLearningState !== null
            ? {
                updatedAt: this.activeWarmLearningState.updatedAt,
                drawCount: this.activeWarmLearningState.drawCount,
                poolSize: this.activeWarmLearningState.poolSize,
                score: this.activeWarmLearningState.score,
                bestProfileName: this.activeWarmLearningState.bestProfile.name,
              }
            : null,
        storedLearningState: persistedLearningState
          ? {
              updatedAt: persistedLearningState.updatedAt,
              drawCount: persistedLearningState.drawCount,
              poolSize: persistedLearningState.poolSize,
              score: persistedLearningState.score,
              bestProfileName: persistedLearningState.bestProfile.name,
            }
          : null,
        backtestWarmStartApplied:
          this.latestPredictionSnapshot.backtest.warmStartApplied ?? false,
        backtestWarmStartProfile:
          this.latestPredictionSnapshot.backtest.warmStartProfileName ?? null,
      },
      diagnostics: this.latestDiagnosticsSnapshot,
      prediction: this.latestPredictionSnapshot,
      drawsUsed: this.drawRecords,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `training_diagnostics_${this.getLocalDateTimeStamp()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  private getVisibleHeaders(): string[] {
    return this.headers.filter((h) => !this.shouldHideTableColumn(h));
  }

  private setExportButtonEnabled(enabled: boolean) {
    if (!this.exportCsvBtn) return;
    this.exportCsvBtn.disabled = !enabled;
    this.exportCsvBtn.title = enabled
      ? "Download the filtered historical table as CSV."
      : "No historical rows available to export.";
  }

  private updateTableStats() {
    if (!this.tableStats) return;
    const imported = this.rawData.length;
    const valid = this.drawRecords.length;
    const shown = this.filteredData.length;
    const rowLabel = imported === 1 ? "row" : "rows";
    this.tableStats.textContent =
      `Imported: ${imported} ${rowLabel} | Valid draws: ${valid} | Showing: ${shown}`;
  }

  private escapeCsvField(value: string): string {
    const escaped = value.replace(/"/g, '""');
    return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
  }

  private getLocalDateStamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }

  private getLocalDateTimeStamp(): string {
    const now = new Date();
    const date = this.getLocalDateStamp();
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    return `${date}_${hours}${minutes}${seconds}`;
  }

  private shouldHideTableColumn(header: string): boolean {
    const h = header.toLowerCase();
    return /\bday\b/.test(h) || /\bjackpot\b/.test(h) || /\boutcome\b/.test(h);
  }

  private isNumberColumn(header: string): boolean {
    const h = header.toLowerCase();
    return (
      !h.includes("date") &&
      !h.includes("draw") &&
      !h.includes("prize") &&
      !h.includes("payout")
    );
  }

  private isJackpotRow(row: LottoResult): boolean {
    return Object.values(row).some((v) => {
      const n = String(v).replace(/[^0-9.-]+/g, "");
      const price = parseFloat(n);
      return !isNaN(price) && price > 1000000;
    });
  }

  private isRecentDraw(row: LottoResult): boolean {
    const dateVal = this.findDateValue(row);
    if (!dateVal) return false;
    const drawDate = this.parseDateValue(dateVal);
    if (!drawDate) return false;
    const now = new Date();
    return now.getTime() - drawDate.getTime() < 1000 * 60 * 60 * 24 * 30;
  }

  private showLoader(show: boolean) {
    this.loader.classList.toggle("hidden", !show);
  }

  // ─── PREDICTION ENGINE ─────────────────────────────────────────────
  private async handleRerun() {
    if (this.drawRecords.length < LottoViewer.MIN_PREDICTION_DRAWS) {
      console.warn("Not enough records to rerun.");
      alert(
        `Not enough historical rows loaded. At least ${LottoViewer.MIN_PREDICTION_DRAWS} valid draws are needed.`,
      );
      return;
    }

    try {
      this.saveModelSettingsToStorage();
      this.clearPredictionPanels();
      await new Promise((resolve) => setTimeout(resolve, 75));

      this.schedulePredictionEngine();
    } catch (e) {
      console.error("Rerun failed:", e);
      alert("Rerun failed. Check console for details.");
    }
  }

  private async handleGenerateCandidates() {
    if (this.drawRecords.length < LottoViewer.MIN_PREDICTION_DRAWS) {
      alert(
        `Not enough historical rows loaded. At least ${LottoViewer.MIN_PREDICTION_DRAWS} valid draws are needed.`,
      );
      return;
    }
    if (!this.latestPredictionSnapshot || !this.latestDiagnosticsSnapshot) {
      alert("Run a full training pass first, then generate fresh candidates.");
      return;
    }
    if (this.activePredictionAction !== "idle") {
      return;
    }

    const basePrediction = this.latestPredictionSnapshot;
    const baseDiagnostics = this.latestDiagnosticsSnapshot;
    const modelSettings = this.getModelSettings();
    this.saveModelSettingsToStorage();

    const requestId = ++this.predictionRequestId;
    this.latestPredictionRequestId = requestId;
    this.activePredictionAction = "refreshing";
    this.setTrainingControls(true);
    this.updatePredictionProgress(1, "Dispatching candidate refresh task");

    if (this.predictionWorker) {
      const request: PredictionWorkerRequest = {
        requestId,
        type: "refresh_candidates",
        draws: this.drawRecords,
        settings: modelSettings,
        basePrediction,
        diagnostics: baseDiagnostics,
      };
      this.predictionWorker.postMessage(request);
      this.armWorkerFirstResponseTimer(requestId, () => {
        if (
          requestId !== this.latestPredictionRequestId ||
          this.activePredictionAction !== "refreshing"
        ) {
          return;
        }
        console.warn(
          "Prediction worker unresponsive during candidate refresh; switching to main-thread fallback.",
        );
        try {
          this.predictionWorker?.terminate();
        } catch (error) {
          console.error("Failed to terminate unresponsive worker:", error);
        }
        this.predictionWorker = null;
        this.setPredictionStatus(
          "Worker unresponsive. Switching to main-thread refresh...",
          {
            showProgress: true,
            percent: 6,
          },
        );
        this.runCandidateRefreshOnMainThread(
          requestId,
          baseDiagnostics,
          basePrediction,
          modelSettings,
        );
        this.initPredictionWorker();
      });
      return;
    }

    this.runCandidateRefreshOnMainThread(
      requestId,
      baseDiagnostics,
      basePrediction,
      modelSettings,
    );
  }

  private clearPredictionPanels() {
    const predictionPanel = document.getElementById("predictionPanel");
    predictionPanel?.classList.remove("hidden");
    this.latestPredictionSnapshot = null;
    this.latestDiagnosticsSnapshot = null;
    this.setDiagnosticsExportEnabled(false);
    this.syncGenerateCandidatesControl();

    const panels = [
      "diagContent",
      "backtestContent",
      "hotColdGrid",
      "topPairsContent",
      "groupPatternsContent",
      "predictedSets",
      "learningProgressContent",
      "backtestRowsContent",
    ];
    panels.forEach((id) => {
      const el = document.getElementById(id);
      if (el)
        el.innerHTML =
          '<div style="padding: 1rem; opacity: 0.5; font-style: italic;">Updating factors...</div>';
    });
    if (this.liveTrainingTracePanel && this.liveTrainingTraceContent) {
      this.liveTrainingTracePanel.classList.remove("hidden");
      this.liveTrainingTraceContent.innerHTML =
        '<div class="trace-empty">Waiting for live validation samples...</div>';
    }
    this.updatePredictionProgress(0, "Queued");
  }

  private schedulePredictionEngine(delayMs = 0) {
    if (this.predictionTimer !== null) {
      window.clearTimeout(this.predictionTimer);
      this.predictionTimer = null;
    }

    this.predictionTimer = window.setTimeout(() => {
      this.predictionTimer = null;
      this.runPredictionEngine();
    }, delayMs);
  }

  private runPredictionOnMainThread(
    requestId: number,
    modelSettings: ModelSettings,
  ) {
    this.activePredictionAction = "training";
    this.setTrainingControls(true);
    window.setTimeout(() => {
      try {
        this.updatePredictionProgress(10, "Running diagnostics on main thread");
        const diagnostics = runFullDiagnostics(this.drawRecords);
        const prediction = runPrediction(this.drawRecords, diagnostics, {
          onProgress: (progress, stage) => {
            this.updatePredictionProgress(20 + progress * 75, stage);
          },
          onTrace: (trace) => {
            this.renderLiveTrainingTrace(trace);
          },
          settings: modelSettings,
        });
        if (requestId !== this.latestPredictionRequestId) return;
        this.applyPredictionResult(prediction.backtest.finalDiagnostics, prediction);
      } catch (error) {
        if (requestId !== this.latestPredictionRequestId) return;
        console.error("Prediction fallback failed:", error);
        this.setPredictionStatus(
          "Prediction failed on the main thread. Check console for details.",
          {
            showProgress: false,
          },
        );
      } finally {
        if (requestId === this.latestPredictionRequestId) {
          this.activePredictionAction = "idle";
          this.setTrainingControls(false);
        }
      }
    }, 0);
  }

  private runPredictionEngine() {
    if (this.drawRecords.length < LottoViewer.MIN_PREDICTION_DRAWS) {
      this.setTrainingControls(false);
      return;
    }
    this.clearPredictionPanels();
    const modelSettings = this.getModelSettings();
    this.saveModelSettingsToStorage();
    const warmLearningState = this.getCompatibleWarmLearningState();
    this.activeWarmLearningState = warmLearningState;
    if (warmLearningState) {
      modelSettings.warmStartEnabled = true;
      modelSettings.warmStartProfile = warmLearningState.bestProfile;
      modelSettings.warmProfileOverlaps = warmLearningState.profileOverlaps;
    } else {
      modelSettings.warmStartEnabled = false;
    }

    const requestId = ++this.predictionRequestId;
    this.latestPredictionRequestId = requestId;

    if (this.predictionWorker) {
      const request: PredictionWorkerRequest = {
        requestId,
        draws: this.drawRecords,
        settings: modelSettings,
      };
      this.activePredictionAction = "training";
      this.setTrainingControls(true);
      this.updatePredictionProgress(
        1,
        warmLearningState
          ? "Dispatching worker task (warm start loaded)"
          : "Dispatching worker task",
      );
      this.predictionWorker.postMessage(request);
      this.armWorkerFirstResponseTimer(requestId, () => {
        if (
          requestId !== this.latestPredictionRequestId ||
          this.activePredictionAction !== "training"
        ) {
          return;
        }
        console.warn(
          "Prediction worker unresponsive; switching to main-thread fallback.",
        );
        try {
          this.predictionWorker?.terminate();
        } catch (error) {
          console.error("Failed to terminate unresponsive worker:", error);
        }
        this.predictionWorker = null;
        this.setPredictionStatus(
          "Worker unresponsive. Switching to main-thread training...",
          {
            showProgress: true,
            percent: 6,
          },
        );
        this.runPredictionOnMainThread(requestId, modelSettings);
        this.initPredictionWorker();
      });
      return;
    }

    this.runPredictionOnMainThread(requestId, modelSettings);
  }

  private applyPredictionResult(
    diagnostics: ReturnType<typeof runFullDiagnostics>,
    prediction: PredictionOutput,
    options: { suppressStatusUpdate?: boolean } = {},
  ) {
    this.latestDiagnosticsSnapshot = diagnostics;
    this.latestPredictionSnapshot = prediction;
    this.saveLearningStateFromPrediction(prediction);
    this.setDiagnosticsExportEnabled(true);
    this.poolSize = diagnostics.poolSize;

    // Show prediction panel
    const panel = document.getElementById("predictionPanel")!;
    panel.classList.remove("hidden");

    // Warning (for finalized results)
    if (!options.suppressStatusUpdate) {
      this.setPredictionStatus(prediction.warning, { showProgress: false });
    }

    // Diagnostics
    this.renderDiagnostics(diagnostics);

    // Hot/Cold
    this.renderHotCold(diagnostics);

    // Pairs
    this.renderTopPairs(diagnostics);

    // Group Patterns
    this.renderGroupPatterns(diagnostics);

    // Predicted Sets
    this.renderPredictedSets(prediction);

    // Advanced Stats (Triples & Deltas)
    this.renderAdvancedStats(diagnostics);

    // Backtest Lab (Third Column)
    this.renderBacktestLab(prediction);
    this.syncGenerateCandidatesControl();
  }

  private renderDiagnostics(diag: ReturnType<typeof runFullDiagnostics>) {
    const container = document.getElementById("diagContent")!;
    const sigAutocorr = diag.autocorrelation.filter(
      (a) => a.isSignificant,
    ).length;

    container.innerHTML = `
      <div class="diag-stat">
        <span class="diag-label">Game Format</span>
        <span class="diag-value">6/${diag.poolSize}</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Current Era Draws</span>
        <span class="diag-value">${diag.eraDrawCount}</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Total Historical Draws</span>
        <span class="diag-value">${diag.totalDraws}</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Chi-Square (χ²)</span>
        <span class="diag-value">${diag.chiSquare.chiSquare.toFixed(2)}</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Chi-Square p-value</span>
        <span class="diag-value ${diag.chiSquare.isUniform ? "pass" : "fail"}">${diag.chiSquare.pValue.toFixed(4)}</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Uniform Distribution?</span>
        <span class="diag-value ${diag.chiSquare.isUniform ? "pass" : "fail"}">${diag.chiSquare.isUniform ? "Yes ✓" : "No ✗"}</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Sig. Autocorrelations</span>
        <span class="diag-value ${sigAutocorr === 0 ? "pass" : "fail"}">${sigAutocorr} / ${diag.poolSize}</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Bias Detected?</span>
        <span class="diag-value ${diag.biasDetected ? "fail" : "pass"}">${diag.biasDetected ? "Yes ⚠" : "No ✓"}</span>
      </div>
      ${
        diag.biasDetected
          ? `<div class="bias-reasons">
              ${diag.biasReasons.map((r) => `<div class="bias-reason">• ${r}</div>`).join("")}
            </div>`
          : ""
      }
      <div class="diag-stat" style="margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
        <span class="diag-label">Last Trained</span>
        <span class="diag-value" style="font-size: 0.8em; opacity: 0.7;">${new Date().toLocaleTimeString()}</span>
      </div>
    `;

    const btContainer = document.getElementById("backtestContent")!;
    btContainer.innerHTML =
      '<div class="diag-stat"><span class="diag-label">Running...</span></div>';
  }

  private renderHotCold(diag: ReturnType<typeof runFullDiagnostics>) {
    const grid = document.getElementById("hotColdGrid")!;
    grid.innerHTML = "";
    const sorted = [...diag.hotCold].sort((a, b) => a.number - b.number);
    for (const h of sorted) {
      const ball = document.createElement("div");
      ball.className = `num-ball ${h.status}`;
      ball.textContent = String(h.number);
      ball.title = `${h.status.toUpperCase()} | Recent: ${h.recentCount}/20 | All-time: ${(h.allTimeFreq * 100).toFixed(1)}%`;
      grid.appendChild(ball);
    }
  }

  private renderTopPairs(diag: ReturnType<typeof runFullDiagnostics>) {
    const container = document.getElementById("topPairsContent")!;
    const top15 = diag.topPairs.slice(0, 15);
    container.innerHTML = `<div class="pair-list">${top15
      .map(
        (p) =>
          `<span class="pair-chip">${p.i} & ${p.j} <small>(${p.count}×, z=${p.zScore.toFixed(1)})</small></span>`,
      )
      .join("")}</div>`;
  }

  private renderGroupPatterns(diag: ReturnType<typeof runFullDiagnostics>) {
    const container = document.getElementById("groupPatternsContent")!;
    const top10 = diag.groupPatterns.slice(0, 10);
    const maxPct = top10[0]?.percentage || 1;

    container.innerHTML = top10
      .map(
        (p) => `
      <div class="pattern-bar">
        <span class="pattern-label">${p.pattern}</span>
        <div style="flex:1; background: rgba(148,163,184,0.1); border-radius: 4px;">
          <div class="pattern-fill" style="width: ${(p.percentage / maxPct) * 100}%"></div>
        </div>
        <span class="pattern-pct">${p.percentage.toFixed(1)}%</span>
      </div>
    `,
      )
      .join("");
  }

  private renderPredictedSets(prediction: PredictionOutput) {
    const container = document.getElementById("predictedSets")!;
    const N = this.poolSize;

    container.innerHTML = prediction.sets
      .map(
        (s, i) => `
      <div class="predicted-set">
        <span class="set-rank">#${i + 1}</span>
        <div class="set-numbers">
          ${s.numbers
            .map((n) => {
              const g = getGroup(n, N);
              const colorMap: Record<string, string> = {
                Low: "var(--range-low)",
                Medium: "var(--range-med)",
                MedHigh: "var(--range-med-high)",
                High: "var(--range-high)",
              };
              return `<div class="pred-ball" style="background: ${colorMap[g] || "var(--primary)"}; color: white;">${n}</div>`;
            })
            .join("")}
        </div>
        <div class="set-meta">
          <span class="label"><b>${s.method}</b></span>
          <span class="label">Groups: ${s.groupBreakdown}</span>
          <span class="label">Score: ${(s.relativeLift * 100).toFixed(1)}%</span>
        </div>
      </div>
    `,
      )
      .join("");

    // Backtest results
    const bt = prediction.backtest;
    const totalBacktestRows = bt.trainSize + bt.testSize;
    const trainPct = totalBacktestRows > 0
      ? ((bt.trainSize / totalBacktestRows) * 100).toFixed(0)
      : "0";
    const testPct = totalBacktestRows > 0
      ? ((bt.testSize / totalBacktestRows) * 100).toFixed(0)
      : "0";
    const forwardRowsWithAttempt = bt.rowDetails.filter(
      (row) => typeof row.firstAttemptOverlap === "number",
    );
    const forwardSampleSize =
      forwardRowsWithAttempt.length > 0
        ? forwardRowsWithAttempt.length
        : bt.rowDetails.length;
    const forwardOverlapTotal =
      forwardRowsWithAttempt.length > 0
        ? forwardRowsWithAttempt.reduce(
            (sum, row) => sum + (row.firstAttemptOverlap ?? 0),
            0,
          )
        : bt.rowDetails.reduce((sum, row) => sum + row.overlap, 0);
    const forwardTop6Overlap =
      bt.forwardOnlyTop6Overlap ??
      (forwardSampleSize > 0 ? forwardOverlapTotal / forwardSampleSize : 0);
    const forwardModelHitRate =
      bt.forwardOnlyModelHitRate ?? forwardTop6Overlap / 6;
    const forwardFourPlusHits =
      bt.forwardOnlyFourPlusHits ??
      (forwardRowsWithAttempt.length > 0
        ? forwardRowsWithAttempt.filter(
            (row) => (row.firstAttemptOverlap ?? 0) >= 4,
          ).length
        : bt.fourPlusHits);
    const forwardFourPlusRate =
      bt.forwardOnlyFourPlusRate ??
      (forwardSampleSize > 0 ? forwardFourPlusHits / forwardSampleSize : 0);
    const forwardSixMatchHits =
      bt.forwardOnlySixMatchHits ??
      (forwardRowsWithAttempt.length > 0
        ? forwardRowsWithAttempt.filter(
            (row) => (row.firstAttemptOverlap ?? 0) >= 6,
          ).length
        : bt.sixMatchHits);
    const forwardSixMatchRate =
      bt.forwardOnlySixMatchRate ??
      (forwardSampleSize > 0 ? forwardSixMatchHits / forwardSampleSize : 0);
    const masterySolvedRate =
      bt.mode === "mastery" && bt.testSize > 0 && bt.masterySolvedSequences !== undefined
        ? (bt.masterySolvedSequences / bt.testSize) * 100
        : 0;
    const masteryFirstAttemptRate =
      bt.mode === "mastery" &&
      bt.testSize > 0 &&
      bt.masteryFirstAttemptSolved !== undefined
        ? (bt.masteryFirstAttemptSolved / bt.testSize) * 100
        : 0;
    const masteryComparisonSummary =
      bt.mode === "mastery"
        ? `
      <div class="mastery-compare-grid">
        <div class="mastery-compare-card">
          <div class="mastery-compare-title">Forward-Only (Attempt #1)</div>
          <div class="mastery-compare-line"><span>Avg Matches</span><b>${forwardTop6Overlap.toFixed(2)} / 6</b></div>
          <div class="mastery-compare-line"><span>Hit Rate</span><b>${(forwardModelHitRate * 100).toFixed(1)}%</b></div>
          <div class="mastery-compare-line"><span>4+ Matches</span><b>${forwardFourPlusHits} (${(forwardFourPlusRate * 100).toFixed(1)}%)</b></div>
          <div class="mastery-compare-line"><span>6-of-7 Hits</span><b>${forwardSixMatchHits} (${(forwardSixMatchRate * 100).toFixed(2)}%)</b></div>
        </div>
        <div class="mastery-compare-card">
          <div class="mastery-compare-title">Sequence Mastery (Final)</div>
          <div class="mastery-compare-line"><span>Avg Matches</span><b>${bt.top6Overlap.toFixed(2)} / 6</b></div>
          <div class="mastery-compare-line"><span>Hit Rate</span><b>${(bt.modelHitRate * 100).toFixed(1)}%</b></div>
          <div class="mastery-compare-line"><span>4+ Matches</span><b>${bt.fourPlusHits} (${(bt.fourPlusRate * 100).toFixed(1)}%)</b></div>
          <div class="mastery-compare-line"><span>6-of-7 Hits</span><b>${bt.sixMatchHits} (${(bt.sixMatchRate * 100).toFixed(2)}%)</b></div>
        </div>
      </div>
    `
        : "";
    const masterySummary =
      bt.mode === "mastery"
        ? `
      <div class="diag-stat">
        <span class="diag-label">Backtest Mode</span>
        <span class="diag-value">Sequence Mastery (Iterative)</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Mastery Target</span>
        <span class="diag-value">${bt.masteryTargetMatch ?? 6}/6</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Mastered Sequences</span>
        <span class="diag-value ${masterySolvedRate >= 25 ? "pass" : "fail"}">${bt.masterySolvedSequences ?? 0}/${bt.testSize} (${masterySolvedRate.toFixed(1)}%)</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">First-Attempt Mastery</span>
        <span class="diag-value">${bt.masteryFirstAttemptSolved ?? 0} (${masteryFirstAttemptRate.toFixed(1)}%)</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Total Sequence Attempts</span>
        <span class="diag-value">${bt.masteryTotalAttempts ?? 0}</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Avg Attempts / Sequence</span>
        <span class="diag-value">${(bt.masteryAverageAttempts ?? 0).toFixed(2)}</span>
      </div>
      ${
        bt.masteryGlobalCapReached
          ? `<div class="diag-stat"><span class="diag-label">Mastery Cap Status</span><span class="diag-value fail">Global attempt cap reached</span></div>`
          : ""
      }
    `
        : "";
    const warmStartSummary = bt.warmStartApplied
      ? `
      <div class="diag-stat">
        <span class="diag-label">Warm Start</span>
        <span class="diag-value pass">Enabled (${bt.warmStartProfileName || "Persisted Profile"})</span>
      </div>
    `
      : `
      <div class="diag-stat">
        <span class="diag-label">Warm Start</span>
        <span class="diag-value">Disabled</span>
      </div>
    `;
    const btContainer = document.getElementById("backtestContent")!;
    btContainer.innerHTML = `
      <div class="diag-stat">
        <span class="diag-label">Test Period</span>
        <span class="diag-value">${bt.testSize} draws (${trainPct}%/${testPct}% split)</span>
      </div>
      ${warmStartSummary}
      <div class="diag-stat">
        <span class="diag-label">Sequence (Top 6 vs 7-ball target) Hit Rate</span>
        <span class="diag-value">${(bt.modelHitRate * 100).toFixed(1)}%</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Random Baseline</span>
        <span class="diag-value">${(bt.baselineHitRate * 100).toFixed(1)}%</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Avg Matches per Draw (6/7 target)</span>
        <span class="diag-value">${bt.top6Overlap.toFixed(2)} / 6</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">4+ Matches Frequency</span>
        <span class="diag-value ${bt.fourPlusRate > 0 ? "pass" : "fail"}">${(bt.fourPlusRate * 100).toFixed(1)}% (${bt.fourPlusHits}/${bt.testSize})</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Max 6-of-7 Sequence Match</span>
        <span class="diag-value ${bt.maxObservedOverlap >= 6 ? "pass" : ""}">${bt.maxObservedOverlap}/6</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">6-of-7 Full Hits</span>
        <span class="diag-value ${bt.sixMatchHits > 0 ? "pass" : "fail"}">${bt.sixMatchHits} (${(bt.sixMatchRate * 100).toFixed(2)}%)</span>
      </div>
      ${masteryComparisonSummary}
      ${masterySummary}
      <div class="diag-stat">
        <span class="diag-label">Learning Trend</span>
        <span class="diag-value ${bt.learningTrend >= 0 ? "pass" : "fail"}">
          ${bt.learningTrend >= 0 ? "▲" : "▼"} ${Math.abs(bt.learningTrend).toFixed(1)}%
          <small style="display: block; font-size: 0.6em; opacity: 0.7;">
            (${bt.earlyMatches.toFixed(2)} → ${bt.recentMatches.toFixed(2)} matches)
          </small>
        </span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Efficiency Gain</span>
        <span class="diag-value ${bt.improvement > 0 ? "pass" : "fail"}">
          ${bt.improvement > 0 ? "+" : ""}${bt.improvement.toFixed(1)}%
        </span>
      </div>
      <div style="margin-top: 1rem; font-size: 0.75rem; color: var(--text-muted); font-style: italic;">
        * Backtest overlap is scored against all 7 winning balls (6 main + bonus).
      </div>
    `;
  }

  private renderAdvancedStats(diag: ReturnType<typeof runFullDiagnostics>) {
    // We'll append a new card if it doesn't exist, or update it
    let container = document.getElementById("advancedStatsCard");
    if (!container) {
      container = document.createElement("div");
      container.id = "advancedStatsCard";
      container.className = "pred-card";
      document.querySelector(".pred-grid")?.appendChild(container);
    }

    const top3Triples = diag.topTriples.slice(0, 5);
    const topQuads = diag.topQuadruples?.slice(0, 3) || [];
    const topQuints = diag.topQuintets?.slice(0, 2) || [];
    const topDeltas = diag.deltas.slice(0, 5);

    container.innerHTML = `
      <h3>Advanced Statistics</h3>
      <div class="advanced-stats-grid">
        <div class="stat-section">
          <div class="triple-list">
            ${top3Triples.map((t) => `<span class="pair-chip">${t.i}, ${t.j}, ${t.k} <small>(${t.count}x)</small></span>`).join("")}
          </div>
        </div>
        <div class="stat-section">
          <h4>Top Quadruples</h4>
          <div class="triple-list">
            ${topQuads.map((q) => `<span class="pair-chip">${q.i}, ${q.j}, ${q.k}, ${q.l} <small>(${q.count}x)</small></span>`).join("")}
          </div>
        </div>
        ${
          topQuints.length > 0
            ? `
        <div class="stat-section">
          <h4>High Affinity Quintets</h4>
          <div class="triple-list">
            ${topQuints.map((q) => `<span class="pair-chip">${q.i}, ${q.j}, ${q.k}, ${q.l}, ${q.m} <small>(${q.count}x)</small></span>`).join("")}
          </div>
        </div>
        `
            : ""
        }
        <div class="stat-section">
          <h4>Common Gaps (Deltas)</h4>
          <div class="delta-list">
            ${topDeltas.map((d) => `<span class="label">Delta ${d.delta}: <b>${d.percentage.toFixed(1)}%</b></span>`).join(" | ")}
          </div>
        </div>
      </div>
    `;
  }

  private renderBacktestLab(prediction: PredictionOutput) {
    const labPanel = document.getElementById("backtestLabPanel")!;
    labPanel.classList.remove("hidden");

    const bt = prediction.backtest;

    // 1. Learning Progress (Profile Sweep)
    const progContainer = document.getElementById("learningProgressContent")!;
    const maxOverlap =
      Math.max(...bt.profilePerformance.map((p) => p.overlap)) || 1;

    progContainer.innerHTML = `
      <div class="profile-bar-row">
        ${bt.profilePerformance
          .map(
            (p) => `
          <div class="profile-bar-item">
            <div class="profile-name-row">
              <span class="profile-name">${p.name}</span>
              <span class="profile-val">${p.overlap} matches</span>
            </div>
            <div class="profile-bar-outer">
              <div class="profile-bar-inner" style="width: ${(p.overlap / maxOverlap) * 100}%"></div>
            </div>
          </div>
        `,
          )
          .join("")}
      </div>
      <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 1rem;">
        * Model evaluated all weighting strategies and prioritized the top performer.
      </p>
    `;

    // 2. Step-by-Step Validation
    const rowsContainer = document.getElementById("backtestRowsContent")!;
    rowsContainer.innerHTML = bt.rowDetails
      .slice()
      .reverse()
      .map((row) => {
        const actualSet = new Set(row.actual);
        if (row.bonus > 0) actualSet.add(row.bonus);
        return `
        <div class="backtest-row">
          <div class="row-date">${row.date}</div>
          <div class="comparison-grid">
            <div class="comparison-col">
              <h5>Actual (6 + Bonus)</h5>
              <div class="mini-ball-row">
                ${row.actual.map((n) => `<div class="mini-ball">${n}</div>`).join("")}
                ${
                  row.bonus > 0
                    ? `<div class="mini-ball" style="border-color: rgba(223,190,135,0.6); color: var(--highlight-bonus);">B${row.bonus}</div>`
                    : ""
                }
              </div>
            </div>
            <div class="comparison-col">
              <h5>Model Top-6</h5>
              <div class="mini-ball-row">
                ${row.predictedTop6
                  .map(
                    (n) => `
                  <div class="mini-ball ${actualSet.has(n) ? "match" : ""}">${n}</div>
                `,
                  )
                  .join("")}
              </div>
            </div>
          </div>
          ${
            row.overlap > 0
              ? `<div style="color: var(--primary); font-size: 0.65rem; margin-top: 4px; font-weight: 700;">✓ ${row.overlap} hits matched (7-ball target)</div>`
              : ""
          }
          ${
            row.attemptsUsed !== undefined
              ? `<div style="color: var(--text-secondary); font-size: 0.62rem; margin-top: 4px;">Attempts: ${row.attemptsUsed}${row.mastered === true ? " | Mastered" : " | Unresolved"}</div>`
              : ""
          }
        </div>
      `;
      })
      .join("");
  }
}

new LottoViewer();
