import { loginUser } from "@/services/auth.service";
import { loginSchema, parseBody } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const OPTIONS = preflight;

export async function POST(req: Request) {
  try {
    const { email, password } = parseBody(loginSchema, await req.json());

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
    return errorResponse(err, "Login failed", {
      INVALID_CREDENTIALS: { status: 401, error: "Invalid email or password" },
    });
  }
}
