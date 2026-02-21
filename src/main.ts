import * as XLSX from "xlsx";
import { type DrawRecord, runFullDiagnostics, getGroup } from "./analysis";
import { runPrediction, type PredictionOutput } from "./predictor";

interface LottoResult {
  [key: string]: string;
}

class LottoViewer {
  private rawData: LottoResult[] = [];
  private filteredData: LottoResult[] = [];
  private headers: string[] = [];
  private drawRecords: DrawRecord[] = [];
  private poolSize: number = 52;

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

  private STORAGE_KEY = "lotto_viewer_data";

  constructor() {
    this.initEvents();
    this.loadFromSessionStorage();
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

    if (this.addManualBtn) {
      this.addManualBtn.addEventListener("click", () =>
        this.handleAddManualRecord(),
      );
    }

    if (this.clearDataBtn) {
      this.clearDataBtn.addEventListener("click", () => this.handleClearData());
    }
  }

  private async handleFileUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    this.fileNameDisplay.textContent = file.name;
    this.showLoader(true);

    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data);
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      this.rawData = XLSX.utils.sheet_to_json(worksheet, { raw: false });

      if (this.rawData.length > 0) {
        this.headers = Object.keys(this.rawData[0]);
        this.saveToSessionStorage();
        this.parseDrawRecords();
        this.applyFilters();
        this.runPredictionEngine();
      }
    } catch (error) {
      console.error("Error parsing Excel:", error);
      alert("Failed to parse Excel file. Please ensure it's a valid XLSX.");
    } finally {
      this.showLoader(false);
    }
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

  private handleAddManualRecord() {
    // Auto-generate local date (YYYY-MM-DD)
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const date = `${year}-${month}-${day}`;

    const numbers = this.manualNums.map((input) => parseInt(input.value));
    if (numbers.some((n) => isNaN(n) || n < 1)) {
      alert("Please enter 6 valid numbers.");
      return;
    }

    const bonus = parseInt(this.manualBonus.value);
    if (isNaN(bonus) || bonus < 1) {
      alert("Please enter a valid bonus ball number.");
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
      this.headers.find((h) => h.toLowerCase() === "bonus") || "Bonus";
    newRow[bonusKey] = bonus.toString();

    // Map numbers to columns that start with "number"
    const numKeys = this.headers.filter((h) =>
      h.toLowerCase().startsWith("number"),
    );
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
    this.runPredictionEngine();

    // Clear inputs
    this.manualNums.forEach((input) => (input.value = ""));
    this.manualBonus.value = "";

    console.log("Manual record added:", newRow);
  }

  private handleClearData() {
    if (
      confirm("Are you sure you want to clear ALL data? This cannot be undone.")
    ) {
      sessionStorage.removeItem(this.STORAGE_KEY);
      this.rawData = [];
      this.filteredData = [];
      this.drawRecords = [];
      this.headers = [];
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
      this.runPredictionEngine();
    }
  }

  private parseDrawRecords() {
    this.drawRecords = this.rawData
      .map((row) => {
        const numbers: number[] = [];
        let bonus = 0;
        let dateVal = "";

        for (const [key, val] of Object.entries(row)) {
          const k = key.toLowerCase();
          if (k.includes("date")) dateVal = val;
          else if (k === "bonus") bonus = parseInt(val) || 0;
          else if (k.startsWith("number")) {
            const n = parseInt(val);
            if (!isNaN(n)) numbers.push(n);
          }
        }

        // Robust date parsing
        let date = dateVal;
        const parsed = new Date(dateVal);
        if (isNaN(parsed.getTime())) {
          // Try manual split if new Date fails (e.g. DD/MM/YYYY)
          const parts = dateVal.split(/[/-]/);
          if (parts.length === 3) {
            if (parts[0].length === 4) {
              // YYYY-MM-DD
              date = dateVal;
            } else {
              // Assume DD-MM-YYYY or MM-DD-YYYY - default to DD-MM-YYYY
              date = `${parts[2]}-${parts[1]}-${parts[0]}`;
            }
          }
        } else {
          date = parsed.toISOString().split("T")[0];
        }

        numbers.sort((a, b) => a - b);
        return { date, numbers, bonus };
      })
      .filter(
        (d) => d.numbers.length === 6 && !isNaN(new Date(d.date).getTime()),
      )
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
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
        const drawDate = new Date(dateVal);
        if (from && drawDate < new Date(from)) matchesDate = false;
        if (to && drawDate > new Date(to)) matchesDate = false;
      }

      return matchesSearch && matchesDate;
    });

    this.filteredData.sort((a, b) => {
      const dateA = new Date(this.findDateValue(a) || 0).getTime();
      const dateB = new Date(this.findDateValue(b) || 0).getTime();
      return sort === "desc" ? dateB - dateA : dateA - dateB;
    });

    this.renderTable();
  }

  private findDateValue(row: LottoResult): string | null {
    const keys = Object.keys(row);
    const dateKey =
      keys.find(
        (k) =>
          k.toLowerCase().includes("date") || k.toLowerCase().includes("draw"),
      ) || keys[0];
    return row[dateKey];
  }

  private renderTable() {
    this.tableHeader.innerHTML = "";
    this.tableBody.innerHTML = "";

    if (this.filteredData.length === 0) {
      this.noData.classList.remove("hidden");
      return;
    }
    this.noData.classList.add("hidden");

    this.headers.forEach((h) => {
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

      this.headers.forEach((header) => {
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
    const drawDate = new Date(dateVal);
    const now = new Date();
    return now.getTime() - drawDate.getTime() < 1000 * 60 * 60 * 24 * 30;
  }

  private showLoader(show: boolean) {
    this.loader.classList.toggle("hidden", !show);
  }

  // ─── PREDICTION ENGINE ─────────────────────────────────────────────
  private async handleRerun() {
    console.log("handleRerun called. Records:", this.drawRecords.length);
    if (this.drawRecords.length < 200) {
      console.warn("Not enough records to rerun.");
      alert(
        "No data found in memory. Please re-upload the Excel file to run predictions.",
      );
      return;
    }

    const originalText = this.rerunBtn.textContent || "⟳ Rerun";
    this.rerunBtn.textContent = "Running...";
    this.rerunBtn.disabled = true;

    try {
      this.clearPredictionPanels();
      // Small delay to allow UI to update
      await new Promise((resolve) => setTimeout(resolve, 100));

      this.runPredictionEngine();

      // Small delay to show completion
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (e) {
      console.error("Rerun failed:", e);
      alert("Rerun failed. Check console for details.");
    } finally {
      this.rerunBtn.textContent = originalText;
      this.rerunBtn.disabled = false;
    }
  }

  private clearPredictionPanels() {
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
    const warning = document.getElementById("predictionWarning");
    if (warning) warning.textContent = "Recalculating statistical model...";
  }

  private runPredictionEngine() {
    if (this.drawRecords.length < 200) return;

    const diagnostics = runFullDiagnostics(this.drawRecords);
    this.poolSize = diagnostics.poolSize;
    const prediction = runPrediction(this.drawRecords, diagnostics);

    // Show prediction panel
    const panel = document.getElementById("predictionPanel")!;
    panel.classList.remove("hidden");

    // Warning
    document.getElementById("predictionWarning")!.textContent =
      prediction.warning;

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
    const btContainer = document.getElementById("backtestContent")!;
    btContainer.innerHTML = `
      <div class="diag-stat">
        <span class="diag-label">Test Period</span>
        <span class="diag-value">${bt.testSize} draws (80/20 split)</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Sequence (Top 6) Hit Rate</span>
        <span class="diag-value">${(bt.modelHitRate * 100).toFixed(1)}%</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Random Baseline</span>
        <span class="diag-value">${(bt.baselineHitRate * 100).toFixed(1)}%</span>
      </div>
      <div class="diag-stat">
        <span class="diag-label">Avg Matches per Draw</span>
        <span class="diag-value">${bt.top6Overlap.toFixed(2)} / 6</span>
      </div>
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
        * Predictions validated against all 7 winning numbers (Main + Bonus).
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
        return `
        <div class="backtest-row">
          <div class="row-date">${row.date}</div>
          <div class="comparison-grid">
            <div class="comparison-col">
              <h5>Actual</h5>
              <div class="mini-ball-row">
                ${row.actual.map((n) => `<div class="mini-ball">${n}</div>`).join("")}
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
          ${row.overlap > 0 ? `<div style="color: var(--primary); font-size: 0.65rem; margin-top: 4px; font-weight: 700;">✓ ${row.overlap} hits matched</div>` : ""}
        </div>
      `;
      })
      .join("");
  }
}

new LottoViewer();
