import { useEffect, useMemo, useState, useCallback } from "react";
import Papa from "papaparse";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";

const CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vS0I-yVy4ae2MvmSq44r2kFJNc-5lpcX4395tXu9hzplrgfVJ2U5CvC1FS0NAXQtM56w7I8tAnKjZIL/pub?gid=0&single=true&output=csv";

const PIE_COLORS = ["#1F3864", "#3B82F6", "#22C55E", "#F59E0B", "#EF4444", "#8B5CF6"];

const yesNo = (v) => String(v ?? "").trim().toLowerCase() === "yes";
const fmtPct = (n) => (Number.isFinite(n) ? n.toFixed(1) : "0.0") + "%";
const fmtNum = (n) => Number(n || 0).toLocaleString("en-IN");
const datePart = (s) => (typeof s === "string" ? s.slice(0, 10) : "");

function computeMetrics(rows) {
  const totalCalls = rows.length;
  const answered = rows.filter((r) => yesNo(r.call_answered));
  const engaged = rows.filter((r) => yesNo(r.call_engaged));
  const unanswered = totalCalls - answered.length;
  const jobsShownRows = rows.filter((r) => yesNo(r.jobs_shown));

  const byPhone = new Map();
  for (const r of rows) {
    const p = r.phone;
    if (!p) continue;
    if (!byPhone.has(p)) byPhone.set(p, []);
    byPhone.get(p).push(r);
  }

  let seekersApplied = 0;
  let seekersAnswered = 0;
  let seekersNotApplied = 0;
  for (const [, list] of byPhone) {
    const anyAnswered = list.some((r) => yesNo(r.call_answered));
    const anyApplied = list.some((r) => yesNo(r.applied_to_job));
    if (anyAnswered) seekersAnswered += 1;
    if (anyApplied) seekersApplied += 1;
    if (anyAnswered && !anyApplied) seekersNotApplied += 1;
  }

  const totalApplications = rows.reduce(
    (sum, r) => sum + (parseInt(r.applications_count, 10) || 0),
    0
  );

  const avgDurationAnswered =
    answered.length > 0
      ? answered.reduce(
          (s, r) => s + (parseFloat(r.call_duration_seconds) || 0),
          0
        ) / answered.length
      : 0;

  const topicBreakdown = {};
  for (const r of rows) {
    const t = r.primary_topic || "Unknown";
    topicBreakdown[t] = (topicBreakdown[t] || 0) + 1;
  }

  const languageBreakdown = {};
  for (const r of rows) {
    const l = r.call_language || "Unknown";
    languageBreakdown[l] = (languageBreakdown[l] || 0) + 1;
  }

  const callsByDayMap = {};
  for (const r of rows) {
    const d = datePart(r.call_datetime_ist);
    if (!d) continue;
    callsByDayMap[d] = (callsByDayMap[d] || 0) + 1;
  }
  const callsByDay = Object.entries(callsByDayMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));

  return {
    totalJobSeekersCalled: byPhone.size,
    totalJobSeekersAnswered: seekersAnswered,
    seekersApplied,
    seekersNotApplied,
    totalApplications,
    applicationRate:
      seekersAnswered > 0 ? (seekersApplied / seekersAnswered) * 100 : 0,
    totalCalls,
    answeredCalls: answered.length,
    unansweredCalls: unanswered,
    engagedCalls: engaged.length,
    callsWithJobsShown: jobsShownRows.length,
    pickupRate: totalCalls > 0 ? (answered.length / totalCalls) * 100 : 0,
    engagementRate: totalCalls > 0 ? (engaged.length / totalCalls) * 100 : 0,
    jobsShownRate:
      totalCalls > 0 ? (jobsShownRows.length / totalCalls) * 100 : 0,
    avgDurationAnswered,
    topicBreakdown,
    languageBreakdown,
    callsByDay,
  };
}

function Card({ title, value, subtext, borderColor }) {
  return (
    <div
      className="bg-[#F8F9FA] rounded-lg p-4 shadow-sm flex flex-col justify-between min-h-[120px]"
      style={borderColor ? { borderLeft: `4px solid ${borderColor}` } : {}}
    >
      <div className="text-sm font-medium text-gray-600">{title}</div>
      <div className="text-3xl font-semibold text-[#1F3864] mt-2">{value}</div>
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

export default function App() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [stateSel, setStateSel] = useState("all");

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(CSV_URL + "&t=" + Date.now())
      .then((r) => {
        if (!r.ok) throw new Error("Fetch failed: " + r.status);
        return r.text();
      })
      .then((text) => {
        const parsed = Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
        });
        setRows(parsed.data);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const dateFiltered = useMemo(() => {
    return rows.filter((r) => {
      const d = datePart(r.call_datetime_ist);
      if (!d) return false;
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    });
  }, [rows, startDate, endDate]);

  const datasets = useMemo(
    () => ({
      all: dateFiltered,
      UP: dateFiltered.filter((r) => r.call_language === "Hindi"),
      Karnataka: dateFiltered.filter((r) => r.call_language === "Kannada"),
    }),
    [dateFiltered]
  );

  const metrics = useMemo(
    () => computeMetrics(datasets[stateSel] || []),
    [datasets, stateSel]
  );

  const resetFilters = () => {
    setStartDate("");
    setEndDate("");
  };

  const stateLabel =
    stateSel === "all"
      ? "All States"
      : stateSel === "UP"
      ? "Uttar Pradesh"
      : "Karnataka";

  const dateRangeLabel =
    !startDate && !endDate
      ? "All dates"
      : `${startDate || "…"} → ${endDate || "…"}`;

  const topicData = Object.entries(metrics.topicBreakdown).map(
    ([name, value]) => ({ name, value })
  );

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <h1 className="text-2xl font-semibold text-[#1F3864]">
            Kaam Ki Baat — Analytics Dashboard
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Voice AI helping Indian workers find jobs
          </p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        <div className="bg-[#F8F9FA] rounded-lg p-4 mb-6 flex flex-wrap items-end gap-4">
          <div className="flex flex-col">
            <label className="text-xs text-gray-600 mb-1">From</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
            />
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-gray-600 mb-1">To</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
            />
          </div>
          <button
            onClick={resetFilters}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm bg-white hover:bg-gray-50"
          >
            Reset
          </button>

          <div className="flex items-center gap-1 ml-2">
            {[
              { k: "all", label: "All States" },
              { k: "UP", label: "Uttar Pradesh" },
              { k: "Karnataka", label: "Karnataka" },
            ].map((opt) => (
              <button
                key={opt.k}
                onClick={() => setStateSel(opt.k)}
                className={`px-3 py-1.5 text-sm rounded border ${
                  stateSel === opt.k
                    ? "bg-[#1F3864] text-white border-[#1F3864]"
                    : "bg-white border-gray-300 hover:bg-gray-50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            onClick={fetchData}
            className="ml-auto bg-[#1F3864] text-white rounded px-3 py-1.5 text-sm hover:opacity-90"
          >
            Refresh
          </button>

          <div className="w-full text-xs text-gray-600">
            Showing: {dateRangeLabel} | {stateLabel}
          </div>
        </div>

        {error && (
          <div className="border border-red-300 bg-red-50 rounded p-4 mb-6 flex items-center justify-between">
            <span className="text-sm text-red-700">
              Failed to load data: {error}
            </span>
            <button
              onClick={fetchData}
              className="bg-red-600 text-white rounded px-3 py-1.5 text-sm"
            >
              Retry
            </button>
          </div>
        )}

        <section className="mb-8">
          <h2 className="text-lg font-semibold text-[#1F3864] mb-3">
            Outcome Metrics
          </h2>
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <Card
                title="Job Seekers Called"
                value={fmtNum(metrics.totalJobSeekersCalled)}
                subtext="Unique phone numbers"
              />
              <Card
                title="Applied to a Job"
                value={fmtNum(metrics.seekersApplied)}
                subtext={`${fmtPct(metrics.applicationRate)} of seekers who answered`}
                borderColor="#22C55E"
              />
              <Card
                title="Did Not Apply"
                value={fmtNum(metrics.seekersNotApplied)}
                subtext="Answered but did not apply"
                borderColor="#EF4444"
              />
              <Card
                title="Total Applications"
                value={fmtNum(metrics.totalApplications)}
                subtext="Across all calls"
                borderColor="#3B82F6"
              />
              <Card
                title="Application Rate"
                value={fmtPct(metrics.applicationRate)}
                subtext="Seekers applied / seekers who answered"
                borderColor="#22C55E"
              />
            </div>
          )}
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-semibold text-[#1F3864] mb-3">
            Call Metrics
          </h2>
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <Card title="Total Calls" value={fmtNum(metrics.totalCalls)} />
              <Card
                title="Answered Calls"
                value={fmtNum(metrics.answeredCalls)}
                subtext={`${fmtPct(metrics.pickupRate)} pickup rate`}
                borderColor="#22C55E"
              />
              <Card
                title="Unanswered Calls"
                value={fmtNum(metrics.unansweredCalls)}
                borderColor="#EF4444"
              />
              <Card
                title="Productive Conversations"
                value={fmtPct(metrics.engagementRate)}
                subtext={`${fmtNum(metrics.engagedCalls)} calls — answered + duration > 30s`}
                borderColor="#F59E0B"
              />
              <Card
                title="Avg Call Duration"
                value={`${metrics.avgDurationAnswered.toFixed(1)} sec`}
                subtext="Answered calls only"
              />
            </div>
          )}
        </section>

        <section className="mb-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-[#F8F9FA] rounded-lg p-4">
              <h3 className="text-base font-semibold text-[#1F3864] mb-3">
                Calls by Day
              </h3>
              {loading ? (
                <div className="h-72 bg-gray-100 rounded animate-pulse" />
              ) : metrics.callsByDay.length === 0 ? (
                <div className="h-72 flex items-center justify-center text-sm text-gray-500">
                  No data
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={metrics.callsByDay}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Line
                      type="monotone"
                      dataKey="count"
                      stroke="#1F3864"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="bg-[#F8F9FA] rounded-lg p-4">
              <h3 className="text-base font-semibold text-[#1F3864] mb-3">
                Topics Discussed
              </h3>
              {loading ? (
                <div className="h-72 bg-gray-100 rounded animate-pulse" />
              ) : topicData.length === 0 ? (
                <div className="h-72 flex items-center justify-center text-sm text-gray-500">
                  No data
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={topicData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      label={(d) => `${d.name}: ${d.value}`}
                    >
                      {topicData.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
