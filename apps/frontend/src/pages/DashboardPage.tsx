import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  CheckCircle2,
  Mail,
  MessageSquare,
  Reply,
  Send,
  Users,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  Skeleton,
  statusTone,
} from '../components/ui';

interface DashboardResponse {
  globalPaused: boolean;
  testMode: boolean;
  summary: {
    connectedAccounts: number;
    totalAccounts: number;
    totalLeads: number;
    emailsSentToday: number;
    emailsRemainingToday: number;
    confirmedDeliveries: number;
    bounces: number;
    replies: number;
    activeCampaigns: number;
  };
  accountProgress: Array<{
    id: string;
    email: string;
    connectionStatus: string;
    isPaused: boolean;
    dailySendLimit: number;
    sentToday: number;
    remainingToday: number;
  }>;
  campaignPerformance: Array<{
    id: string;
    name: string;
    status: string;
    accountEmail: string;
    sent: number;
    delivered: number;
    replies: number;
    bounces: number;
  }>;
  activitySeries: Array<{
    date: string;
    sent: number;
    delivered: number;
    opens: number;
    clicks: number;
    replies: number;
    bounces: number;
  }>;
  recentEmails: Array<{
    id: string;
    recipientEmail: string;
    subject: string;
    status: string;
    deliveryStatus: string;
    sentAt: string | null;
    outlookAccount: { email: string };
    campaign: { name: string } | null;
  }>;
  recentReplies: Array<{
    id: string;
    senderEmail: string;
    senderName: string | null;
    subject: string;
    receivedAt: string;
    outlookAccount: { email: string };
    matchedCampaign: { name: string } | null;
  }>;
  recentErrors: Array<{
    id: string;
    recipientEmail: string;
    errorMessage: string | null;
    updatedAt: string;
    outlookAccount: { email: string };
  }>;
  whatsapp: {
    connectionStatus: string;
    linkedPhoneNumber: string | null;
    recipientPhoneNumber: string | null;
    recentNotifications: Array<{
      id: string;
      eventType: string;
      status: string;
      recipientPhone: string;
      createdAt: string;
    }>;
  };
}

export function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiRequest<DashboardResponse>('/api/dashboard'),
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return <Alert tone="danger">Failed to load dashboard metrics: {(error as Error)?.message}</Alert>;
  }

  const kpis = [
    { label: 'Connected Accounts', value: `${data.summary.connectedAccounts} / ${data.summary.totalAccounts}`, icon: Mail },
    { label: 'Total Leads', value: data.summary.totalLeads, icon: Users },
    { label: 'Emails Sent Today', value: data.summary.emailsSentToday, icon: Send },
    { label: 'Remaining Today', value: data.summary.emailsRemainingToday, icon: Send },
    { label: 'Confirmed Deliveries', value: data.summary.confirmedDeliveries, icon: CheckCircle2 },
    { label: 'Bounces', value: data.summary.bounces, icon: AlertTriangle },
    { label: 'Replies', value: data.summary.replies, icon: Reply },
    { label: 'Active Campaigns', value: data.summary.activeCampaigns, icon: MessageSquare },
  ];

  return (
    <div className="space-y-6">
      {data.globalPaused && (
        <Alert tone="warning" title="Global sending is currently paused">
          No automated emails are being sent until you resume sending from the top bar or Settings.
        </Alert>
      )}
      {data.testMode && (
        <Alert tone="info" title="Test Mode is active">
          Campaign sends are routed strictly to your configured verified test email address.
        </Alert>
      )}

      {/* KPI Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <Card key={kpi.label}>
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-xs font-medium text-slate-500">{kpi.label}</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{kpi.value}</p>
                </div>
                <div className="rounded-lg bg-slate-100 p-2.5 text-slate-600">
                  <Icon className="h-5 w-5" />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Activity Chart & Account Daily Progress */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Email Activity (Last 14 Days)"
            description="Sent messages, confirmed deliveries, opens, and replies"
          />
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.activitySeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} tickFormatter={(v) => String(v).slice(5)} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} allowDecimals={false} />
                <Tooltip />
                <Area type="monotone" dataKey="sent" name="Sent" stroke="#4f46e5" fill="#e0e7ff" strokeWidth={2} />
                <Area type="monotone" dataKey="opens" name="Opens (Est.)" stroke="#0284c7" fill="#e0f2fe" strokeWidth={2} />
                <Area type="monotone" dataKey="replies" name="Replies" stroke="#059669" fill="#d1fae5" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Account Sending Progress"
            description="Daily quota utilization per Outlook account"
            action={
              <Link to="/accounts" className="text-xs font-medium text-indigo-600 hover:underline">
                Manage
              </Link>
            }
          />
          <CardContent className="space-y-4">
            {data.accountProgress.length === 0 ? (
              <p className="text-xs text-slate-500">No Outlook accounts connected yet.</p>
            ) : (
              data.accountProgress.map((acc) => {
                const pct = acc.dailySendLimit > 0 ? Math.min(100, Math.round((acc.sentToday / acc.dailySendLimit) * 100)) : 0;
                return (
                  <div key={acc.id} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate font-medium text-slate-800">{acc.email}</span>
                      <Badge tone={statusTone(acc.isPaused ? 'PAUSED' : acc.connectionStatus)}>
                        {acc.isPaused ? 'Paused' : acc.connectionStatus}
                      </Badge>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex justify-between text-[11px] text-slate-500">
                      <span>{acc.sentToday} sent today</span>
                      <span>{acc.remainingToday} remaining / {acc.dailySendLimit}</span>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>

      {/* Campaign Performance & WhatsApp Status */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Campaign Performance"
            action={
              <Link to="/campaigns" className="text-xs font-medium text-indigo-600 hover:underline">
                View all
              </Link>
            }
          />
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-100 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Campaign</th>
                    <th className="px-4 py-2.5 font-medium">Account</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">Sent</th>
                    <th className="px-4 py-2.5 text-right font-medium">Confirmed</th>
                    <th className="px-4 py-2.5 text-right font-medium">Replies</th>
                    <th className="px-4 py-2.5 text-right font-medium">Bounces</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.campaignPerformance.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                        No campaigns created yet.
                      </td>
                    </tr>
                  ) : (
                    data.campaignPerformance.map((c) => (
                      <tr key={c.id} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-medium text-slate-900">{c.name}</td>
                        <td className="px-4 py-2.5 text-slate-600">{c.accountEmail}</td>
                        <td className="px-4 py-2.5">
                          <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-right">{c.sent}</td>
                        <td className="px-4 py-2.5 text-right">{c.delivered}</td>
                        <td className="px-4 py-2.5 text-right">{c.replies}</td>
                        <td className="px-4 py-2.5 text-right">{c.bounces}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="WhatsApp Alerts"
            action={
              <Link to="/whatsapp" className="text-xs font-medium text-indigo-600 hover:underline">
                Configure
              </Link>
            }
          />
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <div>
                <p className="text-xs font-medium text-slate-700">Connection Status</p>
                <p className="text-[11px] text-slate-500">
                  {data.whatsapp.linkedPhoneNumber || 'No device linked'}
                </p>
              </div>
              <Badge tone={statusTone(data.whatsapp.connectionStatus)}>
                {data.whatsapp.connectionStatus}
              </Badge>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-700">Recent Notifications</p>
              {data.whatsapp.recentNotifications.length === 0 ? (
                <p className="text-xs text-slate-500">No WhatsApp notifications queued yet.</p>
              ) : (
                data.whatsapp.recentNotifications.slice(0, 5).map((n) => (
                  <div key={n.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-xs">
                    <div>
                      <p className="font-medium text-slate-800">{n.eventType}</p>
                      <p className="text-[11px] text-slate-500">{n.recipientPhone}</p>
                    </div>
                    <Badge tone={statusTone(n.status)}>{n.status}</Badge>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity, Replies, Errors */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Recent Email Activity" />
          <CardContent className="space-y-2.5">
            {data.recentEmails.length === 0 ? (
              <p className="text-xs text-slate-500">No email activity yet.</p>
            ) : (
              data.recentEmails.slice(0, 6).map((m) => (
                <div key={m.id} className="flex items-start justify-between gap-2 border-b border-slate-100 pb-2 text-xs last:border-0">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900">{m.recipientEmail}</p>
                    <p className="truncate text-[11px] text-slate-500">{m.subject}</p>
                  </div>
                  <Badge tone={statusTone(m.status)}>{m.status}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Recent Campaign Replies" />
          <CardContent className="space-y-2.5">
            {data.recentReplies.length === 0 ? (
              <p className="text-xs text-slate-500">No replies detected yet.</p>
            ) : (
              data.recentReplies.map((r) => (
                <div key={r.id} className="border-b border-slate-100 pb-2 text-xs last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium text-slate-900">{r.senderName || r.senderEmail}</p>
                    <span className="text-[11px] text-slate-400">
                      {new Date(r.receivedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-slate-600">{r.subject}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Recent Sending Errors" />
          <CardContent className="space-y-2.5">
            {data.recentErrors.length === 0 ? (
              <p className="text-xs text-slate-500">No recent errors.</p>
            ) : (
              data.recentErrors.map((e) => (
                <div key={e.id} className="border-b border-slate-100 pb-2 text-xs last:border-0">
                  <p className="truncate font-medium text-rose-700">{e.recipientEmail}</p>
                  <p className="line-clamp-2 text-[11px] text-slate-500">{e.errorMessage}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
