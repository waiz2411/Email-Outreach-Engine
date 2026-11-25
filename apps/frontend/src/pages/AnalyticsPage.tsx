import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiRequest } from '../lib/api';
import { Alert, Card, CardContent, CardHeader, Input, Select, Skeleton } from '../components/ui';
import type { OutlookAccountDto } from './OutlookAccountsPage';

interface AnalyticsResponse {
  metrics: {
    totalQueued: number;
    totalSent: number;
    totalConfirmedDeliveries: number;
    totalDeliveryUnknown: number;
    totalBounces: number;
    totalHardBounces: number;
    totalSoftBounces: number;
    totalOpens: number;
    totalUniqueOpens: number;
    totalClicks: number;
    totalUniqueClicks: number;
    totalReplies: number;
    totalFailures: number;
    totalUnsubscribes: number;
    confirmedDeliveryRate: number;
    bounceRate: number;
    openRateEstimate: number;
    clickRateEstimate: number;
    replyRate: number;
  };
  methodology: {
    confirmedMetrics: string[];
    estimatedMetrics: string[];
  };
}

export function AnalyticsPage() {
  const [searchParams] = useSearchParams();
  const [accountId, setAccountId] = useState(searchParams.get('accountId') || '');
  const [campaignId, setCampaignId] = useState(searchParams.get('campaignId') || '');
  const [status, setStatus] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => apiRequest<{ accounts: OutlookAccountDto[] }>('/api/accounts'),
  });

  const { data: campaignsData } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => apiRequest<{ campaigns: Array<{ id: string; name: string }> }>('/api/campaigns'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['analytics', accountId, campaignId, status, fromDate, toDate],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (accountId) qs.set('outlookAccountId', accountId);
      if (campaignId) qs.set('campaignId', campaignId);
      if (status) qs.set('status', status);
      if (fromDate) qs.set('from', new Date(`${fromDate}T00:00:00Z`).toISOString());
      if (toDate) qs.set('to', new Date(`${toDate}T23:59:59Z`).toISOString());
      return apiRequest<AnalyticsResponse>(`/api/analytics?${qs.toString()}`);
    },
  });

  const m = data?.metrics;

  const chartData = m
    ? [
        { name: 'Queued', count: m.totalQueued },
        { name: 'Sent', count: m.totalSent },
        { name: 'Confirmed Deliv.', count: m.totalConfirmedDeliveries },
        { name: 'Delivery Unknown', count: m.totalDeliveryUnknown },
        { name: 'Bounces', count: m.totalBounces },
        { name: 'Unique Opens', count: m.totalUniqueOpens },
        { name: 'Unique Clicks', count: m.totalUniqueClicks },
        { name: 'Replies', count: m.totalReplies },
        { name: 'Failures', count: m.totalFailures },
      ]
    : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Analytics Filters" />
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">All Outlook Accounts</option>
              {(accountsData?.accounts || []).map((a) => (
                <option key={a.id} value={a.id}>{a.email}</option>
              ))}
            </Select>
            <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">All Campaigns</option>
              {(campaignsData?.campaigns || []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All Statuses</option>
              {['SENT', 'DELIVERED', 'BOUNCED', 'OPENED', 'CLICKED', 'REPLIED', 'FAILED'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="From date" />
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="To date" />
          </div>
        </CardContent>
      </Card>

      {isLoading || !m ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { label: 'Total Queued', value: m.totalQueued },
              { label: 'Total Sent', value: m.totalSent },
              { label: 'Confirmed Deliveries', value: `${m.totalConfirmedDeliveries} (${m.confirmedDeliveryRate}%)` },
              { label: 'Delivery Unknown', value: m.totalDeliveryUnknown },
              { label: 'Total Bounces', value: `${m.totalBounces} (${m.bounceRate}%)` },
              { label: 'Hard / Soft Bounces', value: `${m.totalHardBounces} / ${m.totalSoftBounces}` },
              { label: 'Opens / Unique (Est.)', value: `${m.totalOpens} / ${m.totalUniqueOpens} (${m.openRateEstimate}%)` },
              { label: 'Clicks / Unique (Est.)', value: `${m.totalClicks} / ${m.totalUniqueClicks} (${m.clickRateEstimate}%)` },
              { label: 'Replies (Confirmed)', value: `${m.totalReplies} (${m.replyRate}%)` },
              { label: 'Failures / Unsubscribes', value: `${m.totalFailures} / ${m.totalUnsubscribes}` },
            ].map((item) => (
              <Card key={item.label}>
                <CardContent className="p-4">
                  <p className="text-[11px] font-medium text-slate-500">{item.label}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{item.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader title="Outreach Funnel & Outcome Breakdown" />
            <CardContent className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#4f46e5" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Alert tone="success" title="Provider-Confirmed Metrics">
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {data.methodology.confirmedMetrics.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Alert>
            <Alert tone="warning" title="Estimated / Heuristic Metrics (Do not treat opens as proof of human reading)">
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {data.methodology.estimatedMetrics.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Alert>
          </div>
        </>
      )}
    </div>
  );
}
