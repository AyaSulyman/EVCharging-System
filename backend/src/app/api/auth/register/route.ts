import { registerUser } from "@/services/auth.service";
import { json, preflight, serialize } from "@/utils/response";

export const OPTIONS = preflight;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, email, password, phone } = body;

    if (!name || !email || !password) {
      return json({ error: "name, email and password are required" }, { status: 400 });
    }
    if (password.length < 8) {
      return json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const { token, user } = await registerUser({ name, email, password, phone });

    return json(
      {
        token,
        user: serialize({
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
        }),
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof Error && err.message === "EMAIL_IN_USE") {
      return json({ error: "An account with this email already exists" }, { status: 409 });
    }
    console.error(err);
    return json({ error: "Registration failed" }, { status: 500 });
  }
}
