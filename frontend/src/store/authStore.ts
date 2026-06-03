import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Role hierarchy ────────────────────────────────────────────────────────────
// viewer  → browse servers & schemas only
// analyst → call tools + view own logs
// admin   → everything + /admin routes

export type UserRole = 'admin' | 'analyst' | 'viewer';

export interface User {
  id: string;
  email: string;
  role: UserRole;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
}

// Role permission helpers
export const ROLE_CAN_CALL_TOOLS: UserRole[] = ['admin', 'analyst'];
export const ROLE_CAN_ACCESS_ADMIN: UserRole[] = ['admin'];

export function canCallTools(role: UserRole | undefined): boolean {
  return ROLE_CAN_CALL_TOOLS.includes(role as UserRole);
}
export function canAccessAdmin(role: UserRole | undefined): boolean {
  return ROLE_CAN_ACCESS_ADMIN.includes(role as UserRole);
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface AuthState {
  token: string | null;
  user: User | null;
  tenant: Tenant | null;
  setAuth: (token: string, user: User, tenant: Tenant) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      tenant: null,
      setAuth: (token, user, tenant) => set({ token, user, tenant }),
      logout: () => set({ token: null, user: null, tenant: null }),
    }),
    {
      name: 'mcp-gateway-auth',
    },
  ),
);
