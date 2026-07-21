import { preflight } from "@/utils/response";
import {
  handleListUsers,
  handleUpdateUser,
  handleDeleteUser,
} from "@/controllers/user.controller";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export const GET = handleListUsers;
export const PATCH = handleUpdateUser;
export const DELETE = handleDeleteUser;
