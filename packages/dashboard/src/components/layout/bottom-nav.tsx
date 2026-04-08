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

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/bots', label: 'Bots', icon: Hexagon },
  { to: '/settings', label: 'Settings', icon: Settings },
];

// Mobile bottom nav (visible <md). 4 items, ≤5 limit per design doc §7.1.
// Touch targets are 56px tall to satisfy the 44pt minimum + safe area.
export function BottomNav() {
  return (
    <nav
      aria-label="Mobile navigation"
      className={cn(
        'md:hidden flex',
        'fixed bottom-0 inset-x-0 h-14 z-40',
        'bg-bg-surface border-t border-border-subtle',
        'pb-[env(safe-area-inset-bottom)]'
      )}
    >
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'flex-1 flex flex-col items-center justify-center gap-0.5',
              'text-2xs font-medium',
              isActive ? 'text-primary' : 'text-text-muted'
            )
          }
        >
          <item.icon className="size-5" aria-hidden="true" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
