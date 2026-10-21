"use strict";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

const HOST = "127.0.0.1";
const SIDE_CAR_NAME = "antigravity_quota_panel";
const envPort = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || "", 10);
const PORT = Number.isNaN(envPort) ? 8099 : envPort;
const SIDECAR_TOKEN =
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ||
  "";

let cachedLsEndpoint = null; // { proto, port, csrfToken, pid, processName }
let cachedCdpPorts = [];
let lastQuotaPayload = null;
let lastQuotaFetchAt = 0;
const QUOTA_REFRESH_MS = 5 * 60 * 1000; // 5 minutes (300,000 ms)

function getDataDir() {
  const envDir = (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || "").trim();
  if (envDir) return envDir;
  const appDataDir =
    (process.env.ANTIGRAVITY_APP_DATA_DIR || "").trim() ||
    path.join(os.homedir(), ".gemini", "antigravity");
  const dir = path.join(appDataDir, "sidecar_data", SIDE_CAR_NAME, "data");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function getPreloadJs() {
  const appDataDir =
    (process.env.ANTIGRAVITY_APP_DATA_DIR || "").trim() ||
    path.join(os.homedir(), ".gemini", "antigravity");
  const preloadPath = path.join(appDataDir, "lib", "node_modules", "sidecar_sdk", "preload.js");
  try {
    return fs.readFileSync(preloadPath, "utf-8");
  } catch {
    return "// Preload bridge stub\nwindow.__sidecarReady = true;\n";
  }
}

function injectSidecarToken(html, token, conversationId) {
  if (!token) return html;
  const query =
    `token=${encodeURIComponent(token)}` +
    (conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : "");
  return html.replace(/\b(href|src)=(["'])(\/[^"'\s>]*)\2/g, (match, attr, quote, urlPath) => {
    if (urlPath.startsWith("//")) return match;
    const [basePath, ...hashParts] = urlPath.split("#");
    const hash = hashParts.length > 0 ? `#${hashParts.join("#")}` : "";
    const sep = basePath.includes("?") ? "&" : "?";
    return `${attr}=${quote}${basePath}${sep}${query}${hash}${quote}`;
  });
}

function discoverLanguageServers() {
  return new Promise((resolve) => {
    const psScript = `
      $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^language_server' }
      $result = @()
      foreach ($p in $procs) {
        $cmd = [string]$p.CommandLine
        $token = ''
        if ($cmd -match '--csrf_token\\s+([a-fA-F0-9\\-]+)') {
          $token = $matches[1]
        }
        $ports = @(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
        if ($token -and $ports.Count -gt 0) {
          $result += [PSCustomObject]@{
            pid = $p.ProcessId
            name = $p.Name
            csrfToken = $token
            ports = $ports
            isHub = ($cmd -match '--subclient_type\\s+hub')
          }
        }
      }
      $result | ConvertTo-Json -Compress
    `;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { timeout: 8000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        try {
          const parsed = JSON.parse(stdout.trim());
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          arr.sort((a, b) => Number(Boolean(b.isHub)) - Number(Boolean(a.isHub)));
          resolve(arr);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

function discoverAntigravityCdpPorts() {
  return new Promise((resolve) => {
    const psScript = `
      $ports = @()
      $activePortFile = Join-Path $env:APPDATA 'Antigravity\\DevToolsActivePort'
      if (Test-Path $activePortFile) {
        $firstLine = (Get-Content $activePortFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($firstLine -match '^\\d+$') { $ports += [int]$firstLine }
      }
      $agyProcs = Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue
      foreach ($ap in $agyProcs) {
        $pList = @(Get-NetTCPConnection -OwningProcess $ap.Id -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
        foreach ($pt in $pList) {
          if ($ports -notcontains [int]$pt) { $ports += [int]$pt }
        }
      }
      $ports | ConvertTo-Json -Compress
    `;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { timeout: 6000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        try {
          const parsed = JSON.parse(stdout.trim());
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          resolve(arr.filter((n) => typeof n === "number" && n > 0));
        } catch {
          resolve([]);
        }
      }
    );
  });
}

async function callGetUserStatus(endpoint) {
  const url = `${endpoint.proto}://127.0.0.1:${endpoint.port}/exa.language_server_pb.LanguageServerService/GetUserStatus`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": endpoint.csrfToken,
      },
      body: JSON.stringify({
        metadata: {
          ideName: "antigravity",
          extensionName: "antigravity",
          locale: "ko",
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLiveQuotaData(forceFresh = false) {
  if (!forceFresh && lastQuotaPayload && Date.now() - lastQuotaFetchAt < QUOTA_REFRESH_MS) {
    return lastQuotaPayload;
  }

  if (cachedLsEndpoint) {
    try {
      const raw = await callGetUserStatus(cachedLsEndpoint);
      lastQuotaPayload = formatQuotaPayload(raw, cachedLsEndpoint);
      lastQuotaFetchAt = Date.now();
      return lastQuotaPayload;
    } catch {
      cachedLsEndpoint = null;
    }
  }

  const servers = await discoverLanguageServers();
  for (const srv of servers) {
    const ports = Array.isArray(srv.ports) ? srv.ports : [srv.ports];
    for (const port of ports) {
      for (const proto of ["https", "http"]) {
        const candidate = {
          proto,
          port,
          csrfToken: srv.csrfToken,
          pid: srv.pid,
          processName: srv.name,
        };
        try {
          const raw = await callGetUserStatus(candidate);
          cachedLsEndpoint = candidate;
          lastQuotaPayload = formatQuotaPayload(raw, candidate);
          lastQuotaFetchAt = Date.now();
          return lastQuotaPayload;
        } catch {}
      }
    }
  }
  throw new Error("실행 중인 Antigravity language_server 프로세스를 찾거나 연결할 수 없습니다.");
}

function getFamilyName(label) {
  const cleaned = String(label || "")
    .replace(/\s*\((High|Medium|Low|Fast|Thinking)\)\s*$/i, "")
    .trim();
  if (/^Claude\s+(Opus|Sonnet)\s+5\.5$/i.test(cleaned)) {
    return "Claude 5.5";
  }
  return cleaned;
}

function formatQuotaPayload(raw, endpoint) {
  const us = raw?.userStatus || {};
  const planInfo = us.planStatus?.planInfo || {};
  const userTier = us.userTier || {};
  const rawModels = us.cascadeModelConfigData?.clientModelConfigs || [];

  const models = rawModels.map((m) => {
    const frac =
      typeof m.quotaInfo?.remainingFraction === "number"
        ? Math.max(0, Math.min(1, m.quotaInfo.remainingFraction))
        : 1;
    const remainingPercent = Number((frac * 100).toFixed(2));
    const usedPercent = Number(((1 - frac) * 100).toFixed(2));
    return {
      modelId: m.modelId || m.modelOrAlias?.model || m.label,
      label: m.label || m.modelId,
      family: getFamilyName(m.label || m.modelId),
      remainingFraction: frac,
      remainingPercent,
      usedPercent,
      resetTime: m.quotaInfo?.resetTime || null,
      tagTitle: m.tagTitle || null,
      tagDescription: m.tagDescription || null,
      supportsImages: Boolean(m.supportsImages),
    };
  });

  const familyMap = new Map();
  for (const m of models) {
    if (!familyMap.has(m.family)) {
      familyMap.set(m.family, {
        family: m.family,
        remainingPercent: m.remainingPercent,
        usedPercent: m.usedPercent,
        resetTime: m.resetTime,
        tagTitle: m.tagTitle,
        tagDescription: m.tagDescription,
        variants: [],
      });
    }
    familyMap.get(m.family).variants.push(m);
  }

  const preferredOrder = [
    "Gemini 4 Argon",
    "Gemini 3.8 Flash",
    "Claude 5.5",
    "GPT-OSS 120B",
  ];
  const families = Array.from(familyMap.values()).sort((a, b) => {
    const ia = preferredOrder.findIndex((p) => a.family.startsWith(p));
    const ib = preferredOrder.findIndex((p) => b.family.startsWith(p));
    const rankA = ia === -1 ? 999 : ia;
    const rankB = ib === -1 ? 999 : ib;
    return rankA - rankB;
  });

  return {
    ok: true,
    timestamp: new Date().toISOString(),
    csrfToken: endpoint.csrfToken,
    serverInfo: {
      pid: endpoint.pid,
      processName: endpoint.processName,
      port: endpoint.port,
      proto: endpoint.proto,
    },
    user: {
      name: us.name || "User",
      email: us.email || "",
      tierName: userTier.name || planInfo.planName || "Pro",
      tierId: userTier.id || planInfo.teamsTier || "",
      planName: planInfo.planName || "Pro",
      availablePromptCredits: us.planStatus?.availablePromptCredits ?? null,
      monthlyPromptCredits: planInfo.monthlyPromptCredits ?? null,
      availableFlowCredits: us.planStatus?.availableFlowCredits ?? null,
      monthlyFlowCredits: planInfo.monthlyFlowCredits ?? null,
    },
    families,
    models,
  };
}

function buildBottomStatusBarInjectionScript(quotaData) {
  const payloadJson = JSON.stringify(quotaData);
  return `(function(initialData) {
    // 1) Clear ALL old timers from previous versions (including old interval IDs)
    if (!window.__agyCleanedUpV2) {
      window.__agyCleanedUpV2 = true;
      for (var tid = 1; tid < 100000; tid++) {
        // Do not clear Antigravity's internal timers indiscriminately; instead override old globals!
      }
    }
    if (window.__agyQuotaCountdownTimer) {
      clearInterval(window.__agyQuotaCountdownTimer);
      window.__agyQuotaCountdownTimer = null;
    }
    if (window.__agyQuotaRefreshTimer) {
      clearInterval(window.__agyQuotaRefreshTimer);
      window.__agyQuotaRefreshTimer = null;
    }

    // Remove the old #agy-quota-bottom-bar element if it was managed by the old anonymous closure
    // and replace with #agy-quota-bottom-bar-v2 so any old lingering setInterval becomes a no-op!
    var legacyBar = document.getElementById("agy-quota-bottom-bar");
    if (legacyBar) {
      legacyBar.remove();
    }
    // Create a hidden dummy #agy-quota-bottom-bar so any old lingering setInterval writes to an invisible detached/hidden element instead of recreating or flickering!
    var dummyTrap = document.getElementById("agy-quota-bottom-bar");
    if (!dummyTrap) {
      dummyTrap = document.createElement("div");
      dummyTrap.id = "agy-quota-bottom-bar";
      dummyTrap.style.display = "none";
      document.body.appendChild(dummyTrap);
    }

    window.__agyQuotaData = initialData;
    if (initialData && initialData.csrfToken) {
      window.__agyCsrfToken = initialData.csrfToken;
    }

    function shortFamilyName(fam) {
      return String(fam || "")
        .replace(/^Gemini 4 Argon/i, "Gemini 4 Argon")
        .replace(/^Gemini 3\\.8 Flash/i, "Gemini 3.8 Flash")
        .replace(/^Claude (Opus|Sonnet) 5\\.5/i, "Claude 5.5")
        .replace(/^Claude 5\\.5/i, "Claude 5.5")
        .replace(/^GPT-OSS 120B/i, "GPT-OSS 120B");
    }

    function colorForPercent(pct) {
      if (pct >= 65) return "#10b981";
      if (pct >= 30) return "#f59e0b";
      return "#ef4444";
    }

    function formatRemaining(isoStr) {
      if (!isoStr) return "-";
      var diffMs = new Date(isoStr).getTime() - Date.now();
      if (diffMs <= 0) return "초기화 완료";
      var totalMin = Math.floor(diffMs / 60000);
      var h = Math.floor(totalMin / 60);
      var m = totalMin % 60;
      if (h > 0) return h + "h " + m + "m";
      return Math.max(1, m) + "m";
    }

    function formatResetClock(isoStr) {
      if (!isoStr) return "-";
      var d = new Date(isoStr);
      return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }) + " 리셋";
    }

    function parseRawGetUserStatus(raw) {
      var us = (raw && raw.userStatus) || {};
      var planInfo = (us.planStatus && us.planStatus.planInfo) || {};
      var userTier = us.userTier || {};
      var rawModels = (us.cascadeModelConfigData && us.cascadeModelConfigData.clientModelConfigs) || [];

      var models = rawModels.map(function(m) {
        var frac = (m.quotaInfo && typeof m.quotaInfo.remainingFraction === "number")
          ? Math.max(0, Math.min(1, m.quotaInfo.remainingFraction))
          : 1;
        var remainingPercent = Number((frac * 100).toFixed(2));
        var usedPercent = Number(((1 - frac) * 100).toFixed(2));
        var label = m.label || m.modelId || "";
        var family = String(label).replace(/\\s*\\((High|Medium|Low|Fast|Thinking)\\)\\s*$/i, "").trim();
        if (/^Claude\\s+(Opus|Sonnet)\\s+5\\.5$/i.test(family)) {
          family = "Claude 5.5";
        }
        return {
          modelId: m.modelId || (m.modelOrAlias && m.modelOrAlias.model) || label,
          label: label,
          family: family,
          remainingFraction: frac,
          remainingPercent: remainingPercent,
          usedPercent: usedPercent,
          resetTime: (m.quotaInfo && m.quotaInfo.resetTime) || null,
          tagTitle: m.tagTitle || null
        };
      });

      var familyMap = new Map();
      models.forEach(function(m) {
        if (!familyMap.has(m.family)) {
          familyMap.set(m.family, {
            family: m.family,
            remainingPercent: m.remainingPercent,
            usedPercent: m.usedPercent,
            resetTime: m.resetTime,
            tagTitle: m.tagTitle,
            variants: []
          });
        }
        familyMap.get(m.family).variants.push(m);
      });

      var preferredOrder = [
        "Gemini 4 Argon",
        "Gemini 3.8 Flash",
        "Claude 5.5",
        "GPT-OSS 120B"
      ];
      var families = Array.from(familyMap.values()).sort(function(a, b) {
        var ia = preferredOrder.findIndex(function(p) { return a.family.indexOf(p) === 0; });
        var ib = preferredOrder.findIndex(function(p) { return b.family.indexOf(p) === 0; });
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });

      return {
        ok: true,
        timestamp: new Date().toISOString(),
        user: {
          name: us.name || "User",
          email: us.email || "",
          tierName: userTier.name || planInfo.planName || "Pro",
          availablePromptCredits: us.planStatus ? us.planStatus.availablePromptCredits : null,
          monthlyPromptCredits: planInfo.monthlyPromptCredits || null
        },
        families: families,
        models: models
      };
    }

    async function refreshDirectlyInBrowser() {
      var token = window.__agyCsrfToken;
      if (!token) return;
      var btn = document.getElementById("agy-quota-refresh-btn-v2");
      if (btn) btn.style.opacity = "0.5";
      try {
        var res = await fetch("/exa.language_server_pb.LanguageServerService/GetUserStatus", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "x-codeium-csrf-token": token
          },
          body: JSON.stringify({
            metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "ko" }
          })
        });
        if (res.ok) {
          var raw = await res.json();
          window.__agyQuotaData = parseRawGetUserStatus(raw);
          renderStatusBar(true);
        }
      } catch (e) {
      } finally {
        if (btn) btn.style.opacity = "1";
      }
    }

    function ensureDomInstalled() {
      var style = document.getElementById("agy-quota-bottom-style");
      if (!style) {
        style = document.createElement("style");
        style.id = "agy-quota-bottom-style";
        document.head.appendChild(style);
      }
      style.textContent = \`
        #root > div.h-\\\\[100dvh\\\\] {
          height: calc(100dvh - 25px) !important;
        }
        #agy-quota-bottom-bar {
          display: none !important;
        }
        #agy-quota-bottom-bar-v2 {
          position: fixed;
          left: 0;
          right: 0;
          bottom: 0;
          height: 25px;
          background: rgba(15, 17, 23, 0.96);
          border-top: 1px solid rgba(255, 255, 255, 0.10);
          color: #e2e8f0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 11.5px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 12px;
          z-index: 99999;
          user-select: none;
          backdrop-filter: blur(10px);
          box-sizing: border-box;
        }
        .agy-qb-left, .agy-qb-right {
          display: flex;
          align-items: center;
          gap: 10px;
          height: 100%;
        }
        .agy-qb-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-weight: 600;
          color: #93c5fd;
          padding: 1px 7px;
          border-radius: 4px;
          background: rgba(59, 130, 246, 0.14);
          border: 1px solid rgba(59, 130, 246, 0.28);
          cursor: pointer;
          font-size: 11px;
        }
        .agy-qb-badge:hover {
          background: rgba(59, 130, 246, 0.24);
        }
        .agy-qb-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #10b981;
          box-shadow: 0 0 6px #10b981;
        }
        .agy-qb-item {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 2px 7px;
          border-radius: 4px;
          cursor: pointer;
        }
        .agy-qb-item:hover {
          background: rgba(255, 255, 255, 0.07);
        }
        .agy-qb-name {
          color: #cbd5e1;
          font-weight: 500;
        }
        .agy-qb-track {
          width: 46px;
          height: 6px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.12);
          overflow: hidden;
          position: relative;
        }
        .agy-qb-fill {
          height: 100%;
          border-radius: 999px;
        }
        .agy-qb-pct {
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .agy-qb-timer {
          color: #94a3b8;
          font-size: 10.5px;
          font-variant-numeric: tabular-nums;
        }
        .agy-qb-sep {
          width: 1px;
          height: 12px;
          background: rgba(255, 255, 255, 0.10);
        }
        .agy-qb-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          background: transparent;
          border: none;
          color: #94a3b8;
          cursor: pointer;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 11px;
        }
        .agy-qb-btn:hover {
          color: #f8fafc;
          background: rgba(255, 255, 255, 0.08);
        }
        #agy-quota-popover-v2 {
          position: fixed;
          bottom: 31px;
          left: 12px;
          width: 440px;
          background: rgba(17, 20, 28, 0.98);
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 10px;
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.55);
          color: #f1f5f9;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 12px;
          padding: 14px;
          z-index: 100000;
          display: none;
          backdrop-filter: blur(14px);
        }
        #agy-quota-popover-v2.open {
          display: block;
        }
        .agy-qp-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 10px;
          margin-bottom: 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.09);
        }
        .agy-qp-title {
          font-weight: 700;
          font-size: 13px;
          color: #f8fafc;
        }
        .agy-qp-sub {
          font-size: 11px;
          color: #94a3b8;
          margin-top: 2px;
        }
        .agy-qp-row {
          margin-bottom: 10px;
          padding: 8px 10px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 7px;
        }
        .agy-qp-row:last-child {
          margin-bottom: 0;
        }
        .agy-qp-row-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 6px;
        }
        .agy-qp-row-bar {
          width: 100%;
          height: 7px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.10);
          overflow: hidden;
        }
        .agy-qp-row-meta {
          display: flex;
          justify-content: space-between;
          margin-top: 5px;
          font-size: 11px;
          color: #94a3b8;
        }
      \`;

      var oldPop = document.getElementById("agy-quota-popover");
      if (oldPop) oldPop.style.display = "none";

      if (!document.getElementById("agy-quota-popover-v2")) {
        var pop = document.createElement("div");
        pop.id = "agy-quota-popover-v2";
        document.body.appendChild(pop);

        document.addEventListener("click", function(e) {
          var popEl = document.getElementById("agy-quota-popover-v2");
          var barEl = document.getElementById("agy-quota-bottom-bar-v2");
          if (!popEl || !popEl.classList.contains("open")) return;
          if (popEl.contains(e.target) || (barEl && barEl.contains(e.target))) return;
          popEl.classList.remove("open");
        });
      }

      if (!document.getElementById("agy-quota-bottom-bar-v2")) {
        var bar = document.createElement("div");
        bar.id = "agy-quota-bottom-bar-v2";
        document.body.appendChild(bar);
      }
    }

    function togglePopover() {
      var pop = document.getElementById("agy-quota-popover-v2");
      if (pop) pop.classList.toggle("open");
    }

    function renderStatusBar(forceDomUpdate) {
      ensureDomInstalled();
      var data = window.__agyQuotaData;
      var bar = document.getElementById("agy-quota-bottom-bar-v2");
      var pop = document.getElementById("agy-quota-popover-v2");
      if (!bar || !data || !data.ok) return;

      var families = (data.families || []).filter(function(f) {
        return f.family.indexOf("GPT-OSS") === -1;
      }).slice(0, 3);
      var user = data.user || {};

      var leftHtml = \`
        <div class="agy-qb-badge" id="agy-quota-badge-btn-v2" title="클릭하여 상세 LLM 쿼터 보기">
          <span class="agy-qb-dot"></span>
          <span>⚡ LLM Quota</span>
        </div>
      \`;

      families.forEach(function(f, idx) {
        var pct = Math.round(f.remainingPercent);
        var col = colorForPercent(f.remainingPercent);
        var rem = formatRemaining(f.resetTime);
        if (idx > 0) leftHtml += \`<div class="agy-qb-sep"></div>\`;
        leftHtml += \`
          <div class="agy-qb-item" data-agy-toggle-v2="1" title="\${f.family}: 잔량 \${f.remainingPercent}% (사용 \${f.usedPercent}%) · 초기화까지 \${rem}">
            <span class="agy-qb-name">\${shortFamilyName(f.family)}</span>
            <div class="agy-qb-track">
              <div class="agy-qb-fill" style="width: \${pct}%; background: \${col};"></div>
            </div>
            <span class="agy-qb-pct" style="color: \${col};">\${pct}%</span>
            <span class="agy-qb-timer">⏱ \${rem}</span>
          </div>
        \`;
      });

      var updatedTime = new Date(data.timestamp || Date.now()).toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });

      var rightHtml = \`
        <span class="agy-qb-timer">\${user.tierName || "Pro"} · 5분 주기 (\${updatedTime})</span>
        <button class="agy-qb-btn" id="agy-quota-refresh-btn-v2" title="지금 즉시 새로고침">↻ 새로고침</button>
      \`;

      var nextHtml = \`<div class="agy-qb-left">\${leftHtml}</div><div class="agy-qb-right">\${rightHtml}</div>\`;
      if (forceDomUpdate || bar.__lastRenderedHtml !== nextHtml) {
        bar.__lastRenderedHtml = nextHtml;
        bar.innerHTML = nextHtml;

        bar.querySelectorAll("[data-agy-toggle-v2], #agy-quota-badge-btn-v2").forEach(function(el) {
          el.addEventListener("click", togglePopover);
        });
        var rBtn = document.getElementById("agy-quota-refresh-btn-v2");
        if (rBtn) {
          rBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            refreshDirectlyInBrowser();
          });
        }
      }

      if (pop) {
        var rowsHtml = "";
        (data.families || []).forEach(function(f) {
          var col = colorForPercent(f.remainingPercent);
          var rem = formatRemaining(f.resetTime);
          var clock = formatResetClock(f.resetTime);
          var variantsText = (f.variants || []).map(function(v) { return v.label; }).join(", ");
          rowsHtml += \`
            <div class="agy-qp-row">
              <div class="agy-qp-row-top">
                <strong style="color:#f8fafc;">\${f.family}</strong>
                <span style="font-weight:700; color:\${col};">\${f.remainingPercent}% 남음 <span style="font-weight:400; color:#94a3b8;">(사용 \${f.usedPercent}%)</span></span>
              </div>
              <div class="agy-qp-row-bar">
                <div style="width:\${Math.max(0, Math.min(100, f.remainingPercent))}%; height:100%; background:\${col}; border-radius:999px;"></div>
              </div>
              <div class="agy-qp-row-meta">
                <span>포함 모델: \${variantsText}</span>
                <span>⏱ \${rem} (\${clock})</span>
              </div>
            </div>
          \`;
        });

        var nextPopHtml = \`
          <div class="agy-qp-header">
            <div>
              <div class="agy-qp-title">⚡ Antigravity 실시간 LLM 쿼터 상세</div>
              <div class="agy-qp-sub">\${user.name || ""} (\${user.email || ""}) · \${user.tierName || "Google AI Pro"} · 자동 갱신: 5분</div>
            </div>
            <button class="agy-qb-btn" id="agy-qp-close-btn-v2">✕ 닫기</button>
          </div>
          <div>\${rowsHtml}</div>
        \`;
        if (forceDomUpdate || pop.__lastRenderedHtml !== nextPopHtml) {
          pop.__lastRenderedHtml = nextPopHtml;
          pop.innerHTML = nextPopHtml;
          var closeBtn = document.getElementById("agy-qp-close-btn-v2");
          if (closeBtn) {
            closeBtn.addEventListener("click", function() {
              pop.classList.remove("open");
            });
          }
        }
      }
    }

    renderStatusBar(false);

    // Update remaining time text every 60s (no 1-second DOM replacement!) and fetch quota every 5 minutes
    window.__agyQuotaCountdownTimer = setInterval(function() {
      renderStatusBar(false);
    }, 60000);
    window.__agyQuotaRefreshTimer = setInterval(function() {
      refreshDirectlyInBrowser();
    }, 300000);

    return "INSTALLED_V2_OK";
  })(${payloadJson});`;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let raw = "";
      res.on("data", (d) => (raw += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function evaluateInTarget(wsUrl, expression) {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        resolve(false);
      }, 3000);

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              expression,
              returnByValue: true,
            },
          })
        );
      });

      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id === 1) {
            clearTimeout(timer);
            try {
              ws.close();
            } catch {}
            resolve(true);
          }
        } catch {}
      });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function injectBottomStatusBarToAllWindows(forceFresh = false) {
  try {
    const quotaData = await fetchLiveQuotaData(forceFresh);
    const expr = buildBottomStatusBarInjectionScript(quotaData);

    if (cachedCdpPorts.length === 0) {
      cachedCdpPorts = await discoverAntigravityCdpPorts();
    }

    let injectedCount = 0;
    for (const port of cachedCdpPorts) {
      try {
        const targets = await httpGetJson(`http://127.0.0.1:${port}/json`);
        const pages = (Array.isArray(targets) ? targets : []).filter(
          (t) => t.type === "page" && t.webSocketDebuggerUrl
        );
        for (const page of pages) {
          const ok = await evaluateInTarget(page.webSocketDebuggerUrl, expr);
          if (ok) injectedCount++;
        }
      } catch {}
    }

    if (injectedCount === 0) {
      cachedCdpPorts = await discoverAntigravityCdpPorts();
      for (const port of cachedCdpPorts) {
        try {
          const targets = await httpGetJson(`http://127.0.0.1:${port}/json`);
          const pages = (Array.isArray(targets) ? targets : []).filter(
            (t) => t.type === "page" && t.webSocketDebuggerUrl
          );
          for (const page of pages) {
            await evaluateInTarget(page.webSocketDebuggerUrl, expr);
          }
        } catch {}
      }
    }
  } catch {}
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sidecar-Token");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const pathname = parsedUrl.pathname;

  if (pathname === "/preload.js" && req.method === "GET") {
    const body = getPreloadJs();
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(body);
    return;
  }

  if ((pathname === "/" || pathname === "/ui.html") && req.method === "GET") {
    try {
      const uiPath = path.join(__dirname, "ui.html");
      let html = fs.readFileSync(uiPath, "utf-8");
      const headerToken =
        typeof req.headers["x-sidecar-token"] === "string"
          ? req.headers["x-sidecar-token"].trim()
          : "";
      const token = parsedUrl.searchParams.get("token")?.trim() || headerToken;
      const convId = parsedUrl.searchParams.get("conversationId")?.trim() || "";
      if (token) {
        html = injectSidecarToken(html, token, convId);
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Failed to load ui.html: " + err.message);
    }
    return;
  }

  if (pathname === "/api/quota") {
    try {
      const force = Boolean(req.url && req.url.includes("forceRediscover=1"));
      if (force) {
        cachedLsEndpoint = null;
      }
      const data = await fetchLiveQuotaData(force);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        })
      );
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  const actualPort = server.address()?.port || PORT;
  const dataDir = getDataDir();
  const infoPath = path.join(dataDir, "server_info.json");
  try {
    fs.writeFileSync(
      infoPath,
      JSON.stringify(
        {
          host: HOST,
          port: actualPort,
          token: SIDECAR_TOKEN || null,
          pid: process.pid,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  } catch {}
  console.log(`[antigravity-quota-panel] Listening on http://${HOST}:${actualPort}`);

  // Immediately inject Bottom Status Bar, and sync every 5 minutes (300,000 ms)
  injectBottomStatusBarToAllWindows(true);
  setInterval(() => injectBottomStatusBarToAllWindows(true), QUOTA_REFRESH_MS);
});

function cleanup() {
  try {
    const infoPath = path.join(getDataDir(), "server_info.json");
    fs.rmSync(infoPath, { force: true });
  } catch {}
  process.exit(0);
}

process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
