export type UserRole = 'SUPER_ADMIN' | 'FOUNDER' | 'EMPLOYEE';

export interface IUser {
  _id?: string;
  email: string;
  name: string;
  role: UserRole;
  empCode?: string; // Present if role === 'EMPLOYEE'
  status: 'active' | 'inactive';
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    empCode?: string;
    status: 'active' | 'inactive';
  };
}

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  role: 'FOUNDER' | 'EMPLOYEE';
  empCode?: string;
}
