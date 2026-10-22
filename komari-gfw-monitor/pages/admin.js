const API = "/api/gfw-monitor";
let model = { config: {}, nodes: [], tasks: [], state: { clients: {} } };

const byId = (id) => document.getElementById(id);

function showNotice(message, kind = "success") {
  const notice = byId("notice");
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => notice.classList.add("hidden"), 5000);
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body.data;
}

function checkedValues(selector) {
  return Array.from(document.querySelectorAll(selector)).filter((input) => input.checked).map((input) => input.value);
}

function updateCounts() {
  byId("clientCount").textContent = `${checkedValues('[name="clientIds"]').length} 已选`;
  byId("taskCount").textContent = `${checkedValues('[name="chinaTaskIds"]').length} 已选`;
}

function filterClients() {
  const query = byId("clientSearch").value.trim().toLowerCase();
  const items = Array.from(byId("clientList").querySelectorAll(".check-item"));
  let visible = 0;
  items.forEach((item) => {
    const searchable = `${item.dataset.search || ""} ${item.textContent || ""}`.toLowerCase();
    const matched = !query || searchable.includes(query);
    item.hidden = !matched;
    item.classList.toggle("filtered-out", !matched);
    if (matched) visible += 1;
  });
  byId("clientFilterResult").textContent = query
    ? `找到 ${visible} 台服务器，共 ${items.length} 台`
    : `共 ${items.length} 台服务器`;
}

function setVisibleClientsChecked(checked) {
  const items = Array.from(byId("clientList").querySelectorAll(".check-item"));
  items.forEach((item) => {
    if (item.hidden) return;
    const input = item.querySelector('input[name="clientIds"]');
    if (input) input.checked = checked;
  });
  updateCounts();
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderSelections() {
  const selectedClients = new Set(model.config.clientIds || []);
  const selectedTasks = new Set(model.config.chinaTaskIds || []);

  byId("clientList").classList.remove("loading");
  byId("clientList").innerHTML = model.nodes.length
    ? model.nodes.map((node) => {
      const tags = Array.isArray(node.tags) ? node.tags : [];
      const tagText = tags.join(" ");
      const tagHtml = tags.length
        ? `<span class="tag-list">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</span>`
        : "";
      const details = [
        node.group ? `分组：${node.group}` : "",
        node.ipv4 ? `IPv4：${node.ipv4}` : "",
        node.ipv6 ? `IPv6：${node.ipv6}` : "",
      ].filter(Boolean);
      const detailsHtml = details.length
        ? `<span class="node-details">${details.map((detail) => `<span>${escapeHtml(detail)}</span>`).join("")}</span>`
        : "";
      return `
      <label class="check-item" data-search="${escapeHtml(`${node.name} ${node.id} ${tagText} ${node.group || ""} ${node.ipv4 || ""} ${node.ipv6 || ""}`.toLowerCase())}">
        <input type="checkbox" name="clientIds" value="${escapeHtml(node.id)}" ${selectedClients.has(node.id) ? "checked" : ""} />
        <span class="check-copy"><strong>${escapeHtml(node.name)}</strong><span>${escapeHtml(node.id)}</span>${detailsHtml}${tagHtml}</span>
      </label>`;
    }).join("")
    : '<div class="empty">没有找到服务器节点</div>';

  byId("taskList").classList.remove("loading");
  byId("taskList").innerHTML = model.tasks.length
    ? model.tasks.map((task) => `
      <label class="check-item">
        <input type="checkbox" name="chinaTaskIds" value="${escapeHtml(task.id)}" ${selectedTasks.has(task.id) ? "checked" : ""} />
        <span class="check-copy"><strong>${escapeHtml(task.name)}</strong><span>${escapeHtml(task.target)} · ${escapeHtml(task.type)} · ${task.interval || "?"} 秒</span></span>
      </label>`).join("")
    : '<div class="empty">没有找到延迟任务，请先在 Komari 中添加</div>';

  document.querySelectorAll('.check-list input[type="checkbox"]').forEach((input) => input.addEventListener("change", updateCounts));
  updateCounts();
  filterClients();
}

function stateLabel(status) {
  return {
    normal: "正常",
    alert: "异常告警",
    pending: "等待确认",
    offline: "Agent 离线",
    insufficient: "目标不足",
  }[status] || "未检测";
}

function failureReasonLabel(reason) {
  return {
    missing: "无记录",
    stale: "数据过期",
    failed: "Ping 失败",
    query_error: "查询错误",
  }[reason] || "未知错误";
}

function failureDetails(evaluation) {
  const failed = Array.isArray(evaluation.taskResults)
    ? evaluation.taskResults.filter((item) => item.failed)
    : [];
  if (!failed.length) return '<span class="failure-ok">无</span>';
  const counts = {};
  failed.forEach((item) => {
    const label = failureReasonLabel(item.reason);
    counts[label] = Number(counts[label] || 0) + 1;
  });
  const summary = Object.entries(counts).map(([label, count]) => `${label} ${count}`).join("、");
  const rows = failed.map((item) => {
    const extra = item.error ? `：${item.error}` : "";
    return `<div><strong>${escapeHtml(item.name || item.target || item.id || "未知目标")}</strong><span>${escapeHtml(failureReasonLabel(item.reason) + extra)}</span></div>`;
  }).join("");
  return `<details class="failure-details"><summary>${escapeHtml(summary)}</summary>${rows}</details>`;
}

function formatDurationSince(value) {
  const startedAt = Date.parse(value || "");
  if (!Number.isFinite(startedAt)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
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

function orderClientIds(clientIds, preferredOrder) {
  const ids = Array.from(new Set((clientIds || []).map(String)));
  const available = new Set(ids);
  const ordered = [];
  (preferredOrder || []).map(String).forEach((uuid) => {
    if (!available.has(uuid) || ordered.includes(uuid)) return;
    ordered.push(uuid);
  });
  ids.forEach((uuid) => {
    if (!ordered.includes(uuid)) ordered.push(uuid);
  });
  return ordered;
}

function renderStatus() {
  const clients = model.state && model.state.clients ? model.state.clients : {};
  const rows = orderClientIds(Object.keys(clients), model.config.clientOrder).map((uuid) => [uuid, clients[uuid]]);
  byId("statusBody").innerHTML = rows.length
    ? rows.map(([uuid, state]) => {
      const node = model.nodes.find((item) => item.id === uuid);
      const evaluation = state.lastEvaluation || {};
      const notifyText = state.lastNotificationError
        ? `失败：${state.lastNotificationError}`
        : state.lastNotificationAt ? new Date(state.lastNotificationAt).toLocaleString() : "未发送";
      return `<tr draggable="true" data-client-id="${escapeHtml(uuid)}">
        <td class="drag-handle" title="拖动调整顺序" aria-label="拖动调整顺序">↕</td>
        <td>${escapeHtml(node ? node.name : uuid)}</td>
        <td><span class="badge ${escapeHtml(state.status || "offline")}">${escapeHtml(stateLabel(state.status))}</span></td>
        <td><div class="failure-count">${Number(evaluation.failed || 0)} / ${Number(evaluation.total || 0)}</div>${failureDetails(evaluation)}</td>
        <td>${Number(state.failureStreak || 0)}</td>
        <td>${state.lastNormalAt ? escapeHtml(new Date(state.lastNormalAt).toLocaleString()) : "—"}</td>
        <td>${escapeHtml(formatDurationSince(state.abnormalStartedAt || state.alertStartedAt))}</td>
        <td>${state.lastCheckAt ? escapeHtml(new Date(state.lastCheckAt).toLocaleString()) : "—"}</td>
        <td title="${escapeHtml(notifyText)}">${escapeHtml(notifyText)}</td>
        <td><button class="button ghost row-test" type="button" data-client-id="${escapeHtml(uuid)}">单独测试</button></td>
      </tr>`;
    }).join("")
    : '<tr><td colspan="10" class="empty">尚无检测记录</td></tr>';
}

function fillForm() {
  const cfg = model.config;
  byId("enabled").checked = cfg.enabled === true;
  byId("chatId").value = cfg.chatId || "";
  byId("messageThreadId").value = cfg.messageThreadId || "";
  byId("minimumFailedTargets").value = cfg.minimumFailedTargets || 5;
  byId("failureCycles").value = cfg.failureCycles || 3;
  byId("recoveryCycles").value = cfg.recoveryCycles || 2;
  byId("checkIntervalSeconds").value = cfg.checkIntervalSeconds || 60;
  byId("staleAfterSeconds").value = cfg.staleAfterSeconds || 150;
  byId("botToken").value = "";
  byId("botToken").placeholder = cfg.botTokenConfigured ? "已配置，留空则保持不变" : "123456789:AA...";
  byId("tokenHint").textContent = cfg.botTokenConfigured
    ? `当前 Token：${cfg.botTokenMasked}。留空保存不会覆盖。`
    : "Token 只保存在 Komari 插件数据目录中。";
  const pollError = model.state && model.state.lastTelegramPollError;
  const pollAt = model.state && model.state.lastTelegramPollAt;
  byId("telegramPollStatus").textContent = pollError
    ? `命令轮询错误：${pollError}`
    : pollAt ? `命令轮询正常，最近检查：${new Date(pollAt).toLocaleString()}` : "保存配置后，机器人将每 10 秒检查一次命令。";
  byId("telegramPollStatus").className = pollError ? "inline-error" : "";
  const menuError = model.state && model.state.lastTelegramMenuError;
  const menuAt = model.state && model.state.lastTelegramMenuAt;
  byId("telegramMenuStatus").textContent = menuError
    ? `菜单同步错误：${menuError}`
    : menuAt ? `机器人菜单已同步：${new Date(menuAt).toLocaleString()}` : "保存设置后会自动注册机器人命令菜单。";
  byId("telegramMenuStatus").className = menuError ? "inline-error" : "";
}

function formData() {
  return {
    enabled: byId("enabled").checked,
    botToken: byId("botToken").value.trim(),
    chatId: byId("chatId").value.trim(),
    messageThreadId: byId("messageThreadId").value.trim(),
    minimumFailedTargets: Number(byId("minimumFailedTargets").value),
    failureCycles: Number(byId("failureCycles").value),
    recoveryCycles: Number(byId("recoveryCycles").value),
    checkIntervalSeconds: Number(byId("checkIntervalSeconds").value),
    staleAfterSeconds: Number(byId("staleAfterSeconds").value),
    clientIds: checkedValues('[name="clientIds"]'),
    clientOrder: model.config.clientOrder || [],
    chinaTaskIds: checkedValues('[name="chinaTaskIds"]'),
  };
}

async function loadData(showMessage = false) {
  try {
    const data = await request("/bootstrap");
    model = data;
    fillForm();
    renderSelections();
    renderStatus();
    if (showMessage) showNotice("数据已刷新");
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function withButton(button, work) {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "处理中…";
  try {
    await work();
  } catch (error) {
    showNotice(error.message || "操作失败", "error");
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

byId("save").addEventListener("click", () => withButton(byId("save"), async () => {
  const savedConfig = await request("/config", { method: "POST", body: JSON.stringify(formData()) });
  const menuWarning = savedConfig.menuWarning || "";
  const prunedStates = Number(savedConfig.prunedStates || 0);
  await loadData();
  const cleanupText = prunedStates ? `，已清理 ${prunedStates} 条取消监控的旧状态` : "";
  showNotice(menuWarning ? `设置已保存${cleanupText}，但菜单同步失败：${menuWarning}` : `设置已保存${cleanupText}，Telegram 菜单已同步`, menuWarning ? "error" : "success");
}));

byId("testTelegram").addEventListener("click", () => withButton(byId("testTelegram"), async () => {
  await request("/test-telegram", { method: "POST", body: JSON.stringify(formData()) });
  showNotice("Telegram 测试消息已发送");
}));

byId("setupTelegramMenu").addEventListener("click", () => withButton(byId("setupTelegramMenu"), async () => {
  await request("/setup-telegram-menu", { method: "POST", body: JSON.stringify(formData()) });
  await loadData();
  showNotice("Telegram 命令菜单已同步");
}));

byId("runNow").addEventListener("click", () => withButton(byId("runNow"), async () => {
  await request("/run", { method: "POST", body: "{}" });
  await loadData();
  showNotice("检测已完成");
}));

byId("refresh").addEventListener("click", () => loadData(true));
byId("clientSearch").addEventListener("input", filterClients);
byId("clientSearch").addEventListener("search", filterClients);
byId("clearClientSearch").addEventListener("click", () => {
  byId("clientSearch").value = "";
  filterClients();
  byId("clientSearch").focus();
});
byId("selectVisibleClients").addEventListener("click", () => setVisibleClientsChecked(true));
byId("unselectVisibleClients").addEventListener("click", () => setVisibleClientsChecked(false));
let draggedStatusRow = null;
byId("statusBody").addEventListener("dragstart", (event) => {
  const row = event.target.closest('tr[data-client-id]');
  if (!row) return;
  draggedStatusRow = row;
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", row.dataset.clientId);
});
byId("statusBody").addEventListener("dragover", (event) => {
  if (!draggedStatusRow) return;
  const target = event.target.closest('tr[data-client-id]');
  if (!target || target === draggedStatusRow) return;
  event.preventDefault();
  const rect = target.getBoundingClientRect();
  const insertAfter = event.clientY > rect.top + rect.height / 2;
  target.parentNode.insertBefore(draggedStatusRow, insertAfter ? target.nextSibling : target);
});
byId("statusBody").addEventListener("drop", (event) => {
  if (!draggedStatusRow) return;
  event.preventDefault();
  const visibleOrder = Array.from(byId("statusBody").querySelectorAll('tr[data-client-id]')).map((row) => row.dataset.clientId);
  const selectedIds = checkedValues('[name="clientIds"]');
  model.config.clientOrder = orderClientIds(selectedIds, visibleOrder);
  showNotice("节点顺序已调整，点击“保存设置”后生效");
});
byId("statusBody").addEventListener("dragend", () => {
  if (draggedStatusRow) draggedStatusRow.classList.remove("dragging");
  draggedStatusRow = null;
});
byId("statusBody").addEventListener("click", (event) => {
  const button = event.target.closest(".row-test");
  if (!button) return;
  withButton(button, async () => {
    const result = await request("/run-client", {
      method: "POST",
      body: JSON.stringify({ uuid: button.dataset.clientId }),
    });
    if (result && result.skipped) throw new Error(result.reason || "检测未执行");
    await loadData();
    showNotice("该服务器已完成单独测试");
  });
});
loadData();
