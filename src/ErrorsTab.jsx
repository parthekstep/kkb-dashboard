import { useMemo, useState } from "react";

const fmtNum = (n) => Number(n || 0).toLocaleString("en-IN");

function parseBatchIds(s) {
  return (s || "")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

async function retryError({ call_id, task, timestamp_ist, batch_ids }) {
  const res = await fetch("/api/retry-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call_id, task, timestamp_ist, batch_ids }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok, message: data.message || `HTTP ${res.status}` };
}
const truthy = (v) => String(v ?? "").trim().toLowerCase() === "true";

function parseTimestamp(s) {
  // "YYYY-MM-DD HH:MM:SS" stored in IST. Treat as IST (UTC+5:30).
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  // Convert to UTC ms by subtracting 5:30
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - 5.5 * 3600 * 1000;
  return utcMs;
}

export function computeErrorBadge(rows) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return rows.reduce((n, r) => {
    const t = parseTimestamp(r.timestamp_ist);
    return n + (t !== null && t >= cutoff ? 1 : 0);
  }, 0);
}

function Card({ title, value, subtext, borderColor, children }) {
  return (
    <div
      className="bg-[#F8F9FA] rounded-lg p-4 shadow-sm flex flex-col justify-between min-h-[120px]"
      style={borderColor ? { borderLeft: `4px solid ${borderColor}` } : {}}
    >
      <div className="text-sm font-medium text-gray-600">{title}</div>
      {children ?? (
        <div className="text-3xl font-semibold text-[#1F3864] mt-2">{value}</div>
      )}
      {subtext && <div className="text-xs text-gray-500 mt-1">{subtext}</div>}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-[#F8F9FA] rounded-lg p-4 min-h-[120px] animate-pulse">
      <div className="h-3 bg-gray-200 rounded w-1/2 mb-3" />
      <div className="h-8 bg-gray-200 rounded w-3/4 mb-2" />
      <div className="h-3 bg-gray-200 rounded w-2/3" />
    </div>
  );
}

function TaskPill({ task }) {
  const t = String(task ?? "").trim().toLowerCase();
  const style =
    t === "metrics"
      ? "bg-blue-100 text-blue-800"
      : t === "profile"
      ? "bg-purple-100 text-purple-800"
      : "bg-gray-100 text-gray-700";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${style}`}>
      {task || "—"}
    </span>
  );
}

function StatusBadge({ retryAttempted, retrySucceeded }) {
  if (!retryAttempted) {
    return (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
        No retry
      </span>
    );
  }
  if (retrySucceeded) {
    return (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
        Recovered
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
      Failed
    </span>
  );
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export default function ErrorsTab({ rows, loading, error, onRetry }) {
  const [taskFilter, setTaskFilter] = useState("all");
  const [batchIdsText, setBatchIdsText] = useState("");
  // Map<rowKey, {status:'idle'|'retrying'|'recovered'|'failed', message?:string}>
  const [retryState, setRetryState] = useState({});

  const handleRetry = async (r, key) => {
    setRetryState((s) => ({ ...s, [key]: { status: "retrying" } }));
    const batch_ids = parseBatchIds(batchIdsText);
    const { ok, message } = await retryError({
      call_id: r.call_id,
      task: r.task,
      timestamp_ist: r.timestamp_ist,
      batch_ids,
    });
    setRetryState((s) => ({
      ...s,
      [key]: { status: ok ? "recovered" : "failed", message },
    }));
    // Re-pull errors list so the recovered row disappears (and any new error from a failed retry shows up).
    setTimeout(() => onRetry?.(), 800);
  };

  const summary = useMemo(() => {
    const total = rows.length;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let last24 = 0;
    let retried = 0;
    let recovered = 0;
    let metricsCount = 0;
    let profileCount = 0;
    for (const r of rows) {
      const t = parseTimestamp(r.timestamp_ist);
      if (t !== null && t >= cutoff) last24 += 1;
      const ra = truthy(r.retry_attempted);
      const rs = truthy(r.retry_succeeded);
      if (ra) retried += 1;
      if (ra && rs) recovered += 1;
      const task = String(r.task ?? "").trim().toLowerCase();
      if (task === "metrics") metricsCount += 1;
      else if (task === "profile") profileCount += 1;
    }
    return {
      total,
      last24,
      retrySuccessRate: retried > 0 ? (recovered / retried) * 100 : null,
      metricsCount,
      profileCount,
    };
  }, [rows]);

  const sortedFiltered = useMemo(() => {
    const filtered =
      taskFilter === "all"
        ? rows
        : rows.filter(
            (r) =>
              String(r.task ?? "").trim().toLowerCase() === taskFilter
          );
    const withTs = filtered.map((r) => ({
      r,
      t: parseTimestamp(r.timestamp_ist) ?? -Infinity,
    }));
    withTs.sort((a, b) => b.t - a.t);
    return withTs.map((x) => x.r);
  }, [rows, taskFilter]);

  if (error) {
    return (
      <div className="border border-red-300 bg-red-50 rounded p-4 mb-6 flex items-center justify-between">
        <span className="text-sm text-red-700">
          Failed to load errors: {error}
        </span>
        <button
          onClick={onRetry}
          className="bg-red-600 text-white rounded px-3 py-1.5 text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-[#1F3864] mb-3">
          Error Summary
        </h2>
        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card title="Total Errors" value={fmtNum(summary.total)} />
            <Card
              title="Last 24 Hours"
              value={fmtNum(summary.last24)}
              borderColor="#EF4444"
            />
            <Card
              title="Retry Success Rate"
              value={
                summary.retrySuccessRate === null
                  ? "N/A"
                  : `${summary.retrySuccessRate.toFixed(0)}%`
              }
              borderColor="#F59E0B"
              subtext="Recovered ÷ retried"
            />
            <Card title="Errors by Task">
              <div className="mt-2 flex gap-6">
                <div>
                  <div className="text-xs text-gray-500">Metrics</div>
                  <div className="text-2xl font-semibold text-[#1F3864]">
                    {fmtNum(summary.metricsCount)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Profile</div>
                  <div className="text-2xl font-semibold text-[#1F3864]">
                    {fmtNum(summary.profileCount)}
                  </div>
                </div>
              </div>
            </Card>
          </div>
        )}
      </section>

      <section className="mb-6">
        <div className="bg-[#F8F9FA] rounded-lg p-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col flex-1 min-w-[300px]">
            <label className="text-xs text-gray-600 mb-1">
              Batch IDs (for retry — comma or space separated). Needed so we can
              recover <code>contact_id</code> for profile retries.
            </label>
            <input
              type="text"
              value={batchIdsText}
              onChange={(e) => setBatchIdsText(e.target.value)}
              placeholder="e.g. 1601, 1602"
              className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
            />
          </div>
          <div className="text-xs text-gray-500">
            {parseBatchIds(batchIdsText).length} batch ID(s) provided
          </div>
        </div>
      </section>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-[#1F3864]">Errors</h2>
          <div className="flex items-center gap-1">
            {[
              { k: "all", label: "All Tasks" },
              { k: "metrics", label: "Metrics" },
              { k: "profile", label: "Profile" },
            ].map((opt) => (
              <button
                key={opt.k}
                onClick={() => setTaskFilter(opt.k)}
                className={`px-3 py-1.5 text-sm rounded border ${
                  taskFilter === opt.k
                    ? "bg-[#1F3864] text-white border-[#1F3864]"
                    : "bg-white border-gray-300 hover:bg-gray-50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-[#F8F9FA] rounded-lg overflow-hidden">
          {loading ? (
            <div className="p-6 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-8 bg-gray-200 rounded animate-pulse"
                />
              ))}
            </div>
          ) : sortedFiltered.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-500">
              No errors to display.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white border-b border-gray-200">
                  <tr className="text-left text-xs font-medium text-gray-600 uppercase">
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Call ID</th>
                    <th className="px-4 py-3">Phone</th>
                    <th className="px-4 py-3">Task</th>
                    <th className="px-4 py-3">Error Message</th>
                    <th className="px-4 py-3">Retry</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedFiltered.map((r, idx) => {
                    const ra = truthy(r.retry_attempted);
                    const rs = truthy(r.retry_succeeded);
                    const callId = r.call_id ?? "";
                    const shortCallId =
                      callId.length > 8 ? callId.slice(0, 8) + "…" : callId;
                    const rowKey = `${callId}-${r.timestamp_ist}-${idx}`;
                    const rState = retryState[rowKey] || { status: "idle" };
                    return (
                      <tr
                        key={rowKey}
                        className="border-b border-gray-200 last:border-0 hover:bg-white/60"
                      >
                        <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                          {r.timestamp_ist || "—"}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-700" title={callId}>
                          {shortCallId || "—"}
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          {r.phone || "—"}
                        </td>
                        <td className="px-4 py-3">
                          <TaskPill task={r.task} />
                        </td>
                        <td
                          className="px-4 py-3 text-gray-700 max-w-md"
                          title={r.error_message || ""}
                        >
                          {truncate(r.error_message, 80) || "—"}
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          {ra ? "Yes" : "No"}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge
                            retryAttempted={ra}
                            retrySucceeded={rs}
                          />
                        </td>
                        <td className="px-4 py-3">
                          {rState.status === "retrying" ? (
                            <span className="text-xs text-gray-500">Retrying…</span>
                          ) : rState.status === "recovered" ? (
                            <span className="text-xs text-green-700">✓ Recovered</span>
                          ) : rState.status === "failed" ? (
                            <div className="flex flex-col gap-1">
                              <span className="text-xs text-red-700" title={rState.message}>
                                ✗ Failed
                              </span>
                              <button
                                onClick={() => handleRetry(r, rowKey)}
                                className="text-xs text-blue-600 underline self-start"
                              >
                                Try again
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleRetry(r, rowKey)}
                              className="bg-[#1F3864] text-white rounded px-2.5 py-1 text-xs hover:opacity-90"
                            >
                              Retry
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
