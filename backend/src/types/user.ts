export type UserRole = "admin" | "user";

export interface IUser {
  _id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  avatar?: string;
  createdAt: string;
}

export interface UpdateUserInput {
  name?: string;
  phone?: string;
  avatar?: string;
  role?: UserRole;
}
