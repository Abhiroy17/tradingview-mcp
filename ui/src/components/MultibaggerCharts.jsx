import { useMemo } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ComposedChart, Area,
} from 'recharts';

const COLORS = {
  revenue: '#3b82f6',
  ebitda: '#8b5cf6',
  pat: '#22c55e',
  opm: '#f59e0b',
  npm: '#06b6d4',
  negative: '#ef4444',
};

function crFmt(v) {
  if (v == null) return '-';
  const cr = v / 1e7;
  if (Math.abs(cr) >= 1000) return `${(cr / 100).toFixed(0)}K Cr`;
  return `${cr.toFixed(0)} Cr`;
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="mb-chart-tooltip">
      <p className="mb-chart-tooltip-label">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? (Math.abs(p.value) > 1000 ? crFmt(p.value * 1e7) : p.value + (p.name.includes('%') ? '%' : '')) : p.value}
        </p>
      ))}
    </div>
  );
}

/**
 * Revenue & Profit Trend (quarterly bar + line combo)
 */
export function QuarterlyTrendChart({ data }) {
  const chartData = useMemo(() => {
    if (!data?.length) return [];
    return data
      .filter(q => q.revenue != null || q.netIncome != null)
      .map(q => ({
        quarter: q.quarterLabel || q.date?.slice(0, 7),
        Revenue: q.revenue ? Math.round(q.revenue / 1e7) : null,
        EBITDA: q.ebitda ? Math.round(q.ebitda / 1e7) : null,
        PAT: q.netIncome ? Math.round(q.netIncome / 1e7) : null,
        'OPM%': q.opm,
        'NPM%': q.npm,
      }));
  }, [data]);

  if (chartData.length < 2) return null;

  return (
    <div className="mb-chart-container">
      <h4 className="mb-chart-title">Quarterly Revenue & Profit (₹ Cr)</h4>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="quarter" stroke="#94a3b8" fontSize={11} />
          <YAxis yAxisId="left" stroke="#94a3b8" fontSize={11} />
          <YAxis yAxisId="right" orientation="right" stroke="#94a3b8" fontSize={11} unit="%" />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar yAxisId="left" dataKey="Revenue" fill={COLORS.revenue} radius={[3, 3, 0, 0]} opacity={0.8} />
          <Bar yAxisId="left" dataKey="EBITDA" fill={COLORS.ebitda} radius={[3, 3, 0, 0]} opacity={0.8} />
          <Bar yAxisId="left" dataKey="PAT" fill={COLORS.pat} radius={[3, 3, 0, 0]} opacity={0.8} />
          <Line yAxisId="right" type="monotone" dataKey="OPM%" stroke={COLORS.opm} strokeWidth={2} dot={{ r: 3 }} />
          <Line yAxisId="right" type="monotone" dataKey="NPM%" stroke={COLORS.npm} strokeWidth={2} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Annual Growth Trend (bar chart with growth percentages)
 */
export function AnnualGrowthChart({ data }) {
  const chartData = useMemo(() => {
    if (!data?.length) return [];
    return data
      .filter(a => a.revenueGrowth != null || a.netIncomeGrowth != null)
      .map(a => ({
        year: a.date?.slice(0, 4),
        'Rev Growth%': a.revenueGrowth,
        'NP Growth%': a.netIncomeGrowth,
        'EBITDA Growth%': a.ebitdaGrowth,
      }));
  }, [data]);

  if (chartData.length < 2) return null;

  return (
    <div className="mb-chart-container">
      <h4 className="mb-chart-title">Annual Growth Rates (%)</h4>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="year" stroke="#94a3b8" fontSize={11} />
          <YAxis stroke="#94a3b8" fontSize={11} unit="%" />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="Rev Growth%" fill={COLORS.revenue} radius={[3, 3, 0, 0]} />
          <Bar dataKey="NP Growth%" fill={COLORS.pat} radius={[3, 3, 0, 0]} />
          <Bar dataKey="EBITDA Growth%" fill={COLORS.ebitda} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Scoring Radar Chart — shows all 7 axes on a spider diagram
 */
export function ScoringRadarChart({ axes }) {
  const chartData = useMemo(() => {
    if (!axes) return [];
    return Object.entries(axes).map(([axis, score]) => ({
      axis: axis.charAt(0).toUpperCase() + axis.slice(1).replace(/([A-Z])/g, ' $1'),
      score,
      fullMark: 100,
    }));
  }, [axes]);

  if (chartData.length < 3) return null;

  return (
    <div className="mb-chart-container">
      <h4 className="mb-chart-title">Scoring Radar</h4>
      <ResponsiveContainer width="100%" height={280}>
        <RadarChart data={chartData} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid stroke="#334155" />
          <PolarAngleAxis dataKey="axis" stroke="#94a3b8" fontSize={10} />
          <PolarRadiusAxis angle={30} domain={[0, 100]} stroke="#475569" fontSize={9} />
          <Radar name="Score" dataKey="score" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.25} strokeWidth={2} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Margin Trend — OPM% and NPM% over quarters
 */
export function MarginTrendChart({ data }) {
  const chartData = useMemo(() => {
    if (!data?.length) return [];
    return data
      .filter(q => q.opm != null || q.npm != null)
      .map(q => ({
        quarter: q.quarterLabel || q.date?.slice(0, 7),
        'OPM%': q.opm,
        'NPM%': q.npm,
        'EBITDA%': q.ebitdaMargin,
      }));
  }, [data]);

  if (chartData.length < 2) return null;

  return (
    <div className="mb-chart-container">
      <h4 className="mb-chart-title">Margin Trend (%)</h4>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="quarter" stroke="#94a3b8" fontSize={11} />
          <YAxis stroke="#94a3b8" fontSize={11} unit="%" />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="OPM%" stroke={COLORS.opm} strokeWidth={2} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="NPM%" stroke={COLORS.npm} strokeWidth={2} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="EBITDA%" stroke={COLORS.ebitda} strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
