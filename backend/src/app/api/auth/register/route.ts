import { registerUser } from "@/services/auth.service";
import { parseBody, registerSchema } from "@/validation";
import { errorResponse, json, preflight, serialize } from "@/utils/response";

export const OPTIONS = preflight;

export async function POST(req: Request) {
  try {
    const { name, email, password, phone } = parseBody(registerSchema, await req.json());

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
    return errorResponse(err, "Registration failed", {
      EMAIL_IN_USE: { status: 409, error: "An account with this email already exists" },
    });
  }
}
