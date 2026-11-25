import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Send,
  Settings,
  ShieldBan,
  Users,
  X,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useAuth } from '../lib/authContext';
import { Badge, Button, Modal, cn } from './ui';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/accounts', label: 'Outlook Accounts', icon: Mail },
  { to: '/leads', label: 'Leads', icon: Users },
  { to: '/campaigns', label: 'Campaigns', icon: Send },
  { to: '/activity', label: 'Email Activity', icon: Activity },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/whatsapp', label: 'WhatsApp Notifications', icon: MessageSquare },
  { to: '/suppression', label: 'Suppression List', icon: ShieldBan },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Layout() {
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [confirmPauseModal, setConfirmPauseModal] = useState(false);
  const location = useLocation();
  const queryClient = useQueryClient();

  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () =>
      apiRequest<{
        settings: {
          globalPaused: boolean;
          testMode: boolean;
          testModeRecipientEmail: string | null;
        };
      }>('/api/settings'),
  });

  const globalPaused = settingsData?.settings?.globalPaused ?? false;
  const testMode = settingsData?.settings?.testMode ?? false;

  const pauseMutation = useMutation({
    mutationFn: (paused: boolean) =>
      apiRequest('/api/settings/global-pause', {
        method: 'POST',
        json: { paused },
      }),
    onSuccess: () => {
      setConfirmPauseModal(false);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const currentNav = NAV_ITEMS.find((n) =>
    n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to),
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Dark Navy Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-slate-950 text-slate-200 transition-transform duration-200 lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-slate-800 px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <Send className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Outreach Engine</p>
              <p className="text-[11px] text-slate-400">Personal Control Center</p>
            </div>
          </div>
          <button
            type="button"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-indigo-600/20 text-white ring-1 ring-indigo-500/40'
                      : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100',
                  )
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-800 p-4">
          <div className="mb-3 truncate text-xs text-slate-400">{user?.email}</div>
          <button
            type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main Light Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur-xs sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
              className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <h1 className="text-base font-semibold text-slate-900 sm:text-lg">
              {currentNav?.label || 'Outreach Engine'}
            </h1>
            {testMode && (
              <Badge tone="warning">Test Mode Active</Badge>
            )}
            {globalPaused && (
              <Badge tone="danger">Engine Paused</Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={globalPaused ? 'secondary' : 'outline'}
              onClick={() => setConfirmPauseModal(true)}
            >
              {globalPaused ? (
                <>
                  <PlayCircle className="h-4 w-4" />
                  <span>Resume Global Sending</span>
                </>
              ) : (
                <>
                  <PauseCircle className="h-4 w-4" />
                  <span>Global Pause</span>
                </>
              )}
            </Button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6">
          <div className="mx-auto max-w-7xl space-y-6">
            <Outlet />
          </div>
        </main>
      </div>

      <Modal
        open={confirmPauseModal}
        onClose={() => setConfirmPauseModal(false)}
        title={globalPaused ? 'Resume Global Sending?' : 'Pause All Outbound Sending?'}
        description={
          globalPaused
            ? 'Active campaigns whose Outlook accounts are connected and inside their sending windows will resume dispatching.'
            : 'Immediately halts all outbound email sending across every Outlook account and campaign until resumed.'
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmPauseModal(false)}>
            Cancel
          </Button>
          <Button
            variant={globalPaused ? 'secondary' : 'danger'}
            disabled={pauseMutation.isPending}
            onClick={() => pauseMutation.mutate(!globalPaused)}
          >
            {pauseMutation.isPending
              ? 'Updating...'
              : globalPaused
                ? 'Resume Sending'
                : 'Pause All Sending'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
