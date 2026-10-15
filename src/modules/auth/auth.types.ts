export const USER_ROLES = ['SUPER_ADMIN', 'FOUNDER', 'HR', 'EMPLOYEE'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = 'active' | 'inactive';

/** Canonical user DTO returned by login, /auth/me and user management. */
export interface IUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  empCode?: string;
  status: UserStatus;
  createdAt?: Date;
}

export interface AuthResponse {
  token: string;
  user: IUser;
}

export interface CreateUserInput {
  email: string;
  name?: string;
  password: string;
  role: 'FOUNDER' | 'HR' | 'EMPLOYEE';
  empCode?: string;
}

