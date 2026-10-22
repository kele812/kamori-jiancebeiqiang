const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");
assert.ok(source.includes("🔎 已收到手动检测命令，正在检查所有已配置服务器…"));
const sandbox = {
  console,
  __storageDir__: __dirname,
  fetch: async () => { throw new Error("not used"); },
  require(name) {
    if (name === "server") return {};
    return require(name);
  },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "script.js" });

const now = Date.now();
const ok = sandbox.evaluateTaskRecord({ value: 42, time: new Date(now).toISOString() }, now, 150);
assert.equal(ok.failed, false);

const failed = sandbox.evaluateTaskRecord({ value: -1, time: new Date(now).toISOString() }, now, 150);
assert.equal(failed.failed, true);
assert.equal(failed.reason, "failed");

const stale = sandbox.evaluateTaskRecord({ value: 42, time: new Date(now - 180000).toISOString() }, now, 150);
assert.equal(stale.failed, true);
assert.equal(stale.reason, "stale");

const evaluation = sandbox.computeEvaluation({
  online: true,
  minimumFailedTargets: 5,
  taskResults: [true, true, true, true, true, false].map((value) => ({ failed: value })),
});
assert.equal(evaluation.abnormal, true);
assert.equal(evaluation.failed, 5);

const offline = sandbox.computeEvaluation({
  online: false,
  minimumFailedTargets: 5,
  taskResults: [true, true, true, true, true, true].map((value) => ({ failed: value })),
});
assert.equal(offline.abnormal, false);

const insufficient = sandbox.computeEvaluation({
  online: true,
  minimumFailedTargets: 5,
  taskResults: [true, true, true, true].map((value) => ({ failed: value })),
});
assert.equal(insufficient.abnormal, false);
assert.equal(insufficient.sufficientTargets, false);

assert.equal(sandbox.telegramCommand("/check"), "/check");
assert.equal(sandbox.telegramCommand("/alerts"), "/alerts");
assert.equal(sandbox.telegramCommand("/CHECK@MyBot now"), "/check");
assert.equal(sandbox.telegramCommand("普通消息"), "");

const taggedNodes = sandbox.normalizeNodes({
  "node-1": {
    uuid: "node-1",
    name: "洛杉矶",
    tags: "美国;CN2;生产",
    group: "美国节点",
    ipv4: "203.0.113.10",
    ipv6: "2001:db8::10",
  },
});
assert.deepEqual(Array.from(taggedNodes[0].tags), ["美国", "CN2", "生产"]);
assert.equal(taggedNodes[0].group, "美国节点");
assert.equal(taggedNodes[0].ipv4, "203.0.113.10");
assert.equal(taggedNodes[0].ipv6, "2001:db8::10");

assert.equal(sandbox.failureReasonLabel("missing"), "无记录");
assert.equal(sandbox.failureReasonLabel("stale"), "数据过期");
assert.equal(sandbox.failureReasonLabel("failed"), "Ping 失败");
assert.equal(sandbox.failureReasonLabel("query_error"), "查询错误");
assert.equal(sandbox.failureReasonSummary({
  taskResults: [
    { failed: true, reason: "missing" },
    { failed: true, reason: "missing" },
    { failed: true, reason: "stale" },
    { failed: false, reason: "ok" },
  ],
}), "无记录 2、数据过期 1");
assert.equal(sandbox.formatDurationSince(new Date(now - 3700000).toISOString(), now), "1 小时 1 分钟");
assert.deepEqual(Array.from(sandbox.orderClientIds(["node-1", "node-2", "node-3"], ["node-2", "node-1"])), ["node-2", "node-1", "node-3"]);

const orderedConfig = sandbox.normalizeConfig({
  clientIds: ["node-1", "node-2", "node-3"],
  clientOrder: ["node-3", "removed", "node-1"],
}, {});
assert.deepEqual(Array.from(orderedConfig.clientOrder), ["node-3", "node-1", "node-2"]);

const sortedStatus = vm.runInContext(`
  runtimeState = {
    clients: {
      normal: { status: "normal", alertActive: false, clientName: "正常机器", failureStreak: 0, lastEvaluation: { failed: 0, total: 6 } },
      alert: { status: "alert", alertActive: true, clientName: "异常机器", failureStreak: 3, lastEvaluation: { failed: 6, total: 6 } }
    },
    lastRunAt: null
  };
  config.failureCycles = 3;
  config.clientOrder = ["alert", "normal"];
  statusSummary();
`, sandbox);
assert.ok(sortedStatus.indexOf("异常机器") < sortedStatus.indexOf("正常机器"));

const alertsOnlyStatus = vm.runInContext(`
  runtimeState = {
    clients: {
      normal: { status: "normal", alertActive: false, clientName: "正常机器", failureStreak: 0, lastEvaluation: { failed: 0, total: 6, taskResults: [] } },
      pending: { status: "pending", alertActive: false, clientName: "等待机器", failureStreak: 2, lastEvaluation: { failed: 5, total: 6, taskResults: [] } },
      offlineAlert: { status: "offline", alertActive: true, clientName: "离线告警机器", failureStreak: 0, lastEvaluation: { failed: 6, total: 6, taskResults: [] } }
    },
    lastRunAt: null
  };
  config.clientOrder = ["offlineAlert", "pending", "normal"];
  statusSummary({ alertsOnly: true });
`, sandbox);
assert.ok(alertsOnlyStatus.includes("等待机器"));
assert.ok(alertsOnlyStatus.includes("离线告警机器"));
assert.ok(!alertsOnlyStatus.includes("正常机器"));
assert.ok(alertsOnlyStatus.indexOf("离线告警机器") < alertsOnlyStatus.indexOf("等待机器"));

const alertText = sandbox.buildAlertMessage("美国-01", {
  failed: 5,
  total: 6,
  taskResults: [
    { failed: true, reason: "missing" },
    { failed: true, reason: "missing" },
    { failed: true, reason: "stale" },
  ],
}, {});
assert.ok(alertText.includes("节点：美国-01"));
assert.ok(alertText.includes("失败：5/6（无记录 2、数据过期 1）"));
assert.ok(!alertText.includes("异常目标"));

const allNormalSummary = vm.runInContext(`
  runtimeState = {
    clients: {
      first: { status: "normal", alertActive: false, clientName: "第一台", lastEvaluation: { failed: 0, total: 6 } },
      second: { status: "normal", alertActive: false, clientName: "第二台", lastEvaluation: { failed: 0, total: 6 } }
    }
  };
  config.clientOrder = ["second", "first"];
  manualCheckSummary();
`, sandbox);
assert.ok(allNormalSummary.includes("📊 当前状态 · 2 台"));
assert.ok(allNormalSummary.indexOf("第二台") < allNormalSummary.indexOf("第一台"));
assert.ok(allNormalSummary.includes("1. ✅ 第二台"));
assert.ok(allNormalSummary.includes("2. ✅ 第一台"));

const acknowledged = vm.runInContext(`
  runtimeState = { clients: { node: { pendingNotification: { kind: "alert", text: "待发送" }, lastNotificationAt: null, lastNotificationError: "旧错误" } } };
  acknowledgePendingNotifications(["node"]);
  runtimeState.clients.node;
`, sandbox);
assert.equal(acknowledged.pendingNotification, null);
assert.ok(acknowledged.lastNotificationAt);
assert.equal(acknowledged.lastNotificationError, "");

const pruned = vm.runInContext(`
  runtimeState = { clients: { keep: {}, remove: {} } };
  pruneClientStates(["keep"]);
`, sandbox);
assert.equal(pruned, 1);
assert.equal(vm.runInContext(`Object.prototype.hasOwnProperty.call(runtimeState.clients, "remove")`, sandbox), false);

console.log("core tests passed");
