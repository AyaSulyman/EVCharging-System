import { requireAdmin, requireAuth, AuthError } from "@/middleware/auth";
import { json, serialize } from "@/utils/response";
import { listUsers, getUserById, updateUser, deleteUser } from "@/services/user.service";

export async function handleListUsers(req: Request) {
  try {
    requireAdmin(req);
    const users = await listUsers();
    return json({ users: serialize(users) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to list users" }, { status: 500 });
  }
}


export async function handleUpdateUser(req: Request) {
  try {
    const auth = requireAuth(req);
    const { id, ...updates } = await req.json();
    const targetId = id || auth.id;

    if (targetId !== auth.id && auth.role !== "admin") {
      return json({ error: "Forbidden" }, { status: 403 });
    }
    if (updates.role && auth.role !== "admin") delete updates.role;

    const user = await updateUser(targetId, updates);
    if (!user) return json({ error: "User not found" }, { status: 404 });
    return json({ user: serialize(user) });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to update user" }, { status: 500 });
  }
}


export async function handleDeleteUser(req: Request) {
  try {
    requireAdmin(req);
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return json({ error: "Missing id" }, { status: 400 });
    await deleteUser(id);
    return json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Failed to delete user" }, { status: 500 });
  }
}

export { getUserById };
