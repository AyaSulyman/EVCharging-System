import { loginUser } from "@/services/auth.service";
import { json, preflight, serialize } from "@/utils/response";

export const OPTIONS = preflight;

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return json({ error: "email and password are required" }, { status: 400 });
    }

    const { token, user } = await loginUser(email, password);

    return json({
      token,
      user: serialize({
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INVALID_CREDENTIALS") {
      return json({ error: "Invalid email or password" }, { status: 401 });
    }
    console.error(err);
    return json({ error: "Login failed" }, { status: 500 });
  }
}
