const server = require("server");
const fs = require("fs");
const path = require("path");

const PLUGIN_NAME = "gfw-monitor";
const SCHEDULER_INTERVAL = "@every 10s";
const CONFIG_FILE = path.join(__storageDir__, "config.json");
const STATE_FILE = path.join(__storageDir__, "state.json");

const DEFAULT_CONFIG = {
  enabled: false,
  clientIds: [],
  clientOrder: [],
  chinaTaskIds: [],
  minimumFailedTargets: 5,
  failureCycles: 3,
  recoveryCycles: 2,
  checkIntervalSeconds: 60,
  staleAfterSeconds: 150,
  botToken: "",
  chatId: "",
  messageThreadId: "",
};

let config = Object.assign({}, DEFAULT_CONFIG);
let runtimeState = {
  clients: {},
  lastRunAt: null,
  lastRunError: "",
  telegramUpdateOffset: 0,
  lastTelegramPollAt: null,
  lastTelegramPollError: "",
  lastTelegramMenuAt: null,
  lastTelegramMenuError: "",
};
let checkRunning = false;
let commandPollRunning = false;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureStorage() {
  if (!fs.existsSync(__storageDir__)) {
    fs.mkdirSync(__storageDir__, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return clone(fallback);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`[${PLUGIN_NAME}] 读取 ${path.basename(file)} 失败: ${error.message}`);
    return clone(fallback);
  }
}

function writeJson(file, value) {
  ensureStorage();
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeId(value) {
  return String(value == null ? "" : value).trim();
}

function orderClientIds(clientIds, preferredOrder) {
  const ids = Array.from(new Set(asArray(clientIds).map(normalizeId).filter(Boolean)));
  const available = new Set(ids);
  const ordered = [];
  asArray(preferredOrder).map(normalizeId).forEach((uuid) => {
    if (!available.has(uuid) || ordered.includes(uuid)) return;
    ordered.push(uuid);
  });
  ids.forEach((uuid) => {
    if (!ordered.includes(uuid)) ordered.push(uuid);
  });
  return ordered;
}

function normalizeConfig(input, previous) {
  const source = input && typeof input === "object" ? input : {};
  const old = previous || DEFAULT_CONFIG;
  const next = {
    enabled: source.enabled === true,
    clientIds: asArray(source.clientIds).map(normalizeId).filter(Boolean),
    chinaTaskIds: asArray(source.chinaTaskIds).map(normalizeId).filter(Boolean),
    minimumFailedTargets: asInteger(source.minimumFailedTargets, 5, 1, 100),
    failureCycles: asInteger(source.failureCycles, 3, 1, 30),
    recoveryCycles: asInteger(source.recoveryCycles, 2, 1, 30),
    checkIntervalSeconds: asInteger(source.checkIntervalSeconds, 60, 30, 3600),
    staleAfterSeconds: asInteger(source.staleAfterSeconds, 150, 30, 3600),
    botToken: typeof source.botToken === "string" && source.botToken.trim()
      ? source.botToken.trim()
      : old.botToken || "",
    chatId: typeof source.chatId === "string" ? source.chatId.trim() : old.chatId || "",
    messageThreadId: typeof source.messageThreadId === "string"
      ? source.messageThreadId.trim()
      : old.messageThreadId || "",
  };

  next.clientIds = Array.from(new Set(next.clientIds));
  next.clientOrder = orderClientIds(
    next.clientIds,
    source.clientOrder == null ? old.clientOrder : source.clientOrder,
  );
  next.chinaTaskIds = Array.from(new Set(next.chinaTaskIds));
  return next;
}

function publicConfig(value) {
  const result = clone(value);
  result.botTokenConfigured = Boolean(result.botToken);
  result.botTokenMasked = result.botToken
    ? `${result.botToken.slice(0, 5)}…${result.botToken.slice(-4)}`
    : "";
  delete result.botToken;
  return result;
}

function isAdmin(req) {
  const context = req && req.context ? req.context : {};
  const principal = context.principal || {};
  const roles = asArray(principal.roles).map((role) => String(role).toLowerCase());
  return String(context.role || "").toLowerCase() === "admin" || roles.includes("admin");
}

function jsonResponse(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  if (!req.body) return {};
  try {
    return JSON.parse(req.body);
  } catch (_error) {
    const error = new Error("请求内容不是有效 JSON");
    error.statusCode = 400;
    throw error;
  }
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  jsonResponse(res, 403, { ok: false, error: "需要 Komari 管理员权限" });
  return false;
}

function unwrapRecords(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.records)) return result.records;
  if (result.data && Array.isArray(result.data.records)) return result.data.records;
  return [];
}

function taskId(task) {
  return normalizeId(task && (task.id != null ? task.id : task.task_id));
}

function clientId(client, fallback) {
  return normalizeId(client && (client.uuid || client.id || fallback));
}

function clientName(client, fallback) {
  return String((client && (client.name || client.alias)) || fallback || "未知服务器");
}

function clientTags(client) {
  const tags = client && client.tags;
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  if (tags && typeof tags === "object") return Object.keys(tags).filter((key) => tags[key]);
  return String(tags || "").split(/[;,]/).map((tag) => tag.trim()).filter(Boolean);
}

function clientTextField(client, field) {
  return String((client && client[field]) || "").trim();
}

function normalizeNodes(nodes) {
  if (Array.isArray(nodes)) {
    return nodes.map((node) => ({
      id: clientId(node),
      name: clientName(node, clientId(node)),
      tags: clientTags(node),
      group: clientTextField(node, "group"),
      ipv4: clientTextField(node, "ipv4"),
      ipv6: clientTextField(node, "ipv6"),
    })).filter((node) => node.id);
  }
  if (!nodes || typeof nodes !== "object") return [];
  return Object.keys(nodes).map((key) => ({
    id: clientId(nodes[key], key),
    name: clientName(nodes[key], key),
    tags: clientTags(nodes[key]),
    group: clientTextField(nodes[key], "group"),
    ipv4: clientTextField(nodes[key], "ipv4"),
    ipv6: clientTextField(nodes[key], "ipv6"),
  })).filter((node) => node.id);
}

function getStatusForClient(statuses, uuid) {
  if (!statuses || typeof statuses !== "object") return null;
  if (statuses[uuid]) return statuses[uuid];
  if (statuses.data && statuses.data[uuid]) return statuses.data[uuid];
  if (normalizeId(statuses.uuid || statuses.id) === uuid) return statuses;
  return null;
}

function isOnlineStatus(status) {
  if (!status || typeof status !== "object") return false;
  if (typeof status.online === "boolean") return status.online;
  if (typeof status.is_online === "boolean") return status.is_online;
  if (typeof status.connected === "boolean") return status.connected;
  const value = String(status.status || status.state || "").toLowerCase();
  return value === "online" || value === "online_ws" || value === "online_post" || value === "connected";
}

function recordTimestamp(record) {
  const raw = record && (record.time || record.finished_at || record.created_at || record.timestamp);
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordClientId(record) {
  return normalizeId(record && (record.client || record.client_uuid || record.uuid));
}

function latestRecordForClient(records, uuid) {
  let latest = null;
  let latestTime = -1;
  records.forEach((record) => {
    if (recordClientId(record) !== uuid) return;
    const time = recordTimestamp(record);
    if (time >= latestTime) {
      latest = record;
      latestTime = time;
    }
  });
  return latest;
}

function evaluateTaskRecord(record, nowMs, staleAfterSeconds) {
  if (!record) return { failed: true, reason: "missing", value: null, time: null };
  const timeMs = recordTimestamp(record);
  const stale = !timeMs || nowMs - timeMs > staleAfterSeconds * 1000;
  const value = Number(record.value);
  if (stale) {
    return { failed: true, reason: "stale", value: Number.isFinite(value) ? value : null, time: timeMs || null };
  }
  if (!Number.isFinite(value) || value < 0) {
    return { failed: true, reason: "failed", value: Number.isFinite(value) ? value : null, time: timeMs };
  }
  return { failed: false, reason: "ok", value, time: timeMs };
}

function computeEvaluation(options) {
  const taskResults = asArray(options.taskResults);
  const failed = taskResults.filter((result) => result.failed);
  const required = Math.max(1, Number(options.minimumFailedTargets) || 1);
  return {
    online: options.online === true,
    total: taskResults.length,
    failed: failed.length,
    required,
    sufficientTargets: taskResults.length >= required,
    abnormal: options.online === true && taskResults.length >= required && failed.length >= required,
    taskResults,
  };
}

function validateTelegramConfig(value) {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value.botToken || "")) {
    throw new Error("Telegram Bot Token 格式不正确");
  }
  if (!/^(?:-?\d+|@[A-Za-z0-9_]{5,})$/.test(value.chatId || "")) {
    throw new Error("Telegram Chat ID 格式不正确");
  }
  if (value.messageThreadId && !/^\d+$/.test(value.messageThreadId)) {
    throw new Error("Telegram Topic ID 必须是数字");
  }
}

async function callTelegram(method, payload, overrideConfig) {
  const active = overrideConfig || config;
  validateTelegramConfig(active);
  const response = await fetch(`https://api.telegram.org/bot${active.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram HTTP ${response.status}`);
  }
  return result;
}

async function sendTelegram(text, overrideConfig) {
  const active = overrideConfig || config;
  const payload = {
    chat_id: active.chatId,
    text,
    disable_web_page_preview: true,
  };
  if (active.messageThreadId) payload.message_thread_id = Number(active.messageThreadId);
  return callTelegram("sendMessage", payload, active);
}

async function configureTelegramMenu(overrideConfig) {
  const active = overrideConfig || config;
  const commands = [
    { command: "check", description: "立即检测全部监控服务器" },
    { command: "status", description: "查看最近一次检测状态" },
    { command: "alerts", description: "只查看异常和等待确认" },
    { command: "help", description: "查看机器人命令帮助" },
  ];
  const chatId = /^-?\d+$/.test(active.chatId) ? Number(active.chatId) : active.chatId;
  await callTelegram("setMyCommands", {
    commands,
    scope: { type: "chat", chat_id: chatId },
  }, active);
  await callTelegram("setChatMenuButton", {
    menu_button: { type: "commands" },
  }, active);
  runtimeState.lastTelegramMenuAt = new Date().toISOString();
  runtimeState.lastTelegramMenuError = "";
  writeJson(STATE_FILE, runtimeState);
}

function telegramCommand(text) {
  const first = String(text || "").trim().split(/\s+/)[0].toLowerCase();
  if (!first.startsWith("/")) return "";
  return first.split("@")[0];
}

function isAuthorizedTelegramMessage(message) {
  if (!message || !message.chat) return false;
  if (String(message.chat.id) !== String(config.chatId)) return false;
  if (config.messageThreadId) {
    return String(message.message_thread_id || "") === String(config.messageThreadId);
  }
  return true;
}

function telegramHelpText() {
  return [
    "🤖 Komari 中国方向延迟告警",
    "/check - 立即检测并累计异常次数",
    "/status - 查看最近一次检测状态",
    "/alerts - 只查看异常和等待确认",
    "/help - 查看命令帮助",
  ].join("\n");
}

function isAttentionState(state) {
  return Boolean(state && (state.alertActive || state.status === "alert" || state.status === "pending"));
}

function failureReasonLabel(reason) {
  return {
    missing: "无记录",
    stale: "数据过期",
    failed: "Ping 失败",
    query_error: "查询错误",
  }[reason] || "未知错误";
}

function failureReasonSummary(evaluation) {
  const counts = {};
  asArray(evaluation && evaluation.taskResults).filter((item) => item.failed).forEach((item) => {
    const label = failureReasonLabel(item.reason);
    counts[label] = Number(counts[label] || 0) + 1;
  });
  return Object.entries(counts).map(([label, count]) => `${label} ${count}`).join("、") || "无";
}

function formatDurationSince(value, nowMs) {
  const startedAt = Date.parse(value || "");
  if (!Number.isFinite(startedAt)) return "—";
  const seconds = Math.max(0, Math.floor(((Number(nowMs) || Date.now()) - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function orderedStateEntries(options) {
  const alertsOnly = options && options.alertsOnly === true;
  const clients = runtimeState.clients || {};
  const knownIds = Object.keys(clients);
  const orderedIds = orderClientIds(knownIds, config.clientOrder);
  return orderedIds
    .map((uuid) => [uuid, clients[uuid]])
    .filter((entry) => !alertsOnly || isAttentionState(entry[1]));
}

function compactStateLine(uuid, state) {
  const evaluation = state.lastEvaluation || {};
  const name = state.clientName || uuid;
  const failed = Number(evaluation.failed || 0);
  const total = Number(evaluation.total || 0);
  if (state.alertActive || state.status === "alert") return `🚨 ${name}　${failed}/${total}　已告警`;
  if (state.status === "pending") return `🟡 ${name}　${failed}/${total}　确认中 ${Number(state.failureStreak || 0)}/${config.failureCycles}`;
  if (state.status === "offline") return `⚫ ${name}　Agent 离线`;
  if (state.status === "insufficient") return `🟠 ${name}　目标不足 ${total}/${config.minimumFailedTargets}`;
  if (state.status === "normal") return `✅ ${name}　${failed}/${total}　正常`;
  return `❔ ${name}　未检测`;
}

function buildCompactSummary(title, entries) {
  if (entries.length === 0) return `${title}\n暂无结果`;
  const lines = [title, ""];
  let omitted = 0;
  let limitReached = false;
  entries.forEach(([uuid, state], index) => {
    if (limitReached) {
      omitted += 1;
      return;
    }
    const line = `${index + 1}. ${compactStateLine(uuid, state)}`;
    if ([...lines, line, "", `时间：${formatTime(Date.now())}`].join("\n").length > 3800) {
      omitted += 1;
      limitReached = true;
      return;
    }
    lines.push(line);
  });
  if (omitted) lines.push(`…另有 ${omitted} 台未显示`);
  lines.push("", `时间：${formatTime(Date.now())}`);
  return lines.join("\n");
}

function statusSummary(options) {
  const alertsOnly = options && options.alertsOnly === true;
  const entries = orderedStateEntries({ alertsOnly });
  if (entries.length === 0) {
    return alertsOnly
      ? "✅ 当前没有异常告警或等待确认的服务器。"
      : "📊 暂无检测记录，请发送 /check 开始检测。";
  }
  return buildCompactSummary(
    alertsOnly ? `🚨 异常节点 · ${entries.length} 台` : `📊 当前状态 · ${entries.length} 台`,
    entries,
  );
}

function manualCheckSummary() {
  return statusSummary();
}

async function fetchTelegramUpdates() {
  const response = await callTelegram("getUpdates", {
      offset: Number(runtimeState.telegramUpdateOffset || 0),
      limit: 20,
      timeout: 0,
      allowed_updates: ["message"],
    }, config);
  const result = response;
  return asArray(result.result);
}

async function handleTelegramMessage(message) {
  if (!isAuthorizedTelegramMessage(message)) return;
  const command = telegramCommand(message.text);
  if (!command) return;

  if (command === "/check") {
    await sendTelegram("🔎 已收到手动检测命令，正在检查所有已配置服务器…");
    const result = await runCheck("telegram");
    if (result.skipped) {
      await sendTelegram(`⏳ ${result.reason}`);
    } else {
      await sendTelegram(manualCheckSummary());
      acknowledgePendingNotifications(result.clientIds);
      writeJson(STATE_FILE, runtimeState);
    }
    return;
  }
  if (command === "/status") {
    await sendTelegram(statusSummary());
    return;
  }
  if (command === "/alerts") {
    await sendTelegram(statusSummary({ alertsOnly: true }));
    return;
  }
  if (command === "/help" || command === "/start") {
    await sendTelegram(telegramHelpText());
    return;
  }
  await sendTelegram(`不支持命令 ${command}\n\n${telegramHelpText()}`);
}

async function pollTelegramCommands() {
  if (commandPollRunning || !config.botToken || !config.chatId) return;
  commandPollRunning = true;
  let stateChanged = false;
  const previousPollError = runtimeState.lastTelegramPollError || "";
  try {
    validateTelegramConfig(config);
    const updates = await fetchTelegramUpdates();
    for (const update of updates) {
      if (Number.isFinite(Number(update.update_id))) {
        runtimeState.telegramUpdateOffset = Math.max(
          Number(runtimeState.telegramUpdateOffset || 0),
          Number(update.update_id) + 1,
        );
        stateChanged = true;
      }
      try {
        await handleTelegramMessage(update.message);
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] 处理 Telegram 命令失败: ${error.message}`);
        try {
          if (isAuthorizedTelegramMessage(update.message)) {
            await sendTelegram(`❌ 命令执行失败：${error.message}`);
          }
        } catch (_sendError) {
          // 下一次轮询继续工作，避免单条回复失败阻塞后续命令。
        }
      }
    }
    runtimeState.lastTelegramPollAt = new Date().toISOString();
    runtimeState.lastTelegramPollError = "";
    stateChanged = stateChanged || updates.length > 0 || Boolean(previousPollError);
  } catch (error) {
    runtimeState.lastTelegramPollAt = new Date().toISOString();
    runtimeState.lastTelegramPollError = error.message;
    stateChanged = previousPollError !== error.message;
    if (stateChanged) {
      console.error(`[${PLUGIN_NAME}] Telegram 命令轮询失败: ${error.message}`);
    }
  } finally {
    if (stateChanged) writeJson(STATE_FILE, runtimeState);
    commandPollRunning = false;
  }
}

function formatTime(value) {
  try {
    return new Date(value || Date.now()).toLocaleString("zh-CN", { hour12: false });
  } catch (_error) {
    return new Date(value || Date.now()).toISOString();
  }
}

function buildAlertMessage(name, evaluation, state) {
  return [
    "⚠️ 疑似中国方向阻断",
    `节点：${name}`,
    `失败：${evaluation.failed}/${evaluation.total}（${failureReasonSummary(evaluation)}）`,
    `时间：${formatTime(Date.now())}`,
  ].join("\n");
}

function buildRecoveryMessage(name, evaluation, state) {
  let duration = "未知";
  const startedAt = state.abnormalStartedAt || state.alertStartedAt;
  if (startedAt) {
    const minutes = Math.max(1, Math.round((Date.now() - Date.parse(startedAt)) / 60000));
    duration = `${minutes} 分钟`;
  }
  return [
    "✅ 中国方向已恢复",
    `节点：${name}`,
    `持续：${duration}`,
    `时间：${formatTime(Date.now())}`,
  ].join("\n");
}

async function trySendPending(clientState) {
  if (!clientState.pendingNotification) return;
  try {
    await sendTelegram(clientState.pendingNotification.text);
    clientState.lastNotificationAt = new Date().toISOString();
    clientState.lastNotificationError = "";
    clientState.pendingNotification = null;
  } catch (error) {
    clientState.lastNotificationError = error.message;
    console.error(`[${PLUGIN_NAME}] Telegram 发送失败: ${error.message}`);
  }
}

function acknowledgePendingNotifications(clientIds) {
  const acknowledgedAt = new Date().toISOString();
  asArray(clientIds).forEach((uuid) => {
    const state = runtimeState.clients && runtimeState.clients[uuid];
    if (!state || !state.pendingNotification) return;
    state.pendingNotification = null;
    state.lastNotificationAt = acknowledgedAt;
    state.lastNotificationError = "";
  });
}

function newClientState() {
  return {
    status: "normal",
    alertActive: false,
    failureStreak: 0,
    recoveryStreak: 0,
    abnormalStartedAt: null,
    alertStartedAt: null,
    lastNormalAt: null,
    lastCheckAt: null,
    lastEvaluation: null,
    lastNotificationAt: null,
    lastNotificationError: "",
    pendingNotification: null,
  };
}

async function collectTaskResults(tasks, uuid, nowMs) {
  const results = [];
  for (const task of tasks) {
    const id = taskId(task);
    try {
      const recordResult = await server.call("common:getRecords", {
        type: "ping",
        uuid,
        task_id: Number.isNaN(Number(id)) ? id : Number(id),
        hours: 1,
        maxCount: 20,
      });
      const records = unwrapRecords(recordResult);
      const latest = latestRecordForClient(records, uuid);
      const evaluated = evaluateTaskRecord(latest, nowMs, config.staleAfterSeconds);
      results.push(Object.assign(evaluated, {
        id,
        name: String(task.name || task.target || `任务 ${id}`),
        target: String(task.target || ""),
      }));
    } catch (error) {
      results.push({
        id,
        name: String(task.name || task.target || `任务 ${id}`),
        target: String(task.target || ""),
        failed: true,
        reason: "query_error",
        value: null,
        time: null,
        error: error.message,
      });
    }
  }
  return results;
}

async function runCheck(trigger, onlyClientId) {
  if (checkRunning) return { skipped: true, reason: "检测正在运行" };
  if (!config.enabled && trigger === "cron") return { skipped: true, reason: "插件监控未启用" };
  if (trigger === "cron" && runtimeState.lastRunAt) {
    const elapsed = Date.now() - Date.parse(runtimeState.lastRunAt);
    if (Number.isFinite(elapsed) && elapsed < config.checkIntervalSeconds * 1000) {
      return { skipped: true, reason: "尚未到达检测间隔" };
    }
  }
  checkRunning = true;
  const now = Date.now();
  try {
    const targetClientIds = onlyClientId
      ? [normalizeId(onlyClientId)]
      : orderClientIds(config.clientIds, config.clientOrder);
    const allTasks = asArray(await server.call("admin:getAllPingTasks"));
    const selectedTasks = allTasks.filter((task) => config.chinaTaskIds.includes(taskId(task)));
    const nodesRaw = await server.call("common:getNodes");
    const nodes = normalizeNodes(nodesRaw);
    const statuses = await server.call("common:getNodesLatestStatus", { uuids: targetClientIds });

    for (const uuid of targetClientIds) {
      const node = nodes.find((item) => item.id === uuid) || { id: uuid, name: uuid };
      const status = getStatusForClient(statuses, uuid);
      const online = isOnlineStatus(status);
      const applicableTasks = selectedTasks.filter((task) => {
        const assignedClients = asArray(task.clients).map(normalizeId);
        return task.default_on === true || assignedClients.includes(uuid);
      });
      const taskResults = await collectTaskResults(applicableTasks, uuid, now);
      const evaluation = computeEvaluation({
        online,
        taskResults,
        minimumFailedTargets: config.minimumFailedTargets,
      });
      const state = runtimeState.clients[uuid] || newClientState();
      state.clientName = node.name;
      if (typeof state.alertActive !== "boolean") {
        state.alertActive = state.status === "alert";
      }
      state.lastCheckAt = new Date(now).toISOString();
      state.lastEvaluation = evaluation;

      if (!online) {
        state.status = "offline";
        state.failureStreak = 0;
        state.recoveryStreak = 0;
        if (!state.alertActive) state.abnormalStartedAt = null;
      } else if (!evaluation.sufficientTargets) {
        state.status = "insufficient";
        state.failureStreak = 0;
        state.recoveryStreak = 0;
        if (!state.alertActive) state.abnormalStartedAt = null;
      } else if (evaluation.abnormal) {
        if (!state.abnormalStartedAt) state.abnormalStartedAt = new Date(now).toISOString();
        state.failureStreak += 1;
        state.recoveryStreak = 0;
        if (!state.alertActive && state.failureStreak >= config.failureCycles) {
          state.alertActive = true;
          state.status = "alert";
          state.alertStartedAt = new Date(now).toISOString();
          state.pendingNotification = {
            kind: "alert",
            text: buildAlertMessage(node.name, evaluation, state),
          };
        } else if (state.alertActive) {
          state.status = "alert";
        } else {
          state.status = "pending";
        }
      } else {
        state.lastNormalAt = new Date(now).toISOString();
        state.failureStreak = 0;
        if (state.alertActive) {
          state.recoveryStreak += 1;
          state.status = "alert";
          if (state.recoveryStreak >= config.recoveryCycles) {
            state.pendingNotification = {
              kind: "recovery",
              text: buildRecoveryMessage(node.name, evaluation, state),
            };
            state.alertActive = false;
            state.status = "normal";
            state.recoveryStreak = 0;
            state.abnormalStartedAt = null;
            state.alertStartedAt = null;
          }
        } else {
          state.status = "normal";
          state.recoveryStreak = 0;
          state.abnormalStartedAt = null;
        }
      }

      if (trigger !== "telegram") await trySendPending(state);
      runtimeState.clients[uuid] = state;
    }

    runtimeState.lastRunAt = new Date(now).toISOString();
    runtimeState.lastRunError = "";
    writeJson(STATE_FILE, runtimeState);
    return { skipped: false, checked: targetClientIds.length, clientIds: targetClientIds, at: runtimeState.lastRunAt };
  } catch (error) {
    runtimeState.lastRunAt = new Date(now).toISOString();
    runtimeState.lastRunError = error.message;
    writeJson(STATE_FILE, runtimeState);
    console.error(`[${PLUGIN_NAME}] 检测失败: ${error.message}`);
    throw error;
  } finally {
    checkRunning = false;
  }
}

function pruneClientStates(clientIds) {
  const selected = new Set(asArray(clientIds).map(normalizeId));
  let removed = 0;
  Object.keys(runtimeState.clients || {}).forEach((uuid) => {
    if (selected.has(uuid)) return;
    delete runtimeState.clients[uuid];
    removed += 1;
  });
  return removed;
}

async function loadBootstrapData() {
  const tasks = asArray(await server.call("admin:getAllPingTasks"));
  const nodes = normalizeNodes(await server.call("common:getNodes"));
  return {
    config: publicConfig(config),
    state: runtimeState,
    nodes,
    tasks: tasks.map((task) => ({
      id: taskId(task),
      name: String(task.name || task.target || `任务 ${taskId(task)}`),
      target: String(task.target || ""),
      type: String(task.type || "icmp"),
      interval: Number(task.interval || 0),
      clients: asArray(task.clients).map(normalizeId),
      defaultOn: task.default_on === true,
    })),
  };
}

function registerRoutes() {
  server.route("GET", "/api/gfw-monitor/bootstrap", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      jsonResponse(res, 200, { ok: true, data: await loadBootstrapData() });
    } catch (error) {
      jsonResponse(res, 500, { ok: false, error: error.message });
    }
  });

  server.route("GET", "/api/gfw-monitor/status", (req, res) => {
    if (!requireAdmin(req, res)) return;
    jsonResponse(res, 200, { ok: true, data: runtimeState });
  });

  server.route("POST", "/api/gfw-monitor/config", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = parseBody(req);
      const next = normalizeConfig(body, config);
      if (next.enabled) {
        if (next.clientIds.length === 0) throw new Error("请至少选择一台监控服务器");
        if (next.chinaTaskIds.length === 0) throw new Error("请至少选择一个国内延迟任务");
        if (next.minimumFailedTargets > next.chinaTaskIds.length) {
          throw new Error("失败目标数不能大于已选择的国内目标数");
        }
        validateTelegramConfig(next);
      }
      config = next;
      const prunedStates = pruneClientStates(config.clientIds);
      writeJson(CONFIG_FILE, config);
      writeJson(STATE_FILE, runtimeState);
      let menuWarning = "";
      if (config.botToken && config.chatId) {
        try {
          await configureTelegramMenu(config);
        } catch (error) {
          menuWarning = error.message;
          runtimeState.lastTelegramMenuError = error.message;
          writeJson(STATE_FILE, runtimeState);
        }
      }
      const responseConfig = publicConfig(config);
      responseConfig.menuWarning = menuWarning;
      responseConfig.prunedStates = prunedStates;
      jsonResponse(res, 200, { ok: true, data: responseConfig });
    } catch (error) {
      jsonResponse(res, error.statusCode || 400, { ok: false, error: error.message });
    }
  });

  server.route("POST", "/api/gfw-monitor/test-telegram", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = parseBody(req);
      const temporary = normalizeConfig(body, config);
      await sendTelegram(
        `✅ Komari 中国方向延迟告警测试成功\n发送时间：${formatTime(Date.now())}`,
        temporary,
      );
      jsonResponse(res, 200, { ok: true });
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error.message });
    }
  });

  server.route("POST", "/api/gfw-monitor/setup-telegram-menu", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = parseBody(req);
      const temporary = normalizeConfig(body, config);
      await configureTelegramMenu(temporary);
      jsonResponse(res, 200, { ok: true });
    } catch (error) {
      runtimeState.lastTelegramMenuError = error.message;
      writeJson(STATE_FILE, runtimeState);
      jsonResponse(res, 400, { ok: false, error: error.message });
    }
  });

  server.route("POST", "/api/gfw-monitor/run", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const result = await runCheck("manual");
      jsonResponse(res, 200, { ok: true, data: result });
    } catch (error) {
      jsonResponse(res, 500, { ok: false, error: error.message });
    }
  });

  server.route("POST", "/api/gfw-monitor/run-client", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const body = parseBody(req);
      const uuid = normalizeId(body.uuid);
      if (!uuid) throw new Error("缺少服务器 UUID");
      if (!config.clientIds.includes(uuid)) throw new Error("该服务器未加入插件监控列表");
      const result = await runCheck("manual-client", uuid);
      jsonResponse(res, 200, { ok: true, data: result });
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error.message });
    }
  });
}

function load() {
  ensureStorage();
  config = normalizeConfig(readJson(CONFIG_FILE, DEFAULT_CONFIG), DEFAULT_CONFIG);
  runtimeState = Object.assign(
    {
      clients: {},
      lastRunAt: null,
      lastRunError: "",
      telegramUpdateOffset: 0,
      lastTelegramPollAt: null,
      lastTelegramPollError: "",
      lastTelegramMenuAt: null,
      lastTelegramMenuError: "",
    },
    readJson(STATE_FILE, {}),
  );
  registerRoutes();
  if (config.botToken && config.chatId) {
    configureTelegramMenu(config).catch((error) => {
      runtimeState.lastTelegramMenuError = error.message;
      writeJson(STATE_FILE, runtimeState);
      console.error(`[${PLUGIN_NAME}] Telegram 菜单同步失败: ${error.message}`);
    });
  }
  server.cron(SCHEDULER_INTERVAL, () => {
    pollTelegramCommands()
      .catch((error) => {
        console.error(`[${PLUGIN_NAME}] Telegram 轮询异常: ${error.message}`);
      })
      .then(() => runCheck("cron"))
      .catch((error) => {
        console.error(`[${PLUGIN_NAME}] 定时检测异常: ${error.message}`);
      });
  });
  console.log(`[${PLUGIN_NAME}] 插件已加载，默认检测周期 ${config.checkIntervalSeconds} 秒`);
}

function unload() {
  writeJson(STATE_FILE, runtimeState);
  console.log(`[${PLUGIN_NAME}] 插件已卸载`);
}
