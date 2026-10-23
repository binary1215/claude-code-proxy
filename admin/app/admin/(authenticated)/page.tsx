import { fetchStats, fetchTasks, type TokenAggregate } from "@/lib/api";
import { formatAggregateTokens, formatCost, USAGE_AGGREGATION_NOTICE } from "@/lib/usage";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [stats, tasksData] = await Promise.all([
    fetchStats({ from: new Date().toISOString().slice(0, 10) }),
    fetchTasks(),
  ]);
  const totalTokens = formatAggregateTokens(stats.usage.total_tokens);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>
      <p className="text-sm text-gray-500 mb-4">Today, from 00:00 UTC. Counts include successful, failed, cancelled and pending requests.</p>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Active Tasks"
          value={tasksData.tasks.length}
          color="blue"
        />
        <StatCard
          label="Requests Today"
          value={stats.total_requests}
          color="gray"
        />
        <StatCard
          label="Tokens Today (incl. cache)"
          value={totalTokens.value}
          detail={totalTokens.detail}
          color="purple"
        />
        <StatCard
          label="Cost Today"
          value={formatCost(stats.total_cost_usd)}
          color="green"
        />
      </div>

      <div className="bg-white rounded-xl shadow p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">Provider Token Usage</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
          {([
            ["Fresh input", stats.usage.fresh_input],
            ["Cache write", stats.usage.cache_write],
            ["Cache read", stats.usage.cache_read],
            ["Total input (incl. cache)", stats.usage.total_input],
            ["Output", stats.usage.output],
          ] as const).map(([label, metric]) => (
            <div key={label}>
              <p className="text-sm text-gray-500 mb-1">{label}</p>
              <AggregateValue metric={metric} />
            </div>
          ))}
        </div>
        <p className="text-sm font-medium mb-2">
          Coverage: {stats.usage.complete_requests} complete / {stats.usage.partial_requests} partial / {stats.usage.unknown_requests} unknown requests
        </p>
        <p className="text-xs text-gray-500">{USAGE_AGGREGATION_NOTICE}</p>
      </div>

      {stats.by_model.length > 0 && (
        <div className="bg-white rounded-xl shadow p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">Usage by Model</h3>
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1000px]">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="pb-2">Model</th>
                <th className="pb-2">Requests</th>
                <th className="pb-2">Fresh input</th>
                <th className="pb-2">Cache write</th>
                <th className="pb-2">Cache read</th>
                <th className="pb-2">Output</th>
                <th className="pb-2">Total input</th>
                <th className="pb-2">Coverage<br /><span className="font-normal text-xs">complete / partial / unknown</span></th>
                <th className="pb-2">Cost</th>
              </tr>
            </thead>
            <tbody>
              {stats.by_model.map((m) => (
                <tr key={m.model} className="border-b last:border-0">
                  <td className="py-2 font-mono text-xs">{m.model}</td>
                  <td className="py-2">{m.count}</td>
                  <td className="py-2 pr-3"><AggregateValue metric={m.usage.fresh_input} /></td>
                  <td className="py-2 pr-3"><AggregateValue metric={m.usage.cache_write} /></td>
                  <td className="py-2 pr-3"><AggregateValue metric={m.usage.cache_read} /></td>
                  <td className="py-2 pr-3"><AggregateValue metric={m.usage.output} /></td>
                  <td className="py-2 pr-3"><AggregateValue metric={m.usage.total_input} /></td>
                  <td className="py-2 pr-3">{m.usage.complete_requests} / {m.usage.partial_requests} / {m.usage.unknown_requests}</td>
                  <td className="py-2">{formatCost(m.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {stats.by_status.length > 0 && (
        <div className="bg-white rounded-xl shadow p-6">
          <h3 className="text-lg font-semibold mb-4">Requests by Status</h3>
          <div className="flex gap-4">
            {stats.by_status.map((s) => (
              <div
                key={s.status}
                className="flex items-center gap-2 px-3 py-1 rounded-full bg-gray-100 text-sm"
              >
                <StatusDot status={s.status} />
                <span className="capitalize">{s.status}</span>
                <span className="font-semibold">{s.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  detail,
}: {
  label: string;
  value: string | number;
  color: string;
  detail?: string | null;
}) {
  const colorMap: Record<string, string> = {
    blue: "border-blue-500",
    gray: "border-gray-500",
    purple: "border-purple-500",
    green: "border-green-500",
  };

  return (
    <div
      className={`bg-white rounded-xl shadow p-6 border-l-4 ${colorMap[color] || "border-gray-500"}`}
    >
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {detail && <p className="text-xs text-gray-500 mt-2">{detail}</p>}
    </div>
  );
}

function AggregateValue({ metric }: { metric: TokenAggregate }) {
  const formatted = formatAggregateTokens(metric);
  return (
    <div>
      <span className="font-medium">{formatted.value}</span>
      {formatted.detail && <p className="text-xs text-gray-500 mt-1 max-w-56">{formatted.detail}</p>}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    success: "bg-green-500",
    error: "bg-red-500",
    pending: "bg-yellow-500",
    cancelled: "bg-gray-500",
  };

  return (
    <span
      className={`w-2 h-2 rounded-full ${colorMap[status] || "bg-gray-400"}`}
    />
  );
}
