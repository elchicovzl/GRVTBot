import { NavLink } from 'react-router-dom';
import { Hexagon, LayoutGrid, Settings } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { LucideIcon } from 'lucide-react';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

// History tab removed: there is no cross-bot activity view yet — bot detail
// already exposes the per-bot Fills/Snapshots tables. Will reintroduce when
// there's a real global timeline to show.
const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/bots', label: 'Bots', icon: Hexagon },
  { to: '/settings', label: 'Settings', icon: Settings },
];

// Desktop sidebar (hidden on mobile — see BottomNav).
// 224px fixed width per wireframe §7.1.
export function Sidebar() {
  return (
    <aside
      className={cn(
        'hidden md:flex flex-col',
        'w-56 shrink-0 bg-bg-surface border-r border-border-subtle',
        'pt-4 pb-4'
      )}
    >
      <nav aria-label="Main navigation" className="flex-1 px-2 flex flex-col gap-1">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 h-9',
                'text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary-soft text-primary'
                  : 'text-text-secondary hover:bg-bg-muted hover:text-text-primary'
              )
            }
          >
            <item.icon className="size-4" aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="px-3 pt-3 mt-2 border-t border-border-subtle">
        <span className="text-2xs uppercase tracking-wider text-text-disabled">
          v0.1.0 · B.5
        </span>
      </div>
    </aside>
  );
}
