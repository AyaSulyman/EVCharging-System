"use client";

import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const COLORS = ["#0E7A5F", "#F5A524", "#3B82F6", "#9CA3AF", "#A855F7"];

export function BookingsLineChart({
  data,
}: {
  data: { date: string; bookings: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E3EAE6" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "#5B6B64" }}
          tickLine={false}
          axisLine={{ stroke: "#E3EAE6" }}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#5B6B64" }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            borderRadius: 12,
            border: "1px solid #E3EAE6",
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="bookings"
          stroke="#0E7A5F"
          strokeWidth={2.5}
          dot={{ r: 3, fill: "#0E7A5F" }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function StatusPieChart({
  data,
}: {
  data: { name: string; value: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={90}
          paddingAngle={2}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            borderRadius: 12,
            border: "1px solid #E3EAE6",
            fontSize: 12,
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function UtilizationBarChart({
  data,
}: {
  data: { station: string; bookings: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E3EAE6" vertical={false} />
        <XAxis
          dataKey="station"
          tick={{ fontSize: 11, fill: "#5B6B64" }}
          tickLine={false}
          axisLine={{ stroke: "#E3EAE6" }}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#5B6B64" }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ fill: "#F5F8F6" }}
          contentStyle={{
            borderRadius: 12,
            border: "1px solid #E3EAE6",
            fontSize: 12,
          }}
        />
        <Bar dataKey="bookings" fill="#0E7A5F" radius={[6, 6, 0, 0]} maxBarSize={64} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ChartLegend({
  data,
}: {
  data: { name: string; value: number }[];
}) {
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-3">
      {data.map((d, i) => (
        <span key={d.name} className="flex items-center gap-1.5 text-xs text-ink-soft">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: COLORS[i % COLORS.length] }}
          />
          {d.name} ({d.value})
        </span>
      ))}
    </div>
  );
}
